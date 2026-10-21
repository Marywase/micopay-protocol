/**
 * Avisos de cambios en una operacion: a QUIEN van y que dicen.
 *
 * Antes solo se avisaba al agente de una operacion nueva. Si el agente
 * cancelaba, o el reembolso por vencimiento devolvia los fondos, el cliente no
 * se enteraba a menos que tuviera la pantalla de la operacion abierta.
 *
 * Corre con MOCK_STELLAR y la base en memoria. Firebase se sustituye por un
 * cliente falso que guarda cada mensaje: se prueba el destinatario y el texto,
 * no la entrega al telefono.
 */
import { strictEqual, ok, deepStrictEqual } from "assert";
import db from "../db/schema.js";
import { cancelTrade, refundTrade, sweepPendingRefunds } from "../services/trade.service.js";
import { buildTradeUpdateMessage, setMessagingForTests } from "../services/push.service.js";

const fakeRequest = {
  ip: "127.0.0.1",
  headers: {},
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as any;

type Sent = { token: string; title: string; body: string; data: Record<string, string> };
let sent: Sent[] = [];
setMessagingForTests({
  send: async (msg: any) => {
    sent.push({ token: msg.token, title: msg.notification.title, body: msg.notification.body, data: msg.data });
    return "fake-message-id";
  },
});

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

/**
 * `available: false` es el agente que ya pauso su disponibilidad: es la unica
 * forma en que un agente puede cancelar una operacion bloqueada.
 */
async function createUser(
  label: string,
  { withToken = true, available = true } = {},
): Promise<{ id: string; token: string | null }> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const token = withToken ? `tok_${label}_${suffix}` : null;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended, push_token)
     VALUES ($1, $2, $3, $4, $5, false, $6)
     RETURNING id`,
    [`G${"U".repeat(46)}${suffix}`, `upd_${label}_${suffix}`, `h_upd_${suffix}`, available, available ? "online" : "offline", token],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return { id: row.id, token };
}

/** Operacion de cash-out bloqueada: el cliente es el seller, el agente el buyer. */
async function insertLockedCashout(clientId: string, agentId: string, opts: { expired: boolean }): Promise<string> {
  const { encryptSecret, generateTradeSecret } = await import("../services/secret.service.js");
  const { secret, secretHash } = generateTradeSecret();
  const { encrypted, nonce } = encryptSecret(secret);
  const expiresAt = new Date(Date.now() + (opts.expired ? -60_000 : 2 * 60 * 60 * 1000)).toISOString();
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, flow, provider_id, amount_mxn, amount_stroops, platform_fee_mxn,
        secret_hash, secret_enc, secret_nonce, status, expires_at, lock_tx_hash, locked_at)
     VALUES ($1, $2, 'cashout', $3, $4, $5, $6, $7, $8, $9, 'locked', $10, $11, NOW())
     RETURNING id`,
    [clientId, agentId, agentId, 500, "5000000000", 4, secretHash, encrypted, nonce, expiresAt, `mock_lock_${RUN}_${seq}`],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return row.id;
}

/** Los avisos no se esperan; se deja correr la cola antes de mirar. */
async function settle() {
  await new Promise((r) => setTimeout(r, 30));
}

async function testAgentCancelTellsClientWhenFundsReturn() {
  const client = await createUser("cli");
  const agent = await createUser("agt", { available: false });
  const tradeId = await insertLockedCashout(client.id, agent.id, { expired: false });

  sent = [];
  await cancelTrade(fakeRequest, tradeId, agent.id);
  await settle();

  strictEqual(sent.length, 1, "un solo aviso");
  strictEqual(sent[0].token, client.token, "va al cliente, no al agente que cancelo");
  deepStrictEqual(sent[0].data, { type: "trade_update", kind: "cancelled", tradeId });
  ok(sent[0].body.includes("a partir de las"), `dice desde cuando regresan los fondos: ${sent[0].body}`);
  console.log("  ✓ si el agente cancela, el cliente sabe desde cuando regresan sus fondos");
}

async function testClientCancelTellsAgentWithoutRefundTime() {
  const client = await createUser("cli");
  const agent = await createUser("agt", { available: false });
  const tradeId = await insertLockedCashout(client.id, agent.id, { expired: false });

  sent = [];
  await cancelTrade(fakeRequest, tradeId, client.id);
  await settle();

  strictEqual(sent.length, 1);
  strictEqual(sent[0].token, agent.token, "va al agente");
  ok(!sent[0].body.includes("regresan"), "al agente no se le habla de fondos que no son suyos");
  console.log("  ✓ si el cliente cancela, el agente se entera");
}

async function testRefundTellsWhoLockedTheFunds() {
  const client = await createUser("cli");
  const agent = await createUser("agt", { available: false });
  const tradeId = await insertLockedCashout(client.id, agent.id, { expired: true });
  await cancelTrade(fakeRequest, tradeId, agent.id);
  await settle();

  sent = [];
  await refundTrade(fakeRequest, tradeId, client.id);
  await settle();

  strictEqual(sent.length, 1);
  strictEqual(sent[0].token, client.token, "el reembolso se avisa a quien bloqueo");
  strictEqual(sent[0].data.kind, "refunded");
  console.log("  ✓ el reembolso se avisa a quien bloqueo los fondos");
}

async function testSweepRefundAlsoNotifies() {
  const client = await createUser("cli");
  const agent = await createUser("agt", { available: false });
  const tradeId = await insertLockedCashout(client.id, agent.id, { expired: true });
  await cancelTrade(fakeRequest, tradeId, agent.id);
  await settle();

  sent = [];
  await sweepPendingRefunds(fakeRequest);
  await settle();

  const mine = sent.filter((m) => m.data.tradeId === tradeId);
  strictEqual(mine.length, 1, "el reembolso automatico tambien avisa");
  strictEqual(mine[0].token, client.token);
  strictEqual(mine[0].data.kind, "refunded");
  console.log("  ✓ el reembolso automatico (sweep) tambien avisa, sin nadie en la pantalla");
}

async function testNoTokenIsNotAnError() {
  const client = await createUser("cli", { withToken: false });
  const agent = await createUser("agt", { available: false });
  const tradeId = await insertLockedCashout(client.id, agent.id, { expired: false });

  sent = [];
  const result = await cancelTrade(fakeRequest, tradeId, agent.id);
  await settle();

  strictEqual(result.status, "cancelled", "la cancelacion no depende del aviso");
  strictEqual(sent.length, 0, "sin token no se envia nada");
  console.log("  ✓ sin token no se envia nada y la operacion sigue igual");
}

function testRefundTimeIsInMexicoCity() {
  // 18:30 UTC = 12:30 en Ciudad de Mexico (UTC-6, sin horario de verano).
  const { body } = buildTradeUpdateMessage({
    tradeId: "t",
    kind: "cancelled",
    amountMxn: 500,
    refundAvailableAt: "2026-10-20T18:30:00.000Z",
  });
  ok(body.includes("$500 MXN"), body);
  ok(body.includes("12:30"), `hora de Ciudad de Mexico: ${body}`);
  console.log("  ✓ la hora del reembolso sale en hora de Ciudad de México");
}

async function main() {
  console.log("\n  Avisos de cambios en la operacion:\n");
  await testAgentCancelTellsClientWhenFundsReturn();
  await testClientCancelTellsAgentWithoutRefundTime();
  await testRefundTellsWhoLockedTheFunds();
  await testSweepRefundAlsoNotifies();
  await testNoTokenIsNotAnError();
  testRefundTimeIsInMexicoCity();
  console.log("\nAll trade update notification tests passed.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
