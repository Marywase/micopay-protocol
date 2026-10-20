import { config } from '../config.js';
import type { FastifyRequest } from 'fastify';
import db from '../db/schema.js';
import { AppError, ReplayError, UpstreamError, BadRequestError } from '../utils/errors.js';
import { rpcRead, submitSignedTx } from '../lib/stellarRpc.js';

export async function assertNotReplayed(
  txHash: string,
  route: string,
  userId: string,
): Promise<void> {
  const inserted = await db.insertUnique(
    `INSERT INTO processed_tx (tx_hash, source_route, user_id, processed_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING tx_hash`,
    [txHash, route, userId],
    'tx_hash',
  );

  if (inserted === null) {
    throw new ReplayError(txHash, route);
  }
}

// Ventana antes de que `refund` quede disponible. El contrato acepta cualquier
// valor (incluso 0), asi que el backend la fija aqui y `submitLockTx` rechaza un
// lock firmado con otra: con 0, el vendedor podia recuperar los fondos despues
// de recibir el efectivo y antes de que llegara el release.
export const LOCK_TIMEOUT_MINUTES = 120;

function getNetworkPassphrase(NetworksModule: typeof import('@stellar/stellar-sdk').Networks) {
  return config.stellarNetwork === 'TESTNET' ? NetworksModule.TESTNET : NetworksModule.PUBLIC;
}

function getHorizonUrl(): string {
  return config.stellarNetwork === 'TESTNET'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

/**
 * A client-signed XDR is an opaque blob until we look inside it — without this
 * check, a seller/buyer juggling multiple trades could sign one trade's
 * lock()/release() call and submit it against a *different* trade's endpoint
 * (same auth passes, since they own both trades), desyncing the DB's trade
 * status from what actually happened on-chain. This parses the single
 * invokeHostFunction operation out of the transaction and asserts the
 * contract id, function name, and every fund-relevant argument match what the
 * trade row expects before we ever call sendTransaction.
 */
async function assertInvocationMatches(
  tx: import('@stellar/stellar-sdk').Transaction | import('@stellar/stellar-sdk').FeeBumpTransaction,
  expected: { contractId: string; functionName: string; args: unknown[] },
) {
  const { Address, scValToNative, FeeBumpTransaction } = await import('@stellar/stellar-sdk');

  if (tx instanceof FeeBumpTransaction) {
    throw new BadRequestError('INVALID_TX_SHAPE', 'La transacción firmada no es válida.', 'Fee-bump transactions are not accepted for lock/release');
  }

  if (tx.operations.length !== 1 || tx.operations[0].type !== 'invokeHostFunction') {
    throw new BadRequestError('INVALID_TX_SHAPE', 'La transacción firmada no es válida.', 'Expected exactly one invokeHostFunction operation');
  }

  const op = tx.operations[0] as import('@stellar/stellar-sdk').Operation.InvokeHostFunction;
  const hostFn = op.func;
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new BadRequestError('INVALID_TX_SHAPE', 'La transacción firmada no es válida.', 'Expected an invokeContract host function');
  }

  const invocation = hostFn.invokeContract();
  const contractId = Address.fromScAddress(invocation.contractAddress()).toString();
  if (contractId !== expected.contractId) {
    throw new BadRequestError('TX_CONTRACT_MISMATCH', 'La transacción firmada no corresponde al contrato de escrow.', `Expected contract ${expected.contractId}, got ${contractId}`);
  }

  const functionName = invocation.functionName().toString();
  if (functionName !== expected.functionName) {
    throw new BadRequestError('TX_FUNCTION_MISMATCH', 'La transacción firmada no corresponde a esta operación.', `Expected function ${expected.functionName}, got ${functionName}`);
  }

  // Only the leading args we pass in `expected` are checked. Callers must list
  // every argument that decides who ends up with the funds — for lock() that
  // includes timeout_minutes, which sets when refund() opens.
  const actualArgs = invocation.args().map((a) => scValToNative(a));
  if (actualArgs.length < expected.args.length) {
    throw new BadRequestError('TX_ARGS_MISMATCH', 'La transacción firmada no corresponde a este intercambio.', `Arg count mismatch: expected at least ${expected.args.length}, got ${actualArgs.length}`);
  }
  for (let i = 0; i < expected.args.length; i++) {
    const a = actualArgs[i];
    const e = expected.args[i];
    const matches = Buffer.isBuffer(e) || e instanceof Uint8Array
      ? Buffer.from(a as Uint8Array).equals(Buffer.from(e as Uint8Array))
      : String(a) === String(e);
    if (!matches) {
      throw new BadRequestError(
        'TX_ARGS_MISMATCH',
        'La transacción firmada no corresponde a este intercambio.',
        `Arg ${i} mismatch: expected ${e}, got ${a}`,
      );
    }
  }
}

