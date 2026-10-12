import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SENDABLE_ASSETS, getAsset } from '../constants/assets';
import { useWalletBalance } from '../hooks/useWalletBalance';
import { useQRScanner } from '../hooks/useQRScanner';
import { sendPayment, isValidStellarAddress, PaymentError, type SendResult } from '../services/payment';
import { STELLAR_NETWORK_LABEL } from '../utils/stellarExplorer';

interface SendPaymentProps {
  onBack: () => void;
  onDone: () => void;
}

type Step = 'form' | 'review' | 'sending' | 'done' | 'error';

/** Extract a Stellar G-address from a raw scanned string (plain address, URI, or JSON). */
function extractAddress(raw: string): string {
  const trimmed = raw.trim();
  if (isValidStellarAddress(trimmed)) return trimmed;
  const m = trimmed.match(/G[A-Z2-7]{55}/);
  return m ? m[0] : trimmed;
}

const SendPayment = ({ onBack, onDone }: SendPaymentProps) => {
  const { t } = useTranslation();
  const { tokens, loading: balLoading } = useWalletBalance();
  const { scan } = useQRScanner();

  const [assetCode, setAssetCode] = useState('MEXe');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const asset = getAsset(assetCode)!;
  const available = useMemo(
    () => tokens.find((t) => t.code.toLowerCase() === assetCode.toLowerCase())?.balance ?? 0,
    [tokens, assetCode],
  );

  const amountNum = parseFloat(amount);
  const destValid = isValidStellarAddress(destination);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const overBalance = amountValid && amountNum > available;
  const canContinue = destValid && amountValid && !overBalance;

  const handleScan = async () => {
    setScanMsg(null);
    const res = await scan();
    if (res.value) {
      setDestination(extractAddress(res.value));
    } else if (res.error === 'scanner_unavailable') {
      setScanMsg(t('send.scannerUnavailable'));
    } else if (res.permState && res.permState !== 'granted') {
      setScanMsg(t('send.cameraPermission'));
    }
  };

  const handleSend = async () => {
    setStep('sending');
    setError(null);
    try {
      const r = await sendPayment({ destination, assetCode, amount, memo });
      setResult(r);
      setStep('done');
    } catch (e) {
      setError(e instanceof PaymentError ? e.message : 'No se pudo enviar el pago.');
      setStep('error');
    }
  };

  const reset = () => {
    setStep('form');
    setError(null);
    setResult(null);
  };

  // ── Result screens ──────────────────────────────────────────────────────────
  if (step === 'done' && result) {
    return (
      <ResultScreen
        ok
        title={t('send.successTitle')}
        subtitle={t('send.successSubtitle', { amount, asset: assetCode })}
        hashUrl={result.explorerUrl}
        explorerLabel={t('send.viewExplorer')}
        onPrimary={onDone}
        primaryLabel={t('send.done')}
      />
    );
  }
  if (step === 'error') {
    return (
      <ResultScreen
        ok={false}
        title={t('send.errorTitle')}
        subtitle={error ?? 'Error desconocido'}
        onPrimary={reset}
        primaryLabel={t('send.retry')}
        onSecondary={onBack}
        secondaryLabel={t('send.cancel')}
      />
    );
  }

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col">
      <header className="fixed top-0 left-0 w-full z-50 flex items-center gap-4 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta">
        <button
          onClick={step === 'review' ? () => setStep('form') : onBack}
          aria-label="Volver"
          className="min-h-12 min-w-12 flex items-center justify-center rounded-sm hover:bg-surface-container-low transition-colors"
        >
          <span className="material-symbols-outlined text-verde">arrow_back</span>
        </button>
        <h1 className="font-headline font-bold text-lg">{step === 'review' ? t('send.confirmTitle') : t('send.title')}</h1>
      </header>

      <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-6 pb-28 max-w-md mx-auto w-full space-y-6">
        {step === 'form' ? (
          <>
            {/* Asset selector */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-[0.15em] text-gris mb-2">{t('send.asset')}</label>
              <div className="grid grid-cols-4 gap-2">
                {SENDABLE_ASSETS.map((a) => (
                  <button
                    key={a.code}
                    onClick={() => setAssetCode(a.code)}
                    aria-pressed={assetCode === a.code}
                    className={`min-h-12 rounded-sm border-2 border-tinta font-bold text-sm transition-colors ${
                      assetCode === a.code ? 'bg-tinta text-papel' : 'bg-papel text-tinta'
                    }`}
                  >
                    {a.code}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-gris mt-2">
                {t('send.available')} <span className="font-bold text-on-surface">{balLoading ? '…' : available.toLocaleString('es-MX', { maximumFractionDigits: asset.decimals })} {asset.code}</span>
              </p>
            </div>

            {/* Destination */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-[0.15em] text-gris mb-2">{t('send.recipient')}</label>
              <div className="flex gap-2">
                <input
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder={t('send.recipientPlaceholder')}
                  spellCheck={false}
                  autoCapitalize="none"
                  className="flex-1 min-w-0 bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-sm font-mono focus:outline-none focus:border-primary transition-colors"
                />
                <button onClick={handleScan} aria-label="Escanear QR" className="w-12 flex-shrink-0 bg-primary/10 text-primary rounded-sm flex items-center justify-center active:translate-x-[2px] active:translate-y-[2px] transition-all">
                  <span className="material-symbols-outlined">qr_code_scanner</span>
                </button>
              </div>
              {destination && !destValid && <p className="text-[11px] text-error mt-1">{t('send.invalidAddress')}</p>}
              {scanMsg && <p className="text-[11px] text-gris mt-1">{scanMsg}</p>}
            </div>

            {/* Amount */}
            <div>
              <label className="num block text-[11px] font-bold uppercase tracking-[0.15em] text-gris mb-2">{t('send.amount')}</label>
              {/* No usa AmountField porque lleva el boton MÁX dentro del
                  campo; se aplica el mismo lenguaje a mano. type="text" con
                  inputMode decimal: el teclado numerico de algunos
                  fabricantes Android no trae punto decimal. */}
              <div className="relative flex min-h-14 items-center rounded-sm border-2 border-tinta bg-fondo pr-2">
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="num min-w-0 flex-1 border-none bg-transparent px-4 py-3 font-display text-[26px] font-bold text-tinta outline-none placeholder:text-gris-3"
                />
                <button
                  onClick={() => setAmount(String(available))}
                  className="min-h-12 shrink-0 rounded-sm border-2 border-tinta bg-papel px-3 text-xs font-bold text-tinta active:translate-x-[2px] active:translate-y-[2px]"
                >
                  MÁX
                </button>
              </div>
              {overBalance && <p className="num text-[11px] text-error mt-1">{t('send.insufficientBalance')}</p>}
            </div>

            {/* Memo */}
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-[0.15em] text-gris mb-2">{t('send.memo')}</label>
              <input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                maxLength={28}
                placeholder={t('send.memoPlaceholder')}
                className="w-full bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-sm focus:outline-none focus:border-primary transition-colors"
              />
            </div>

            <button
              onClick={() => setStep('review')}
              disabled={!canContinue}
              className="w-full h-[52px] bg-primary text-papel font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all disabled:opacity-40"
            >
              {t('send.continue')}
            </button>
          </>
        ) : (
          // ── Review step ───────────────────────────────────────────────────────
          <>
            <div className="bg-papel rounded-sm border-2 border-tinta p-6 space-y-4">
              <div className="text-center pb-2">
                <p className="text-[11px] font-bold uppercase tracking-[0.15em] text-gris">{t('send.youWillSend')}</p>
                <p className="num text-3xl font-display font-extrabold mt-1 text-verde">
                  {amountNum.toLocaleString('es-MX', { maximumFractionDigits: asset.decimals })} {asset.code}
                </p>
              </div>
              <div className="h-0.5 bg-linea" />
              <Row label={t('send.to')} value={`${destination.slice(0, 8)}…${destination.slice(-6)}`} mono />
              {memo.trim() && <Row label={t('send.note')} value={memo.trim()} />}
              <Row label={t('send.network')} value={t('send.networkName', { network: STELLAR_NETWORK_LABEL })} />
              <Row label={t('send.fee')} value={t('send.feeValue')} />
            </div>
            <p className="text-[11px] text-gris text-center px-4">
              {t('send.warning')}
            </p>
            <button
              onClick={handleSend}
              disabled={step === 'sending'}
              className="w-full h-[52px] bg-primary text-papel font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {step === 'sending' ? (
                <>
                  <span className="material-symbols-outlined animate-spin">progress_activity</span>
                  {t('send.sending')}
                </>
              ) : (
                t('send.confirmSend')
              )}
            </button>
          </>
        )}
      </main>
    </div>
  );
};

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-on-surface-variant">{label}</span>
      <span className={`text-sm font-bold text-on-surface text-right ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function ResultScreen({
  ok,
  title,
  subtitle,
  hashUrl,
  explorerLabel,
  onPrimary,
  primaryLabel,
  onSecondary,
  secondaryLabel,
}: {
  ok: boolean;
  title: string;
  subtitle: string;
  hashUrl?: string;
  explorerLabel?: string;
  onPrimary: () => void;
  primaryLabel: string;
  onSecondary?: () => void;
  secondaryLabel?: string;
}) {
  return (
    <div className="bg-surface min-h-screen flex flex-col items-center justify-center px-8 text-center font-body">
      <div className={`w-20 h-20 rounded-full flex items-center justify-center mb-6 ${ok ? 'bg-[#E1F5EE]' : 'bg-error/10'}`}>
        <span className={`material-symbols-outlined text-4xl ${ok ? 'text-verde-claro' : 'text-error'}`} style={{ fontVariationSettings: '"FILL" 1' }}>
          {ok ? 'check_circle' : 'error'}
        </span>
      </div>
      <h1 className="font-headline font-extrabold text-2xl text-on-surface mb-2">{title}</h1>
      <p className="text-on-surface-variant mb-8">{subtitle}</p>
      {hashUrl && (
        <a href={hashUrl} target="_blank" rel="noopener noreferrer" className="text-primary font-bold text-sm flex items-center gap-1 mb-8">
          {explorerLabel ?? 'Ver en el explorador'} <span className="material-symbols-outlined text-[18px]">open_in_new</span>
        </a>
      )}
      <button onClick={onPrimary} className="w-full max-w-xs h-[52px] bg-primary text-papel font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all">
        {primaryLabel}
      </button>
      {onSecondary && secondaryLabel && (
        <button onClick={onSecondary} className="mt-3 w-full max-w-xs h-[52px] text-on-surface-variant font-bold rounded-sm">
          {secondaryLabel}
        </button>
      )}
    </div>
  );
}

export default SendPayment;
