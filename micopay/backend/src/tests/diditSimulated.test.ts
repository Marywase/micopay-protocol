/**
 * KYC-1 · Didit simulado: recorrido completo por la ruta real.
 *
 * QUÉ PRUEBA ESTO, Y QUÉ NO. Importa entenderlo antes de leer los ✓.
 *
 * Levanta un Didit de mentira que firma sus entregas **con el mismo esquema
 * que nuestro verificador espera** (HMAC-SHA256 hex sobre el cuerpo crudo,
 * cabeceras `x-signature` y `x-timestamp` en segundos) y las envía por la ruta
 * real, con su parser de cuerpo crudo incluido. Eso ejercita de verdad todo lo
 * que está bajo nuestro control: verificación de firma, ventana anti-replay,
 * atadura a la sesión almacenada, monotonía, idempotencia y las transiciones.
 *
 * Lo que NO puede probar, por construcción: que esas suposiciones coincidan
 * con el contrato REAL de Didit. El simulador está hecho con las mismas
 * premisas que el verificador, así que no puede falsarlas. El 2026-10-16 se
 * cotejaron contra la documentación de webhooks de Didit (v3) y coinciden,
 * pero siguen sin probarse contra el sandbox real:
 *
 *   - que Didit firme con HMAC-SHA256 hex sobre el cuerpo crudo;
 *   - que las cabeceras se llamen `x-signature` y `x-timestamp`;
 *   - que el timestamp venga en segundos y no en milisegundos;
 *   - que los campos del cuerpo sean `session_id`, `status` y `decision`
 *     con un `warnings[].risk` por módulo;
 *   - que el vocabulario de estados sea el que asume `mapDiditStatus`
 *     ("Approved", "Declined", ... con mayúsculas exactas).
 *
 * Si cualquiera de esas difiere, esta suite seguirá en verde y producción
 * fallará. Por eso el issue pide una comprobación contra el sandbox real, y
 * por eso este archivo NO la sustituye: la complementa.
 */

import { strictEqual, ok } from "assert";
import { createHmac } from "crypto";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import db from "../db/schema.js";
import { kycRoutes } from "../routes/kyc.js";
import { AppError } from "../utils/errors.js";

const JWT_SECRET = "test-secret-kyc1-simulated";
const WEBHOOK_SECRET = "whsec_simulado_para_pruebas";

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

async function createApp() {
  const app = Fastify({ logger: false });
  app.register(fastifyJwt, { secret: JWT_SECRET });
  app.setErrorHandler((error: any, _request: any, reply: any) => {
    if (error instanceof AppError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.userMessage });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ code: "ERROR", message: error.message });
  });
  await app.register(kycRoutes);
  await app.ready();
  return app;
}

async function seedUser(level = 0): Promise<string> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, kyc_level)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`G${"N".repeat(47)}${suffix}`, `sim_${suffix}`, `h_sim_${suffix}`, level],
  );
  if (!row?.id) throw new Error("seed failed");
  return row.id;
}

async function seedSession(userId: string, requestedLevel: number): Promise<string> {
  seq++;
  const sessionId = `sim_sess_${RUN}_${seq}`;
  await db.execute(
    `INSERT INTO kyc_didit_sessions (session_id, user_id, requested_level, status)
     VALUES ($1, $2, $3, 'pending')`,
    [sessionId, userId, requestedLevel],
  );
  return sessionId;
}

/**
 * El Didit simulado. Construye una entrega firmada tal como esperamos
 * recibirla, y permite alterar cada pieza para los casos negativos.
 */
function buildDelivery(opts: {
  sessionId: string;
  status: string;
  secret?: string;
  timestampSec?: number;
  tamperBodyAfterSigning?: boolean;
}) {
  const body = JSON.stringify({
    session_id: opts.sessionId,
    status: opts.status,
    decision: {
      status: opts.status,
      id_verifications: [
        { status: opts.status, warnings: opts.status === "Declined" ? [{ risk: "DOCUMENT_UNREADABLE" }] : [] },
      ],
    },
    // Se manda a propósito: el handler ya NO debe creérselo.
    vendor_data: "00000000-0000-0000-0000-000000000000:2",
  });
  const timestamp = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", opts.secret ?? WEBHOOK_SECRET)
    .update(body)
    .digest("hex");

  return {
    payload: opts.tamperBodyAfterSigning ? body.replace('"status"', '"status_x"') : body,
    headers: {
      "content-type": "application/json",
      "x-signature": signature,
      "x-timestamp": timestamp,
    },
  };
}

async function deliver(app: any, opts: Parameters<typeof buildDelivery>[0]) {
  const { payload, headers } = buildDelivery(opts);
  return app.inject({ method: "POST", url: "/defi/kyc/webhook/didit", headers, payload });
}

async function levelOf(userId: string): Promise<number> {
  const row = await db.getOne<{ kyc_level: number }>("SELECT kyc_level FROM users WHERE id = $1", [userId]);
  return Number(row?.kyc_level ?? 0);
}

async function sessionStatusOf(sessionId: string): Promise<string | null> {
  const row = await db.getOne<{ status: string }>(
    "SELECT status FROM kyc_didit_sessions WHERE session_id = $1",
    [sessionId],
  );
  return row?.status ?? null;
}

// ── 1. Recorrido feliz ─────────────────────────────────────────────────────

async function testSignedApprovalRaisesTheLevel(app: any) {
  const user = await seedUser();
  const sessionId = await seedSession(user, 2);

  const res = await deliver(app, { sessionId, status: "Approved" });
  strictEqual(res.statusCode, 200, "una entrega bien firmada se acepta");
  strictEqual(await levelOf(user), 2, "y aplica el nivel de la sesión");
  strictEqual(await sessionStatusOf(sessionId), "approved");
  console.log("  ✓ entrega firmada correctamente: sube el nivel de la sesión");
}