/**
 * Poll Horizon for transaction confirmation.
 * Shared by every prepare/submit pair below.
 */
async function pollForConfirmation(
  request: { log: { info: (...args: any[]) => void; error?: (...args: any[]) => void; [key: string]: any } },
  txHash: string,
  label: string,
  failedCode: string,
  timeoutCode: string,
  failedMessage: string,
  timeoutMessage: string,
): Promise<{ txHash: string }> {
  const horizonUrl = `${getHorizonUrl()}/transactions/${txHash}`;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(horizonUrl, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = (await res.json()) as { successful: boolean };
        if (data.successful) {
          request.log.info({ tx_hash: txHash, category: 'stellar.tx' }, `[Stellar] ${label} confirmed`);
          return { txHash };
        }
        throw new UpstreamError(failedCode, failedMessage, `${label} transaction failed on-chain: ${txHash}`);
      }
      // 404 = still pending
    } catch (err: any) {
      if (err instanceof UpstreamError) throw err;
      // network error — keep polling
    }
  }

  throw new UpstreamError(timeoutCode, timeoutMessage, `${label} tx ${txHash} not confirmed within 30s`);
}

/**
 * Build and simulate (but do not sign) the lock() invocation.
 * The seller's own key must sign the returned XDR client-side —
 * the contract enforces `seller.require_auth()`, so the backend
 * never needs (or is able) to act on the seller's behalf.
 */
export async function prepareLockTx(params: {
  request: FastifyRequest;
  /** Contrato del escrow de la operacion (`escrowContractForTrade`). */
  contractId: string;
  sellerAddress: string;
  buyerAddress: string;
  amountStroops: bigint;
  /**
   * Comision de plataforma YA convertida a stroops del activo. Antes llegaba en
   * pesos y se multiplicaba aqui por 10^7, o sea 1 MXN = 1 unidad del activo:
   * el mismo error de unidades que el monto. La conversion vive en
   * `assetRate.service` y nadie mas multiplica.
   */
  platformFeeStroops: bigint;
  secretHash: string; // 64-char hex (32 bytes)
}): Promise<{ xdr: string; networkPassphrase: string }> {
  const {
    Contract, TransactionBuilder, Networks, nativeToScVal, Address,
  } = await import('@stellar/stellar-sdk');

  const {
    sellerAddress, buyerAddress, amountStroops, platformFeeStroops, secretHash,
  } = params;

  const networkPassphrase = getNetworkPassphrase(Networks);

  const account = await rpcRead(config.stellarRpcUrl, (s) => s.getAccount(sellerAddress));
  const contract = new Contract(params.contractId);

  const secretHashBytes = Buffer.from(secretHash, 'hex');

  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase })
    .addOperation(
      contract.call(
        'lock',
        new Address(sellerAddress).toScVal(),
        new Address(buyerAddress).toScVal(),
        nativeToScVal(amountStroops, { type: 'i128' }),
        nativeToScVal(platformFeeStroops, { type: 'i128' }),
        nativeToScVal(secretHashBytes, { type: 'bytes' }),
        nativeToScVal(LOCK_TIMEOUT_MINUTES, { type: 'u32' }),
      ),
    )
    .setTimeout(180)
    .build();

  let prepared;
  try {
    prepared = await rpcRead(config.stellarRpcUrl, (s) => s.prepareTransaction(tx));
  } catch (err: any) {
    // Open circuit or timeout: keep its 503/504 instead of calling it a simulation failure.
    if (err instanceof AppError) throw err;
    params.request.log.error({ err: err.message, category: 'stellar.tx' }, '[Stellar] Lock simulation failed');
    throw new Error(`Simulation failed: ${err.message}. Check if contract is deployed and parameters are correct.`);
  }

  return { xdr: prepared.toXDR(), networkPassphrase };
}

