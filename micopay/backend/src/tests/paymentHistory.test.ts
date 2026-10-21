/**
 * Transferencias en el Historial: que pagos de la red salen, en que sentido,
 * con que monto, y a quien se le pone su @usuario.
 *
 * Corre con la base en memoria y un Horizon falso.
 */
import { strictEqual, deepStrictEqual, rejects } from "assert";
import db from "../db/schema.js";
import { getPaymentHistory, setPaymentHistoryFetchForTests, toHistoryItem } from "../services/paymentHistory.service.js";

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

function address(label: string): string {
  seq++;
  return `G${label.toUpperCase().slice(0, 1).repeat(47)}${RUN}${String(seq).padStart(2, "0")}`;
}

async function createUser(label: string): Promise<{ address: string; username: string }> {
  const addr = address(label);
  const username = `hist_${label}_${RUN}${seq}`;
  await db.execute(
    `INSERT INTO users (stellar_address, username, phone_hash, is_suspended) VALUES ($1, $2, $3, false)`,
    [addr, username, `h_hist_${RUN}${seq}`],
  );
  return { address: addr, username };
}

let opSeq = 0;
function op(fields: Record<string, unknown>) {
  opSeq++;
  return {
    id: String(1000 + opSeq),
    paging_token: String(1000 + opSeq),
    transaction_hash: opSeq.toString(16).padStart(64, "b"),
    transaction_successful: true,
    created_at: `2026-10-20T20:${String(opSeq).padStart(2, "0")}:00Z`,
    ...fields,
  };
}

function fakeHorizon(records: unknown[], status = 200) {
  const seen: string[] = [];
  setPaymentHistoryFetchForTests(async (url) => {
    seen.push(url);
    return { ok: status === 200, status, json: async () => ({ _embedded: { records } }) };
  });
  return seen;
}

async function testInAndOutWithUsernames() {
  const me = await createUser("me");
  const friend = await createUser("friend");
  const outsider = address("x");
  const seen = fakeHorizon([
    op({ type: "payment", from: friend.address, to: me.address, amount: "5.0000000", asset_type: "native" }),
    op({ type: "payment", from: me.address, to: outsider, amount: "1.5000000", asset_type: "credit_alphanum4", asset_code: "USDC" }),
  ]);

  const items = await getPaymentHistory(me.address);
  strictEqual(items.length, 2);
  deepStrictEqual(
    items.map((i) => [i.direction, i.amount, i.asset, i.counterparty, i.counterparty_username]),
    [
      ["in", "5.0000000", "XLM", friend.address, friend.username],
      ["out", "1.5000000", "USDC", outsider, null],
    ],
  );
  strictEqual(seen[0].includes(`/accounts/${me.address}/payments?order=desc`), true, seen[0]);
  console.log("  ✓ recibidos y enviados, con @usuario solo si es de MicoPay");
}

async function testEscrowAndOtherOpsAreSkipped() {
  const me = await createUser("me");
  fakeHorizon([
    op({ type: "invoke_host_function" }),
    op({ type: "change_trust" }),
    op({ type: "payment", from: me.address, to: me.address, amount: "1", asset_type: "native" }),
    op({ type: "payment", from: address("a"), to: me.address, amount: "1", asset_type: "native", transaction_successful: false }),
  ]);
  strictEqual((await getPaymentHistory(me.address)).length, 0);
  console.log("  ✓ el escrow, otras operaciones, pagos a si mismo y fallidos no salen");
}

async function testCreateAccountAndPathPayment() {
  const me = address("m");
  const funder = address("f");
  const shop = address("s");
  const created = toHistoryItem(op({ type: "create_account", funder, account: me, starting_balance: "10000.0000000" }) as any, me);
  deepStrictEqual([created?.direction, created?.amount, created?.asset, created?.counterparty], ["in", "10000.0000000", "XLM", funder]);

  const sentPath = toHistoryItem(
    op({
      type: "path_payment_strict_send",
      from: me,
      to: shop,
      amount: "9.9000000",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      source_amount: "60.0000000",
      source_asset_type: "native",
    }) as any,
    me,
  );
  deepStrictEqual([sentPath?.direction, sentPath?.amount, sentPath?.asset], ["out", "60.0000000", "XLM"]);
  console.log("  ✓ la activacion de cuenta cuenta como recibido; un pago con conversion muestra lo que salio");
}

async function testUnfundedAccountIsEmpty() {
  fakeHorizon([], 404);
  deepStrictEqual(await getPaymentHistory(address("n")), []);
  console.log("  ✓ una cuenta que aun no existe en la red no tiene transferencias");
}

async function testHorizonErrorThrows() {
  fakeHorizon([], 503);
  await rejects(() => getPaymentHistory(address("e")), /503/);
  console.log("  ✓ si Horizon falla, la ruta responde error en vez de una lista vacia");
}

async function main() {
  console.log("\n  Transferencias en el Historial:\n");
  await testInAndOutWithUsernames();
  await testEscrowAndOtherOpsAreSkipped();
  await testCreateAccountAndPathPayment();
  await testUnfundedAccountIsEmpty();
  await testHorizonErrorThrows();
  console.log("\nAll payment history tests passed.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
