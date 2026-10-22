import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  confirmBankWithdrawOrder,
  createBankWithdrawQuote,
  fetchBankWithdrawOrders,
  fetchBankWithdrawStatus,
  registerBankAccount,
  startBankKyc,
  type BankKycLaunchForm,
  type BankWithdrawOrder,
  type BankWithdrawOrderSummary,
  type BankWithdrawQuote,
  type BankWithdrawStatusResponse,
  type StartBankKycRequest,
} from '../services/api';
import { extractApiErrorPayload } from '../utils/apiError';
import { getPublicKey } from '../lib/keystore';
import {
  signAndSubmitPreparedWithdrawTx,
  WithdrawTxMismatchError,
  type ExpectedBankWithdraw,
} from '../services/stellarRamp';

interface BankWithdrawScreenProps {
  onBack: () => void;
  userToken: string;
}

// ---- validacion de CLABE (misma formula que el backend) -----------------

const CLABE_WEIGHTS = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
function validateClabeFront(clabe: string): boolean {
  if (!/^[0-9]{18}$/.test(clabe)) return false;
  let acc = 0;
  for (let i = 0; i < 17; i++) acc += (Number(clabe[i]) * CLABE_WEIGHTS[i]) % 10;
  return ((10 - (acc % 10)) % 10) === Number(clabe[17]);
}

// Mapa minimo CLABE -> banco. Los primeros 3 digitos son el codigo del banco
// (publicado por el Banco de Mexico). Suficiente para el ejemplo; se ira
// ampliando cuando pintemos la lista real.
const BANCOS: Record<string, string> = {
  '002': 'Banamex',
  '012': 'BBVA',
  '014': 'Santander',
  '021': 'HSBC',
  '030': 'Bajio',
  '032': 'IXE',
  '036': 'Inbursa',
  '037': 'Interacciones',
  '040': 'ABC Capital',
  '044': 'Scotiabank',
  '058': 'Banregio',
  '059': 'Invex',
  '060': 'Bansi',
  '062': 'Afirme',
  '072': 'Banorte',
  '127': 'Azteca',
  '137': 'BanCoppel',
  '646': 'STP',
};
function bankFromClabe(clabe: string): string | null {
  if (clabe.length < 3) return null;
  return BANCOS[clabe.slice(0, 3)] ?? null;
}

// ---- Pantalla ------------------------------------------------------------

export default function BankWithdrawScreen({ onBack, userToken }: BankWithdrawScreenProps) {
  const [status, setStatus] = useState<BankWithdrawStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const s = await fetchBankWithdrawStatus(userToken);
      setStatus(s);
    } catch (e) {
      setError(extractApiErrorPayload(e).message ?? 'No pudimos cargar tu estado');
    } finally {
      setLoading(false);
    }
  }, [userToken]);

  useEffect(() => { refresh(); }, [refresh]);

  // Si estamos esperando revision de Etherfuse, consultamos cada 10 s por si
  // ya aprobaron (el webhook escribe en la base, pero esto evita que el
  // usuario tenga que cerrar y abrir).
  useEffect(() => {
    if (status?.stage !== 'kyc_review') return;
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [status?.stage, refresh]);

  return (
    <div className="min-h-screen bg-crema text-tinta flex flex-col">
      <header className="flex items-center gap-3 p-4 border-b-2 border-tinta">
        <button onClick={onBack} className="font-bold" aria-label="Atras">←</button>
        <h1 className="font-bold text-lg">Retirar a banco</h1>
      </header>

      <main className="flex-1 p-4 flex flex-col gap-4">
        {loading && <p>Cargando…</p>}
        {!loading && error && (
          <div className="p-4 border-2 border-tinta bg-amarillo">
            <p className="font-bold">{error}</p>
            <button onClick={refresh} className="mt-2 underline">Reintentar</button>
          </div>
        )}
        {!loading && !error && status && (
          <StageView status={status} userToken={userToken} onChanged={refresh} />
        )}
      </main>
    </div>
  );
}