// ── 2. Firma y ventana temporal ────────────────────────────────────────────

async function testWrongSecretIsRejected(app: any) {
  const user = await seedUser();
  const sessionId = await seedSession(user, 2);

  const res = await deliver(app, { sessionId, status: "Approved", secret: "otro_secreto" });
  strictEqual(res.statusCode, 401, "una firma con otro secreto se rechaza");
  strictEqual(await levelOf(user), 0, "y no toca el nivel");
  console.log("  ✓ firma con secreto equivocado: 401 y sin efecto");
}

async function testTamperedBodyIsRejected(app: any) {
  const user = await seedUser();
  const sessionId = await seedSession(user, 2);

  const res = await deliver(app, { sessionId, status: "Approved", tamperBodyAfterSigning: true });
  strictEqual(res.statusCode, 401, "alterar el cuerpo tras firmar invalida la firma");
  strictEqual(await levelOf(user), 0);
  console.log("  ✓ cuerpo alterado después de firmar: 401");
}

async function testStaleDeliveryIsRejected(app: any) {
  const user = await seedUser();
  const sessionId = await seedSession(user, 2);

  // Diez minutos atrás: fuera de la ventana de cinco.
  const stale = Math.floor(Date.now() / 1000) - 600;
  const res = await deliver(app, { sessionId, status: "Approved", timestampSec: stale });
  strictEqual(res.statusCode, 401, "una entrega vieja se rechaza (anti-replay)");
  strictEqual(await levelOf(user), 0);
  console.log("  ✓ entrega fuera de la ventana temporal: 401");
}

// ── 3. Lo que el payload NO decide ─────────────────────────────────────────

async function testVendorDataCannotChooseTheVictim(app: any) {
  const owner = await seedUser();
  const victim = await seedUser();
  const sessionId = await seedSession(owner, 1);

  // El cuerpo lleva `vendor_data` apuntando a otro usuario y nivel 2.
  const res = await deliver(app, { sessionId, status: "Approved" });

  strictEqual(res.statusCode, 200);
  strictEqual(await levelOf(owner), 1, "manda la sesión: usuario y nivel salen de ella");
  strictEqual(await levelOf(victim), 0, "el usuario nombrado en el payload no se toca");
  console.log("  ✓ `vendor_data` del cuerpo no elige a quién ni a qué nivel");
}

async function testUnknownSessionIsIgnored(app: any) {
  const res = await deliver(app, { sessionId: `no_existe_${RUN}`, status: "Approved" });
  // Se acepta el acuse para que el proveedor no reintente en bucle, pero no
  // muta nada.
  strictEqual(res.statusCode, 200, "se acusa recibo sin actuar");
  console.log("  ✓ sesión desconocida: acuse sin efecto");
}

// ── 4. Idempotencia y monotonía por la ruta real ───────────────────────────

async function testReplayIsIdempotent(app: any) {
  const user = await seedUser();
  const sessionId = await seedSession(user, 2);

  await deliver(app, { sessionId, status: "Approved" });
  const before = await db.getOne<{ kyc_level_verified_at: string | Date }>(
    "SELECT kyc_level_verified_at FROM users WHERE id = $1",
    [user],
  );
  await new Promise((r) => setTimeout(r, 25));
  const second = await deliver(app, { sessionId, status: "Approved" });
  const after = await db.getOne<{ kyc_level_verified_at: string | Date }>(
    "SELECT kyc_level_verified_at FROM users WHERE id = $1",
    [user],
  );

  strictEqual(second.statusCode, 200);
  strictEqual(
    new Date(after!.kyc_level_verified_at).toISOString(),
    new Date(before!.kyc_level_verified_at).toISOString(),
    "reenviar la misma entrega no refresca la vigencia",
  );
  console.log("  ✓ reenvío de la misma entrega: idempotente");
}

async function testLowerLevelCannotDowngrade(app: any) {
  const user = await seedUser(2);
  const sessionId = await seedSession(user, 1);

  await deliver(app, { sessionId, status: "Approved" });
  strictEqual(await levelOf(user), 2, "un nivel 1 aprobado no degrada un nivel 2");
  console.log("  ✓ aprobación de nivel inferior: no degrada");
}

async function testRejectionGrantsNothing(app: any) {
  const user = await seedUser();
  const sessionId = await seedSession(user, 2);

  const res = await deliver(app, { sessionId, status: "Declined" });
  strictEqual(res.statusCode, 200);
  strictEqual(await levelOf(user), 0, "un rechazo no otorga nivel");
  strictEqual(await sessionStatusOf(sessionId), "rejected", "y queda registrado");
  console.log("  ✓ rechazo: no otorga nivel y se registra");
}

async function main() {
  console.log("\n  KYC-1 · Didit simulado (NO sustituye al sandbox real):\n");
  const app = await createApp();
  process.env.DIDIT_WEBHOOK_SECRET = WEBHOOK_SECRET;

  try {
    await testSignedApprovalRaisesTheLevel(app);
    await testWrongSecretIsRejected(app);
    await testTamperedBodyIsRejected(app);
    await testStaleDeliveryIsRejected(app);
    await testVendorDataCannotChooseTheVictim(app);
    await testUnknownSessionIsIgnored(app);
    await testReplayIsIdempotent(app);
    await testLowerLevelCannotDowngrade(app);
    await testRejectionGrantsNothing(app);
  } finally {
    await app.close();
  }

  console.log(
    "\nAll KYC-1 simulated-Didit tests passed.\n" +
      "  Recordatorio: esto valida NUESTRA implementación, no el contrato real\n" +
      "  de Didit. El sandbox del mantenedor sigue pendiente.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