/**
 * Submit a lock() transaction that was already signed by the seller's own key.
 * Re-derives the expected contract-call arguments from the trade row and
 * verifies the signed XDR actually matches before submitting — see
 * assertInvocationMatches() for why this is required.
 */
export async function submitLockTx(params: {
  request: FastifyRequest;
  /** Contrato del escrow de la operacion (`escrowContractForTrade`). */
  contractId: string;
  signedXdr: string;
  sellerAddress: string;
  buyerAddress: string;
  amountStroops: bigint;
  platformFeeStroops: bigint;
  secretHash: string;
}): Promise<{ txHash: string }> {
  const { TransactionBuilder, Networks } = await import('@stellar/stellar-sdk');
  const networkPassphrase = getNetworkPassphrase(Networks);

  const tx = TransactionBuilder.fromXDR(params.signedXdr, networkPassphrase);

  await assertInvocationMatches(tx, {
    contractId: params.contractId,
    functionName: 'lock',
    args: [
      params.sellerAddress,
      params.buyerAddress,
      params.amountStroops,
      params.platformFeeStroops,
      Buffer.from(params.secretHash, 'hex'),
      LOCK_TIMEOUT_MINUTES,
    ],
  });

  const sendResult = await submitSignedTx(config.stellarRpcUrl, tx);
  if (sendResult.status === 'ERROR') {
    params.request.log.error({ detail: sendResult.errorResult, category: 'stellar.tx' }, '[Stellar] Lock send failed');
    throw new BadRequestError('STELLAR_LOCK_SEND_FAILED', 'La transacción de bloqueo fue rechazada por la red.', `Send failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  return pollForConfirmation(
    params.request,
    sendResult.hash,
    'Lock',
    'STELLAR_TRANSACTION_FAILED',
    'STELLAR_TIMEOUT',
    'La transacción de bloqueo falló en la blockchain.',
    'La transacción de bloqueo está tardando más de lo esperado.',
  );
}

/**
 * Build and simulate (but do not sign) the release() invocation.
 * The buyer's own key must sign the returned XDR client-side —
 * the contract enforces `trade.buyer.require_auth()`.
 */
export async function prepareReleaseTx(params: {
  request: FastifyRequest;
  /** Contrato del escrow de la operacion (`escrowContractForTrade`). */
  contractId: string;
  buyerAddress: string;
  tradeIdBytes: Buffer; // 32 bytes: sha256(secret_hash_bytes)
  secretBytes: Buffer; // 32 bytes: raw HTLC preimage
}): Promise<{ xdr: string; networkPassphrase: string }> {
  const { Contract, TransactionBuilder, Networks, nativeToScVal } = await import('@stellar/stellar-sdk');

  const { buyerAddress, tradeIdBytes, secretBytes } = params;

  const networkPassphrase = getNetworkPassphrase(Networks);

  const account = await rpcRead(config.stellarRpcUrl, (s) => s.getAccount(buyerAddress));
  const contract = new Contract(params.contractId);

  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase })
    .addOperation(
      contract.call(
        'release',
        nativeToScVal(tradeIdBytes, { type: 'bytes' }),
        nativeToScVal(secretBytes, { type: 'bytes' }),
      ),
    )
    .setTimeout(180)
    .build();

  let prepared;
  try {
    prepared = await rpcRead(config.stellarRpcUrl, (s) => s.prepareTransaction(tx));
  } catch (err: any) {
    // Open circuit or timeout: keep its 503/504 instead of calling it a simulation failure.
    if (err instanceof AppError) throw err;
    params.request.log.error({ err: err.message, category: 'stellar.tx' }, '[Stellar] Release simulation failed');
    throw new Error(`Release simulation failed: ${err.message}. Check if trade exists in contract.`);
  }

  return { xdr: prepared.toXDR(), networkPassphrase };
}

/**
 * Submit a release() transaction that was already signed by the buyer's own key.
 * Re-derives the expected contract-call arguments from the trade row and
 * verifies the signed XDR actually matches before submitting — see
 * assertInvocationMatches() for why this is required.
 */
export async function submitReleaseTx(params: {
  request: FastifyRequest;
  /** Contrato del escrow de la operacion (`escrowContractForTrade`). */
  contractId: string;
  signedXdr: string;
  tradeIdBytes: Buffer;
  secretBytes: Buffer;
}): Promise<{ txHash: string }> {
  const { TransactionBuilder, Networks } = await import('@stellar/stellar-sdk');
  const networkPassphrase = getNetworkPassphrase(Networks);

  const tx = TransactionBuilder.fromXDR(params.signedXdr, networkPassphrase);

  await assertInvocationMatches(tx, {
    contractId: params.contractId,
    functionName: 'release',
    args: [params.tradeIdBytes, params.secretBytes],
  });

  const sendResult = await submitSignedTx(config.stellarRpcUrl, tx);
  if (sendResult.status === 'ERROR') {
    params.request.log.error({ detail: sendResult.errorResult, category: 'stellar.tx' }, '[Stellar] Release send failed');
    throw new BadRequestError('STELLAR_RELEASE_SEND_FAILED', 'La transacción de liberación fue rechazada por la red.', `Release send failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  return pollForConfirmation(
    params.request,
    sendResult.hash,
    'Release',
    'STELLAR_RELEASE_FAILED',
    'STELLAR_RELEASE_TIMEOUT',
    'La transacción de liberación falló en la blockchain.',
    'La transacción de liberación está tardando más de lo esperado.',
  );
}

/**
 * Call the escrow contract's refund() function.
 * No require_auth() in the contract for refund — anyone may call it
 * after timeout, so the platform key remains a valid signer here.
 *
 * `request` only needs `.log` — narrowed to `Pick<FastifyRequest, 'log'>` (not
 * the full `FastifyRequest`) so the background refund sweep in index.ts, which
 * has no HTTP request, can call this with a plain `{ log: app.log }` shim.
 */
export async function callRefundOnChain(params: {
  request: { log: { info: (...args: any[]) => void; error: (...args: any[]) => void; [key: string]: any } };
  /** Contrato del escrow de la operacion (`escrowContractForTrade`). */
  contractId: string;
  tradeIdBytes: Buffer;
}): Promise<{ txHash: string }> {
  const {
    Contract, TransactionBuilder, Networks, Keypair,
    nativeToScVal,
  } = await import('@stellar/stellar-sdk');

  const { tradeIdBytes } = params;

  const networkPassphrase = getNetworkPassphrase(Networks);
  const keypair = Keypair.fromSecret(config.platformSecretKey);
  const platformAddress = keypair.publicKey();

  const account = await rpcRead(config.stellarRpcUrl, (s) => s.getAccount(platformAddress));
  const contract = new Contract(params.contractId);

  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase })
    .addOperation(
      contract.call('refund', nativeToScVal(tradeIdBytes, { type: 'bytes' })),
    )
    .setTimeout(60)
    .build();

  let prepared;
  try {
    prepared = await rpcRead(config.stellarRpcUrl, (s) => s.prepareTransaction(tx));
  } catch (err: any) {
    // Open circuit or timeout: keep its 503/504 instead of calling it a simulation failure.
    if (err instanceof AppError) throw err;
    params.request.log.error({ err: err.message, category: 'stellar.tx' }, '[Stellar] Refund simulation failed');
    throw new Error(`Refund simulation failed: ${err.message}. Check if trade exists in contract.`);
  }

  prepared.sign(keypair);

  const sendResult = await submitSignedTx(config.stellarRpcUrl, prepared);
  if (sendResult.status === 'ERROR') {
    params.request.log.error({ detail: sendResult.errorResult, category: 'stellar.tx' }, '[Stellar] Refund send failed');
    throw new Error(`Refund send failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  return pollForConfirmation(
    params.request,
    sendResult.hash,
    'Refund',
    'STELLAR_REFUND_FAILED',
    'STELLAR_REFUND_TIMEOUT',
    'La transacción de reembolso falló en la blockchain.',
    'La transacción de reembolso está tardando más de lo esperado.',
  );
}

/**
 * Legacy mock used when MOCK_STELLAR=true.
 */
export async function verifyLockOnChain(
  request: FastifyRequest,
  stellarTradeId: string,
  _expectedSellerAddress: string,
  _expectedAmountStroops: bigint,
): Promise<boolean> {
  request.log.info({ stellar_trade_id: stellarTradeId, category: 'stellar.tx' }, '[MOCK] Verifying lock on-chain');
  return true;
}