function StageView({
  status, userToken, onChanged,
}: { status: BankWithdrawStatusResponse; userToken: string; onChanged: () => void }) {
  switch (status.stage) {
    case 'needs_didit':
      return (
        <section className="p-4 border-2 border-tinta bg-crema">
          <h2 className="font-bold mb-2">Verifica tu identidad</h2>
          <p className="mb-4">
            Antes de retirar a tu banco necesitas verificar tu identidad. Es el
            mismo proceso de Didit que usamos para pagar entre personas.
          </p>
          <p className="text-sm opacity-70">Vuelve aqui cuando este listo.</p>
        </section>
      );
    case 'needs_kyc':
      return <KycForm userToken={userToken} onDone={onChanged} />;
    case 'kyc_review':
      return (
        <section className="p-4 border-2 border-tinta bg-amarillo">
          <h2 className="font-bold mb-2">En revisión</h2>
          <p>
            Etherfuse esta revisando tus datos. Esto suele tomar minutos.
            {status.kycMessage ? ` ${status.kycMessage}` : ''}
          </p>
        </section>
      );
    case 'needs_bank':
      return <BankAccountForm userToken={userToken} onDone={onChanged} />;
    case 'ready':
      return <WithdrawForm userToken={userToken} clabeMasked={status.clabeMasked} />;
  }
}

