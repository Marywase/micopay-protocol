/**
 * Aviso de pago recibido: solo sale si la transaccion existe en la red, la
 * mando quien lo pide y es reciente; y va a quien recibio, una sola vez.
 *
 * Corre con la base en memoria. Horizon y Firebase se sustituyen por falsos:
 * se prueba a quien va el aviso y que dice, no la entrega al telefono.
 */
import { strictEqual, ok } from "assert";
import db from "../db/schema.js";
import { setMessagingForTests } from "../services/push.service.js";
import {
  notifyIncomingPayment,
  setPaymentNotifyFetchForTests,
  resetPaymentNotifyForTests,
  formatAmount,
} from "../services/paymentNotify.service.js";

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

async function createUser(label: string, { withToken = true } = {}): Promise<{ id: string; address: string; username: string; token: string | null }> {
  seq++;
  const suffix = `${RUN}${String(seq).padStart(2, "0")}`;
  const address = `G${"P".repeat(47)}${suffix}`;
  const username = `pay_${label}_${suffix}`;
  const token = withToken ? `tok_${label}_${suffix}` : null;
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, is_suspended, push_token)
     VALUES ($1, $2, $3, false, $4)
     RETURNING id`,
    [address, username, `h_pay_${suffix}`, token],
  );
  if (!row?.id) throw new Error(`Failed to seed ${label}`);
  return { id: row.id, address, username, token };
}

const NOW = Date.parse("2026-10-20T20:00:00Z");

/** Horizon falso: una transaccion por hash, con sus operaciones. */
function fakeHorizon(txs: Record<string, { tx: any; ops: any[] }>) {
  setPaymentNotifyFetchForTests(async (url) => {
    const m = url.match(/\/transactions\/([0-9a-f]{64})(\/operations)?/);
    const entry = m ? txs[m[1]] : undefined;
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    const body = m![2] ? { _embedded: { records: entry.ops } } : entry.tx;
    return { ok: true, status: 200, json: async () => body };
  });
}

let hashSeq = 0;
function hash(): string {
  hashSeq++;
  return hashSeq.toString(16).padStart(64, "a");
}

function tx(source: string, createdAt = "2026-10-20T19:58:00Z", successful = true) {
  return { successful, source_account: source, created_at: createdAt };
}

function payment(from: string, to: string, amount: string, asset: { code?: string } = {}) {
  return {
    id: `${hashSeq}${Math.random().toString().slice(2, 8)}`,
    type: "payment",
    from,
    to,
    amount,
    asset_type: asset.code ? "credit_alphanum4" : "native",
    asset_code: asset.code,
  };
}

function reset() {
  sent = [];
  resetPaymentNotifyForTests();
}

async function testRecipientGetsNotified() {
  reset();
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const h = hash();
  fakeHorizon({ [h]: { tx: tx(alice.address), ops: [payment(alice.address, bob.address, "50.0000000")] } });

  const r = await notifyIncomingPayment({ senderAddress: alice.address, senderUsername: alice.username, txHash: h, now: NOW });
  strictEqual(r.notified, 1);
  strictEqual(sent.length, 1);
  strictEqual(sent[0].token, bob.token, "el aviso va a quien recibe");
  strictEqual(sent[0].title, "Recibiste dinero");
  strictEqual(sent[0].body, `Te llegaron 50 XLM de @${alice.username}.`);
  strictEqual(sent[0].data.type, "payment_received");
  strictEqual(sent[0].data.txHash, h);
  console.log("  ✓ quien recibe un pago de otro usuario recibe el aviso");
}

async function testUsdcAmount() {
  reset();
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const h = hash();
  fakeHorizon({ [h]: { tx: tx(alice.address), ops: [payment(alice.address, bob.address, "12.5000000", { code: "USDC" })] } });

  await notifyIncomingPayment({ senderAddress: alice.address, senderUsername: alice.username, txHash: h, now: NOW });
  strictEqual(sent.length, 1);
  ok(sent[0].body.startsWith("Te llegaron 12.5 USDC"), sent[0].body);
  console.log("  ✓ el aviso dice el activo y el monto sin ceros de sobra");
}

async function testRetryDoesNotRepeat() {
  reset();
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const h = hash();
  fakeHorizon({ [h]: { tx: tx(alice.address), ops: [payment(alice.address, bob.address, "5")] } });

  await notifyIncomingPayment({ senderAddress: alice.address, senderUsername: alice.username, txHash: h, now: NOW });
  const again = await notifyIncomingPayment({ senderAddress: alice.address, senderUsername: alice.username, txHash: h, now: NOW });
  strictEqual(again.notified, 0);
  strictEqual(sent.length, 1, "un reintento no repite el aviso");
  console.log("  ✓ si la app reintenta, el aviso no se repite");
}

async function testSomeoneElsesTxIsRejected() {
  reset();
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const mallory = await createUser("mallory");
  const h = hash();
  fakeHorizon({ [h]: { tx: tx(alice.address), ops: [payment(alice.address, bob.address, "5")] } });

  const r = await notifyIncomingPayment({ senderAddress: mallory.address, senderUsername: mallory.username, txHash: h, now: NOW });
  strictEqual(r.notified, 0);
  strictEqual((r as any).reason, "not_sender");
  strictEqual(sent.length, 0, "no se puede anunciar un pago que mando otro");
  console.log("  ✓ no se puede anunciar la transaccion de otra persona");
}

async function testFailedMissingOrOldTx() {
  reset();
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const failed = hash();
  const old = hash();
  fakeHorizon({
    [failed]: { tx: tx(alice.address, "2026-10-20T19:58:00Z", false), ops: [payment(alice.address, bob.address, "5")] },
    [old]: { tx: tx(alice.address, "2026-10-20T19:30:00Z"), ops: [payment(alice.address, bob.address, "5")] },
  });

  const args = { senderAddress: alice.address, senderUsername: alice.username, now: NOW };
  strictEqual(((await notifyIncomingPayment({ ...args, txHash: failed })) as any).reason, "failed");
  strictEqual(((await notifyIncomingPayment({ ...args, txHash: old })) as any).reason, "too_old");
  strictEqual(((await notifyIncomingPayment({ ...args, txHash: hash() })) as any).reason, "not_found");
  strictEqual(sent.length, 0);
  console.log("  ✓ sin aviso si la transaccion fallo, no existe o tiene mas de 15 minutos");
}

async function testOnlySendersOwnOpsAndKnownUsers() {
  reset();
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const carol = await createUser("carol");
  const h = hash();
  const outsider = `G${"X".repeat(55)}`;
  fakeHorizon({
    [h]: {
      tx: tx(alice.address),
      ops: [
        payment(alice.address, outsider, "1"), // no es usuario de MicoPay
        payment(carol.address, bob.address, "9"), // otra cuenta de origen
        payment(alice.address, alice.address, "2"), // a si misma
      ],
    },
  });

  const r = await notifyIncomingPayment({ senderAddress: alice.address, senderUsername: alice.username, txHash: h, now: NOW });
  strictEqual(r.notified, 0);
  strictEqual(sent.length, 0);
  console.log("  ✓ solo cuentan los pagos de quien lo pide a otros usuarios de MicoPay");
}

async function testHorizonDownIsNotAnError() {
  reset();
  const alice = await createUser("alice");
  setPaymentNotifyFetchForTests(async () => {
    throw new Error("timeout");
  });
  const r = await notifyIncomingPayment({ senderAddress: alice.address, senderUsername: alice.username, txHash: hash(), now: NOW });
  strictEqual((r as any).reason, "horizon_error");
  strictEqual(sent.length, 0);
  console.log("  ✓ si Horizon falla no se avisa y no se lanza error");
}

async function testRecipientWithoutTokenIsNotAnError() {
  reset();
  const alice = await createUser("alice");
  const bob = await createUser("bob", { withToken: false });
  const h = hash();
  fakeHorizon({ [h]: { tx: tx(alice.address), ops: [payment(alice.address, bob.address, "5")] } });
  const r = await notifyIncomingPayment({ senderAddress: alice.address, senderUsername: alice.username, txHash: h, now: NOW });
  strictEqual(r.notified, 0);
  strictEqual(sent.length, 0);
  console.log("  ✓ quien recibe sin telefono registrado no rompe nada");
}

function testFormatAmount() {
  strictEqual(formatAmount("50.0000000"), "50");
  strictEqual(formatAmount("0.1000000"), "0.1");
  strictEqual(formatAmount("1234.5000000"), "1,234.5");
  console.log("  ✓ montos con formato de México");
}

async function main() {
  console.log("\n  Aviso de pago recibido:\n");
  await testRecipientGetsNotified();
  await testUsdcAmount();
  await testRetryDoesNotRepeat();
  await testSomeoneElsesTxIsRejected();
  await testFailedMissingOrOldTx();
  await testOnlySendersOwnOpsAndKnownUsers();
  await testHorizonDownIsNotAnError();
  await testRecipientWithoutTokenIsNotAnError();
  testFormatAmount();
  console.log("\nAll payment notification tests passed.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