function BankAccountForm({ userToken, onDone }: { userToken: string; onDone: () => void }) {
  const [clabe, setClabe] = useState('');
  const [holder, setHolder] = useState('');
  const [rfc, setRfc] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clabeOk = validateClabeFront(clabe);
  const banco = bankFromClabe(clabe);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clabeOk || !holder.trim() || !rfc.trim()) return;
    try {
      setSubmitting(true);
      setError(null);
      await registerBankAccount(userToken, {
        clabe,
        accountHolderName: holder.trim(),
        taxId: rfc.trim().toUpperCase(),
      });
      onDone();
    } catch (e) {
      setError(extractApiErrorPayload(e).message ?? 'No pudimos registrar la cuenta');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="p-4 border-2 border-tinta bg-crema flex flex-col gap-4">
      <h2 className="font-bold">Tu cuenta de banco</h2>

      <label className="flex flex-col gap-1">
        <span className="font-bold">CLABE (18 dígitos)</span>
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={18}
          value={clabe}
          onChange={(e) => setClabe(e.target.value.replace(/[^0-9]/g, ''))}
          className="border-2 border-tinta p-2 bg-white"
        />
        {clabe.length > 0 && (
          <span className="text-sm">
            {clabe.length < 18
              ? `${clabe.length}/18`
              : clabeOk
                ? `✓ ${banco ?? 'banco desconocido'}`
                : '✗ el dígito de control no coincide'}
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-bold">Nombre del titular</span>
        <input
          type="text"
          value={holder}
          onChange={(e) => setHolder(e.target.value)}
          className="border-2 border-tinta p-2 bg-white"
          autoComplete="name"
          maxLength={200}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-bold">RFC del titular</span>
        <input
          type="text"
          value={rfc}
          onChange={(e) => setRfc(e.target.value.toUpperCase())}
          className="border-2 border-tinta p-2 bg-white"
          maxLength={13}
          placeholder="XAXX010101000"
        />
      </label>

      {error && <p className="text-red-600 font-bold">{error}</p>}

      <button
        type="submit"
        disabled={!clabeOk || !holder.trim() || !rfc.trim() || submitting}
        className="min-h-12 bg-tinta text-crema font-bold disabled:opacity-50"
      >
        {submitting ? 'Guardando…' : 'Guardar cuenta'}
      </button>
    </form>
  );
}

// ---- KYC: formulario y launch de /idv -----------------------------------

/**
 * Abre /auth/launch de Etherfuse con un POST (como pide la especificacion de
 * JWT bearer). Crea un <form> en el DOM, lo submitea con target="_blank" para
 * que el navegador del sistema se encargue, y lo limpia enseguida. En
 * Capacitor el WebView delega a Chrome Custom Tabs / Safari View Controller.
 */
function submitLaunchForm(launch: BankKycLaunchForm) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = launch.url;
  form.target = '_blank';
  form.rel = 'noopener';
  for (const [k, v] of Object.entries(launch.fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = v;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  try { form.submit(); } finally { form.remove(); }
}

const RFC_RE = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

function KycForm({ userToken, onDone }: { userToken: string; onDone: () => void }) {
  const [fullName, setFullName] = useState('');
  const [dob, setDob] = useState('');
  const [rfc, setRfc] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostal] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState(false);

  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts.slice(0, nameParts.length > 2 ? -2 : -1).join(' ') || nameParts[0] || '';
  const lastName = nameParts.length > 1 ? nameParts.slice(nameParts.length > 2 ? -2 : -1).join(' ') : '';
  const canSubmit =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(dob) &&
    RFC_RE.test(rfc.trim().toUpperCase()) &&
    street.trim().length > 0 &&
    city.trim().length > 0 &&
    email.includes('@');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    const req: StartBankKycRequest = {
      firstName,
      lastName,
      dateOfBirth: dob,
      taxId: rfc.trim().toUpperCase(),
      country: 'MEX',
      address: {
        street: street.trim(),
        city: city.trim(),
        country: 'MEX',
        postalCode: postalCode.trim() || undefined,
      },
      email: email.trim(),
      displayName: fullName.trim(),
    };
    try {
      setSubmitting(true);
      setError(null);
      const res = await startBankKyc(userToken, req);
      submitLaunchForm(res.launch);
      setLaunched(true);
      // El webhook kycUpdated marca el estado desde el backend; mientras tanto
      // onDone trae needs_kyc -> kyc_review y empieza el polling de 10 s.
      setTimeout(onDone, 1500);
    } catch (e) {
      setError(extractApiErrorPayload(e).message ?? 'No pudimos iniciar el KYC');
    } finally {
      setSubmitting(false);
    }
  };

  if (launched) {
    return (
      <section className="p-4 border-2 border-tinta bg-amarillo flex flex-col gap-3">
        <h2 className="font-bold">Abrimos el verificador</h2>
        <p>
          Haz la selfie y acepta el contrato en la pestana que se abrio.
          Cuando termines, regresa aqui: en unos segundos esta pantalla
          cambia sola.
        </p>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="p-4 border-2 border-tinta bg-crema flex flex-col gap-3">
      <h2 className="font-bold">Un paso para habilitar el retiro</h2>
      <p className="text-sm">
        Etherfuse pide estos datos la primera vez. Despues de guardarlos
        abriremos su pagina para que te tomes una selfie y aceptes su
        contrato.
      </p>

      <label className="flex flex-col gap-1">
        <span className="font-bold">Nombre completo (como en tu INE)</span>
        <input
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="border-2 border-tinta p-2 bg-white"
          autoComplete="name"
          maxLength={120}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-bold">Fecha de nacimiento</span>
        <input
          type="date"
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          className="border-2 border-tinta p-2 bg-white"
          max={new Date(Date.now() - 568_000_000_000).toISOString().slice(0, 10) /* ~18 anos */}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-bold">RFC con homoclave</span>
        <input
          type="text"
          value={rfc}
          onChange={(e) => setRfc(e.target.value.toUpperCase())}
          className="border-2 border-tinta p-2 bg-white uppercase"
          maxLength={13}
          placeholder="HEGL900101AB1"
        />
        {rfc.length > 0 && !RFC_RE.test(rfc.trim().toUpperCase()) && (
          <span className="text-sm">El RFC debe tener 12 o 13 caracteres (4 letras, 6 numeros, 3 alfanumericos).</span>
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-bold">Correo</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border-2 border-tinta p-2 bg-white"
          autoComplete="email"
          maxLength={254}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-bold">Calle y numero</span>
        <input
          type="text"
          value={street}
          onChange={(e) => setStreet(e.target.value)}
          className="border-2 border-tinta p-2 bg-white"
          autoComplete="address-line1"
          maxLength={200}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="font-bold">Ciudad</span>
          <input
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="border-2 border-tinta p-2 bg-white"
            autoComplete="address-level2"
            maxLength={100}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-bold">CP (opcional)</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={postalCode}
            onChange={(e) => setPostal(e.target.value.replace(/[^0-9]/g, ''))}
            className="border-2 border-tinta p-2 bg-white"
            maxLength={5}
          />
        </label>
      </div>

      {error && <p className="text-red-600 font-bold">{error}</p>}

      <button
        type="submit"
        disabled={!canSubmit || submitting}
        className="min-h-12 bg-tinta text-crema font-bold disabled:opacity-50"
      >
        {submitting ? 'Enviando…' : 'Continuar con la selfie'}
      </button>

      <p className="text-xs opacity-70">
        Los datos van directo a Etherfuse. La constancia de situacion fiscal
        se pedira dentro de su pagina si la necesitan.
      </p>
    </form>
  );
}

// ---- Retiro: monto, cotizacion, firma y seguimiento ---------------------

type WithdrawStage =
  | { kind: 'idle' }
  | { kind: 'quoted'; quote: BankWithdrawQuote }
  | { kind: 'signing'; order: BankWithdrawOrder; quote: BankWithdrawQuote }
  | { kind: 'tracking'; orderId: string; status: BankWithdrawOrderSummary['status']; destinationMxn: string | null };

function useCountdown(targetIso?: string): number {
  const target = targetIso ? new Date(targetIso).getTime() : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  return target ? Math.max(0, Math.floor((target - now) / 1000)) : 0;
}

function WithdrawForm({ userToken, clabeMasked }: { userToken: string; clabeMasked?: string }) {
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<WithdrawStage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const quote = stage.kind === 'quoted' ? stage.quote : (stage.kind === 'signing' ? stage.quote : null);
  const secondsLeft = useCountdown(quote?.expiresAt);
  const expired = quote !== null && secondsLeft === 0;

  const amountOk = /^[0-9]+(\.[0-9]{1,7})?$/.test(amount) && Number(amount) > 0;

  const requestQuote = async () => {
    if (!amountOk) return;
    try {
      setBusy(true); setError(null);
      const q = await createBankWithdrawQuote(userToken, { asset: 'USDC', amount });
      setStage({ kind: 'quoted', quote: q });
    } catch (e) {
      setError(extractApiErrorPayload(e).message ?? 'No pudimos cotizar');
    } finally { setBusy(false); }
  };

  const confirmAndSign = async () => {
    if (stage.kind !== 'quoted') return;
    const q = stage.quote;
    try {
      setBusy(true); setError(null);
      const order = await confirmBankWithdrawOrder(userToken, q.quoteId);
      setStage({ kind: 'signing', order, quote: q });

      const dest = order.fundingInstructions?.destination;
      if (!order.preparedTransaction || !dest?.address) {
        throw new Error('Etherfuse no devolvio una transaccion para firmar');
      }
      const pub = await getPublicKey();
      if (!pub) throw new Error('No encontramos tu llave en el telefono');

      // sourceAsset del quote viene como "USDC:ISSUER".
      const [, issuer = ''] = q.sourceAsset.split(':');
      const expected: ExpectedBankWithdraw = {
        fromAddress: pub,
        toAddress: dest.address,
        memo: dest.memo ?? null,
        assetCode: 'USDC',
        assetIssuer: issuer,
        amount: q.sourceAmount,
      };
      await signAndSubmitPreparedWithdrawTx(order.preparedTransaction, expected);

      setStage({
        kind: 'tracking',
        orderId: order.orderId,
        status: order.status,
        destinationMxn: q.destinationAmount,
      });
    } catch (e) {
      if (e instanceof WithdrawTxMismatchError) {
        setError(`La transaccion no coincide con la orden (${e.reason}). No se firmo.`);
      } else {
        setError(extractApiErrorPayload(e).message ?? (e as Error).message);
      }
      setStage({ kind: 'idle' });
    } finally { setBusy(false); }
  };

  // Mientras hacemos seguimiento, consultamos /orders cada 10 s.
  useEffect(() => {
    if (stage.kind !== 'tracking') return;
    const orderId = stage.orderId;
    const t = setInterval(async () => {
      try {
        const orders = await fetchBankWithdrawOrders(userToken);
        const found = orders.find((o) => o.orderId === orderId);
        if (found) {
          setStage((s) => s.kind === 'tracking' && s.orderId === orderId
            ? { ...s, status: found.status, destinationMxn: found.destinationMxn ?? s.destinationMxn }
            : s);
        }
      } catch { /* seguimos intentando */ }
    }, 10_000);
    return () => clearInterval(t);
  }, [stage.kind === 'tracking' ? stage.orderId : null, userToken]);

  if (stage.kind === 'tracking') {
    const title = stage.status === 'completed'
      ? 'Tu retiro llegó'
      : stage.status === 'failed' || stage.status === 'refunded' || stage.status === 'canceled'
        ? 'El retiro no se completo'
        : 'Procesando tu retiro';
    const detail = stage.status === 'completed'
      ? `$${stage.destinationMxn ?? '--'} MXN a tu cuenta ${clabeMasked ?? ''}`
      : `Estado: ${stage.status}`;
    return (
      <section className="p-4 border-2 border-tinta bg-amarillo">
        <h2 className="font-bold mb-2">{title}</h2>
        <p>{detail}</p>
      </section>
    );
  }

  return (
    <section className="p-4 border-2 border-tinta bg-crema flex flex-col gap-4">
      <h2 className="font-bold">Retirar a {clabeMasked ?? 'tu cuenta'}</h2>

      <label className="flex flex-col gap-1">
        <span className="font-bold">Monto en USDC</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          className="border-2 border-tinta p-2 bg-white"
          placeholder="0.00"
          disabled={stage.kind !== 'idle'}
        />
      </label>

      {stage.kind === 'idle' && (
        <button
          type="button"
          onClick={requestQuote}
          disabled={!amountOk || busy}
          className="min-h-12 bg-tinta text-crema font-bold disabled:opacity-50"
        >
          {busy ? 'Cotizando…' : 'Cotizar'}
        </button>
      )}

      {stage.kind === 'quoted' && (
        <div className="flex flex-col gap-3 border-2 border-tinta p-3 bg-amarillo">
          <p>Te llegan <strong>${stage.quote.destinationAmount} MXN</strong></p>
          <p className="text-sm">Comisión {stage.quote.feeAmount} USDC ({stage.quote.feeBps / 100}%)</p>
          <p className="text-sm">
            {expired
              ? 'La cotización vencio; pide una nueva.'
              : `La cotizacion vence en ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}.`}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStage({ kind: 'idle' })}
              className="flex-1 min-h-12 border-2 border-tinta font-bold"
            >
              Cancelar
            </button>
            {expired ? (
              <button
                type="button"
                onClick={requestQuote}
                disabled={busy}
                className="flex-1 min-h-12 bg-tinta text-crema font-bold disabled:opacity-50"
              >
                Nueva cotización
              </button>
            ) : (
              <button
                type="button"
                onClick={confirmAndSign}
                disabled={busy}
                className="flex-1 min-h-12 bg-tinta text-crema font-bold disabled:opacity-50"
              >
                {busy ? 'Firmando…' : 'Confirmar y firmar'}
              </button>
            )}
          </div>
        </div>
      )}

      {stage.kind === 'signing' && (
        <p className="text-sm">Firmando y enviando a la red…</p>
      )}

      {error && <p className="text-red-600 font-bold">{error}</p>}
    </section>
  );
}
