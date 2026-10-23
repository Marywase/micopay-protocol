import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import {
  getCETESRate,
  buyCETES,
  sellCETES,
  CETESRate,
  CETESTxResult,
  getMyProfile,
  UserProfile,
  RampQuote,
  RampOrder,
  getRampQuote,
  createRampOrder,
  regenerateRampOrderTx,
  getRampOrderStatus,
  getUsdcMxnRate,
} from '../services/api';
import { sendCETESToEtherfuse } from '../services/stellarRamp';
import { buildTxUrl } from '../utils/stellarExplorer';
import { extractApiErrorPayload } from '../utils/apiError';
import BetaBanner from '../components/BetaBanner';

interface CETESScreenProps {
  onBack: () => void;
  onBanco?: () => void;
  userToken?: string;
  showDefi?: boolean;
  showSpeiRamp?: boolean;
}

type Tab = 'buy' | 'sell';
type SourceAsset = 'XLM' | 'USDC';
type ReceiveMethod = 'wallet' | 'spei';
type PayMethod = 'wallet' | 'spei';
type DepositStep = 'quote' | 'instructions' | 'polling';

const CETESScreen = ({ onBack, onBanco, userToken, showDefi = true, showSpeiRamp = false }: CETESScreenProps) => {
  const { t } = useTranslation();
  // When SPEI ramp is enabled but DeFi trading is NOT, hide the simulated
  // buy/sell trading UI and force the SPEI onramp/offramp path. This isolates
  // real-funds SPEI flows from the platform-key-only DeFi simulation.
  const speiOnlyMode = showSpeiRamp && !showDefi;
  const [tab, setTab] = useState<Tab>(speiOnlyMode ? 'buy' : 'buy');
  const [receiveMethod, setReceiveMethod] = useState<ReceiveMethod>(speiOnlyMode ? 'spei' : 'wallet');
  const [payMethod, setPayMethod] = useState<PayMethod>(speiOnlyMode ? 'spei' : 'wallet');
  const [amount, setAmount] = useState('');
  const [sourceAsset, setSourceAsset] = useState<SourceAsset>('XLM');
  
  const [rate, setRate] = useState<CETESRate | null>(null);
  const [usdcMxnRate, setUsdcMxnRate] = useState<number | null>(null);
  const [rateLoading, setRateLoading] = useState(true);
  const [txLoading, setTxLoading] = useState(false);
  const [txResult, setTxResult] = useState<CETESTxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [quote, setQuote] = useState<RampQuote | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [rampOrderId, setRampOrderId] = useState<string | null>(null);
  const [orderState, setOrderState] = useState<string>('');
  const [depositStep, setDepositStep] = useState<DepositStep>('quote');
  const [depositOrder, setDepositOrder] = useState<RampOrder | null>(null);
  const [stellarTxHash, setStellarTxHash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getCETESRate()
      .then(setRate)
      .catch(() => {})
      .finally(() => setRateLoading(false));

    // FX del backend; sin él la vista previa muestra "—" en vez de un número
    // inventado (docs/AUDIT_MOBILE_MAINNET.md §3).
    getUsdcMxnRate()
      .then(({ rate: usdcMxn }) => setUsdcMxnRate(usdcMxn))
      .catch(() => setUsdcMxnRate(null));

    if (userToken) {
      getMyProfile(userToken).then(setProfile).catch(() => {});
    }
  }, [userToken]);

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
      return () => clearTimeout(timer);
    } else if (countdown === 0 && quote && !rampOrderId) {
      // Only expire quotes that haven't been turned into an order yet —
      // once an order exists the quote is locked server-side.
      setQuote(null);
      setError(t('cetes.quoteExpired'));
    }
  }, [countdown, quote, rampOrderId]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (rampOrderId && (orderState === 'pending' || orderState === 'funded') && userToken) {
      interval = setInterval(async () => {
        try {
          const o = await getRampOrderStatus(rampOrderId, userToken);
          setOrderState(o.status);
          if (o.stellarTxHash) setStellarTxHash(o.stellarTxHash);
          if (o.status === 'completed' || o.status === 'failed') {
            clearInterval(interval);
            setTxLoading(false);
          }
        } catch (e) {
          console.error(e);
        }
      }, 5000);
    }
    return () => clearInterval(interval);
  }, [rampOrderId, orderState, userToken]);

  const cetesPreview = (): string => {
    if (!amount || isNaN(parseFloat(amount))) return '—';
    const num = parseFloat(amount);
    const cesPriceMxn = rate?.cesPriceMxn;
    // Sin precio de CETES no hay conversión posible; sin FX tampoco, salvo que
    // el activo ya esté en pesos. Antes se rellenaban con 10 / 17.5 / 17.24.
    if (!cesPriceMxn) return '—';
    const needsFx = sourceAsset === 'XLM' || sourceAsset === 'USDC';
    if (needsFx && (usdcMxnRate == null || !rate?.xlmPerUsdc)) return '—';

    if (tab === 'buy') {
      if (sourceAsset === 'XLM') {
        const usdc = num / rate!.xlmPerUsdc!;
        return ((usdc * usdcMxnRate!) / cesPriceMxn).toFixed(2);
      }
      if (sourceAsset === 'USDC') {
        return ((num * usdcMxnRate!) / cesPriceMxn).toFixed(2);
      }
      return (num / cesPriceMxn).toFixed(2);
    } else {
      const mxn = num * cesPriceMxn;
      if (sourceAsset === 'XLM') {
        return ((mxn / usdcMxnRate!) * rate!.xlmPerUsdc!).toFixed(2);
      }
      if (sourceAsset === 'USDC') return (mxn / usdcMxnRate!).toFixed(2);
      return mxn.toFixed(2);
    }
  };

  const handleTx = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    setTxLoading(true);
    setError(null);
    setTxResult(null);
    try {
      const result =
        tab === 'buy'
          ? await buyCETES(amount, sourceAsset)
          : await sellCETES(amount, sourceAsset);
      setTxResult(result);
      setAmount('');
    } catch (err: unknown) {
      const payload = extractApiErrorPayload(err);
      setError(payload.error === 'CETES_BUY_DISABLED_ON_MAINNET' ? t('cetes.buyUnavailable') : payload.message);
    } finally {
      setTxLoading(false);
    }
  };

  const handleGetQuote = async () => {
    if (!amount || parseFloat(amount) <= 0 || !userToken) return;
    setTxLoading(true);
    setError(null);
    try {
      const q = await getRampQuote('offramp', amount, userToken);
      setQuote(q);
      setCountdown(120);
    } catch (err: unknown) {
      setError(extractApiErrorPayload(err).message);
    } finally {
      setTxLoading(false);
    }
  };

  const handleConfirmSPEI = async () => {
    if (!quote || !userToken || !rate?.cetesIssuer) {
      setError(t('cetes.incompleteInfo'));
      return;
    }

    setTxLoading(true);
    setError(null);

    try {
      let order = await createRampOrder(quote.quoteId, userToken);

      const executeTx = async (orderData: typeof order) => {
        if (!orderData.withdrawAnchorAccount || !orderData.withdrawMemo) {
          throw new Error('El agente no devolvió instrucciones de retiro válidas.');
        }
        return await sendCETESToEtherfuse(
          amount,
          orderData.withdrawAnchorAccount,
          orderData.withdrawMemo,
          rate.cetesIssuer
        );
      };

      let result;
      try {
        result = await executeTx(order);
      } catch (e: any) {
        if (e.message === 'tx_too_late') {
          order = await regenerateRampOrderTx(order.orderId, userToken);
          result = await executeTx(order);
        } else {
          throw e;
        }
      }

      setTxResult({
        hash: result.hash,
        status: 'success',
        simulated: false,
        amount,
        explorerUrl: result.explorerUrl
      });

      setRampOrderId(order.orderId);
      setOrderState('pending');
    } catch (err: unknown) {
      setError(extractApiErrorPayload(err).message);
      setTxLoading(false);
    }
  };

  // ── SPEI onramp (deposit MXN → receive CETES) ──

  const handleGetDepositQuote = async () => {
    if (!userToken) { setError(t('cetes.loginFirst')); return; }
    if (!amount || parseFloat(amount) <= 0) return;
    setTxLoading(true);
    setError(null);
    try {
      const q = await getRampQuote('onramp', amount, userToken);
      setQuote(q);
      setCountdown(120);
    } catch (err: unknown) {
      setError(extractApiErrorPayload(err).message);
    } finally {
      setTxLoading(false);
    }
  };

  const handleCreateDepositOrder = async () => {
    if (!quote || !userToken) return;
    setTxLoading(true);
    setError(null);
    try {
      // useAnchor=false: the user deposits fiat via SPEI, nothing is signed on-chain.
      const order = await createRampOrder(quote.quoteId, userToken, false);
      setDepositOrder(order);
      setRampOrderId(order.orderId);
      setDepositStep('instructions');
    } catch (err: unknown) {
      setError(extractApiErrorPayload(err).message);
    } finally {
      setTxLoading(false);
    }
  };

  const handleConfirmTransferred = () => {
    if (!rampOrderId) return;
    setDepositStep('polling');
    setOrderState('pending');
  };

  const handleResetDeposit = () => {
    setDepositStep('quote');
    setDepositOrder(null);
    setRampOrderId(null);
    setOrderState('');
    setStellarTxHash(null);
    setQuote(null);
    setAmount('');
    setError(null);
  };

  const handleCopyClabe = (clabe: string) => {
    navigator.clipboard.writeText(clabe).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shortHash = (h: string) => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h);
  const canUseSpei = profile?.kyc_status === 'approved' && !!profile?.clabe;
  // The onramp only needs approved KYC: the user deposits to Etherfuse's CLABE,
  // so no user CLABE is required (unlike the offramp payout above).
  const canDepositSpei = profile?.kyc_status === 'approved';

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col pb-10">
      <header className="fixed top-0 left-0 w-full z-50 flex items-center gap-4 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta">
        <button aria-label={t('a11y.back')} onClick={onBack} className="min-h-12 min-w-12 flex items-center justify-center rounded-sm hover:bg-surface-container-low transition-colors">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div>
          <h1 className="font-headline font-bold text-lg leading-tight">{t('cetes.title')}</h1>
          <p className="text-[11px] text-on-surface-variant">{t('cetes.subtitle')}</p>
        </div>
        <div className="ml-auto bg-primary/10 border border-primary/20 rounded-full px-3 py-1">
          <span className="num text-verde font-bold text-sm">{t('cetes.annual', { rate: rate?.apy ?? 5.6 })}</span>
        </div>
      </header>

      <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-4 pt-4 space-y-5">
        {/* Antes del saldo, a proposito: la cifra se lee como real. */}
        <BetaBanner className="-mx-4 mb-6" />
        <div className="rounded-sm p-5 border border-primary/10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-papel rounded-sm flex items-center justify-center ">
              <span className="material-symbols-outlined text-verde">trending_up</span>
            </div>
            <div>
              <p className="num font-bold text-on-surface text-base">{t('cetes.yieldRate')}</p>
              {rateLoading ? (
                <p className="text-xs text-gris">{t('cetes.loading')}</p>
              ) : (
                <p className="num text-xs text-on-surface-variant">{rate?.note}</p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-papel rounded-sm p-3 text-center">
              <p className="num text-2xl font-extrabold text-verde">{rate?.apy ?? 5.6}%</p>
              <p className="text-xs text-on-surface-variant mt-1">{t('cetes.annualYield')}</p>
            </div>
            <div className="bg-papel rounded-sm p-3 text-center">
              <p className="text-2xl font-extrabold text-on-surface">
                {rateLoading ? '…' : `${(rate?.apy ?? 5.6) / 12}`.slice(0, 4)}%
              </p>
              <p className="text-xs text-on-surface-variant mt-1">{t('cetes.monthlyYield')}</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 bg-surface-container-low rounded-sm p-1">
          {/* Always visible: hiding this in SPEI-only mode would make the
              'sell' tab (offramp) unreachable, not just the DeFi wallet path. */}
          <div className="flex gap-2">
            {(['buy', 'sell'] as Tab[]).map((tabOption) => (
              <button
                key={tabOption}
                onClick={() => { setTab(tabOption); setTxResult(null); setError(null); setQuote(null); setRampOrderId(null); setOrderState(''); setDepositOrder(null); setDepositStep('quote'); setStellarTxHash(null); }}
                className={`flex-1 min-h-12 py-2.5 rounded-sm font-bold text-sm transition-all ${
                  tab === tabOption ? 'bg-papel text-verde ' : 'text-on-surface-variant'
                }`}
              >
                {tabOption === 'buy' ? t('cetes.buy') : t('cetes.sell')}
              </button>
            ))}
          </div>

          {tab === 'buy' && canDepositSpei && showDefi && (
            <div className="flex gap-2 mt-1 px-1 pb-1">
              <button
                onClick={() => { setPayMethod('wallet'); setQuote(null); setTxResult(null); setError(null); setAmount(''); setRampOrderId(null); setOrderState(''); setDepositOrder(null); setDepositStep('quote'); setStellarTxHash(null); }}
                className={`flex-1 py-1.5 rounded-sm font-bold text-xs transition-all ${
                  payMethod === 'wallet' ? 'bg-papel text-verde border-2 border-tinta' : 'text-on-surface-variant'
                }`}
              >
                {t('cetes.payWithWallet')}
              </button>
              <button
                onClick={() => { setPayMethod('spei'); setQuote(null); setTxResult(null); setError(null); setAmount(''); setRampOrderId(null); setOrderState(''); setDepositOrder(null); setDepositStep('quote'); setStellarTxHash(null); }}
                className={`flex-1 py-1.5 rounded-sm font-bold text-xs transition-all ${
                  payMethod === 'spei' ? 'bg-papel text-verde border-2 border-tinta' : 'text-on-surface-variant'
                }`}
              >
                {t('cetes.payWithSpei')}
              </button>
            </div>
          )}

          {tab === 'sell' && (
            <div className="flex gap-2 mt-1 px-1 pb-1">
              {showDefi && (
                <button
                  onClick={() => { setReceiveMethod('wallet'); setQuote(null); setTxResult(null); setError(null); }}
                  className={`flex-1 py-1.5 rounded-sm font-bold text-xs transition-all ${
                    receiveMethod === 'wallet' ? 'bg-papel text-verde border-2 border-tinta' : 'text-on-surface-variant'
                  }`}
                >
                  {t('cetes.toWallet')}
                </button>
              )}
              {canUseSpei && (
                <button
                  onClick={() => { setReceiveMethod('spei'); setQuote(null); setTxResult(null); setError(null); setAmount(''); }}
                  className={`flex-1 py-1.5 rounded-sm font-bold text-xs transition-all ${
                    receiveMethod === 'spei' ? 'bg-papel text-verde border-2 border-tinta' : 'text-on-surface-variant'
                  }`}
                >
                  {t('cetes.toSpei')}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="bg-papel rounded-sm p-5 border-2 border-tinta space-y-4">

          {tab === 'buy' && payMethod === 'spei' ? (
            <>
              {depositStep === 'quote' && (
                <>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-primary/10 rounded-sm flex items-center justify-center flex-shrink-0">
                      <span className="material-symbols-outlined text-verde text-base">account_balance</span>
                    </div>
                    <div>
                      <p className="font-bold text-on-surface text-sm">{t('cetes.depositTitle')}</p>
                      <p className="text-xs text-on-surface-variant">{t('cetes.depositSubtitle')}</p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-on-surface-variant mb-2 uppercase tracking-wide">
                      {t('cetes.amountMxn')}
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => { setAmount(e.target.value); setQuote(null); setError(null); }}
                      disabled={txLoading}
                      className="w-full bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-xl font-bold text-on-surface focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
                    />
                  </div>

                  {quote && (
                    <div className="bg-primary/5 rounded-sm p-4 space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-on-surface-variant">{t('cetes.willReceive')}</span>
                        <span className="font-extrabold text-on-surface text-base">
                          {parseFloat(quote.destinationAmount).toFixed(4)} CETES
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="num text-xs text-on-surface-variant">{t('cetes.exchangeRate')}</span>
                        <span className="text-xs font-bold text-on-surface">
                          {t('cetes.depositRate', { rate: quote.exchangeRate })}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('cetes.quoteExpiresIn')}</span>
                        <span className={`text-xs font-bold ${countdown < 30 ? 'text-error' : 'text-verde-claro'}`}>
                          {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}
                        </span>
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="bg-error/10 border border-error/20 rounded-sm px-4 py-3">
                      <p className="text-sm text-error font-medium">{error}</p>
                    </div>
                  )}

                  {!quote ? (
                    <button
                      onClick={handleGetDepositQuote}
                      disabled={txLoading || !amount || parseFloat(amount) <= 0}
                      className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:translate-x-[2px] active:translate-y-[2px]"
                    >
                      {txLoading ? (
                        <><span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>{t('cetes.quoting')}</>
                      ) : (
                        <>{t('cetes.getQuote')} <span className="material-symbols-outlined text-lg">calculate</span></>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={handleCreateDepositOrder}
                      disabled={txLoading}
                      className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:translate-x-[2px] active:translate-y-[2px]"
                    >
                      {txLoading ? (
                        <><span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>{t('cetes.creatingOrder')}</>
                      ) : (
                        <>{t('cetes.continue')} <span className="material-symbols-outlined text-lg">arrow_forward</span></>
                      )}
                    </button>
                  )}
                </>
              )}

              {depositStep === 'instructions' && depositOrder && (
                <>
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-verde-claro/10 rounded-sm flex items-center justify-center flex-shrink-0">
                      <span className="material-symbols-outlined text-verde-claro text-base">send_money</span>
                    </div>
                    <div>
                      <p className="font-bold text-on-surface text-sm">{t('cetes.makeTransfer')}</p>
                      <p className="text-xs text-on-surface-variant">{t('cetes.useExactData')}</p>
                    </div>
                  </div>

                  <div className="bg-surface-container-low rounded-sm divide-y divide-linea">
                    <div className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wide mb-0.5">{t('cetes.clabeDest')}</p>
                        <p className="font-mono font-bold text-on-surface text-sm break-all">
                          {depositOrder.depositClabe ?? '—'}
                        </p>
                      </div>
                      {depositOrder.depositClabe && (
                        <button
                          onClick={() => handleCopyClabe(depositOrder.depositClabe!)}
                          className="flex-shrink-0 flex items-center gap-1 bg-primary/10 text-verde font-bold text-xs min-h-12 px-3 rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
                        >
                          <span className="material-symbols-outlined text-sm">{copied ? 'check' : 'content_copy'}</span>
                          {copied ? t('cetes.copiedLabel') : t('cetes.copy')}
                        </button>
                      )}
                    </div>
                    <div className="px-4 py-3">
                      <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wide mb-0.5">{t('cetes.bank')}</p>
                      <p className="font-bold text-on-surface text-sm">{depositOrder.depositBankName ?? '—'}</p>
                    </div>
                    <div className="px-4 py-3">
                      <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wide mb-0.5">{t('cetes.holder')}</p>
                      <p className="font-bold text-on-surface text-sm">{depositOrder.depositAccountHolder ?? '—'}</p>
                    </div>
                    <div className="px-4 py-3">
                      <p className="num text-[10px] font-bold text-on-surface-variant uppercase tracking-wide mb-0.5">{t('cetes.exactAmount')}</p>
                      <p className="font-extrabold text-on-surface text-base">
                        ${depositOrder.depositAmount ?? amount} MXN
                      </p>
                    </div>
                  </div>

                  {depositOrder.depositClabe && (
                    <div className="flex flex-col items-center gap-3 py-2">
                      <p className="text-xs font-bold text-on-surface-variant uppercase tracking-wide">{t('cetes.clabeQr')}</p>
                      <div className="p-3 bg-papel rounded-sm border-2 border-tinta ">
                        <QRCodeSVG value={depositOrder.depositClabe} size={160} level="M" />
                      </div>
                    </div>
                  )}

                  <div className="bg-amber-50 border border-amber-200 rounded-sm px-4 py-3 flex gap-2">
                    <span className="material-symbols-outlined text-amber-600 text-base flex-shrink-0 mt-0.5">info</span>
                    <p className="text-xs text-amber-800 font-medium leading-relaxed">
                      {t('cetes.transferNotice')}
                    </p>
                  </div>

                  <button
                    onClick={handleConfirmTransferred}
                    className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 transition-all active:translate-x-[2px] active:translate-y-[2px]"
                  >
                    {t('cetes.alreadyTransferred')}
                    <span className="material-symbols-outlined text-lg">schedule</span>
                  </button>
                </>
              )}

              {depositStep === 'polling' && (
                <>
                  {orderState === 'completed' && (
                    <>
                      <div className="flex flex-col items-center gap-3 py-4 text-center">
                        <div className="w-16 h-16 rounded-sm bg-verde-claro/10 flex items-center justify-center">
                          <span className="material-symbols-outlined text-verde-claro text-4xl">check_circle</span>
                        </div>
                        <p className="font-extrabold text-on-surface text-lg">{t('cetes.cetesCredited')}</p>
                        <p className="text-sm text-on-surface-variant">
                          {t('cetes.receivedCetesWallet', { amount: quote ? parseFloat(quote.destinationAmount).toFixed(4) : '—' })}
                        </p>
                        {stellarTxHash && (
                          <a
                            href={buildTxUrl(stellarTxHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-verde font-bold"
                          >
                            <span className="font-mono">{shortHash(stellarTxHash)}</span>
                            <span className="material-symbols-outlined text-sm">open_in_new</span>
                          </a>
                        )}
                      </div>
                      <button
                        onClick={handleResetDeposit}
                        className="w-full border border-primary text-verde font-bold py-3 rounded-sm transition-all active:translate-x-[2px] active:translate-y-[2px]"
                      >
                        {t('cetes.makeAnotherDeposit')}
                      </button>
                    </>
                  )}

                  {orderState === 'failed' && (
                    <>
                      <div className="flex flex-col items-center gap-3 py-4 text-center">
                        <div className="w-16 h-16 rounded-sm bg-error/10 flex items-center justify-center">
                          <span className="material-symbols-outlined text-error text-4xl">error</span>
                        </div>
                        <p className="font-extrabold text-on-surface text-lg">{t('cetes.depositError')}</p>
                        <p className="text-sm text-on-surface-variant">{t('cetes.depositErrorDetail')}</p>
                      </div>
                      <a
                        href="mailto:soporte@micopay.mx"
                        className="w-full flex items-center justify-center gap-2 border border-error text-error font-bold py-3 rounded-sm transition-all active:translate-x-[2px] active:translate-y-[2px]"
                      >
                        <span className="material-symbols-outlined text-base">mail</span>
                        {t('cetes.contactSupport')}
                      </a>
                      <button
                        onClick={handleResetDeposit}
                        className="w-full border-2 border-tinta text-on-surface-variant font-bold py-3 rounded-sm transition-all active:translate-x-[2px] active:translate-y-[2px]"
                      >
                        {t('cetes.tryAgain')}
                      </button>
                    </>
                  )}

                  {orderState !== 'completed' && orderState !== 'failed' && (
                    <>
                      <div className="flex flex-col items-center gap-4 py-6 text-center">
                        <div className="w-16 h-16 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                        <p className="font-bold text-on-surface text-base">{t('cetes.waitingTransfer')}</p>
                        <p className="text-sm text-on-surface-variant max-w-xs">{t('cetes.waitingTransferDetail')}</p>
                      </div>
                      <div className="bg-surface-container-low rounded-sm px-4 py-3 flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('cetes.orderLabel')}</span>
                        <span className="font-mono text-xs font-bold text-on-surface">{shortHash(rampOrderId ?? '')}</span>
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          ) : tab === 'sell' && receiveMethod === 'spei' ? (
            <>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-2 uppercase tracking-wide">
                  {t('cetes.sellAmountLabel')}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setQuote(null); }}
                  disabled={!!quote || txLoading || !!rampOrderId}
                  className="w-full bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-xl font-bold text-on-surface focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
                />
              </div>

              {quote && (
                <div className="bg-primary/5 rounded-sm px-4 py-3 flex flex-col items-center">
                  <span className="text-sm text-on-surface-variant">{t('cetes.willReceiveSpei')}</span>
                  <span className="num text-2xl font-extrabold text-verde">${parseFloat(quote.destinationAmount).toFixed(2)} MXN</span>
                  {!rampOrderId && (
                    <span className="text-xs text-error mt-2 font-bold">
                      {t('cetes.quoteExpires')} {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}
                    </span>
                  )}
                </div>
              )}

              {orderState && (
                <div className={`border rounded-sm px-4 py-3 space-y-2 text-center ${
                  orderState === 'refunded' ? 'bg-error/10 border-error/20' : 'bg-[#e6f9f1] border-[#1D9E75]/20'
                }`}>
                  {orderState === 'pending' && <p className="font-bold text-verde-claro">{t('cetes.sendingToEtherfuse')}</p>}
                  {orderState === 'funded' && <p className="font-bold text-verde-claro">{t('cetes.cetesReceivedProcessing')}</p>}
                  {orderState === 'completed' && <p className="font-bold text-verde-claro">{t('cetes.speiDeposited')}</p>}
                  {orderState === 'refunded' && <p className="font-bold text-error">{t('cetes.rejectedRefunded')}</p>}

                  {txResult && (
                    <a href={txResult.explorerUrl} target="_blank" rel="noopener noreferrer" className="flex justify-center items-center gap-1 text-xs text-verde font-bold">
                      {t('cetes.viewOnchain')} <span className="material-symbols-outlined text-sm">open_in_new</span>
                    </a>
                  )}
                </div>
              )}

              {error && (
                <div className="bg-error/10 border border-error/20 rounded-sm px-4 py-3">
                  <p className="text-sm text-error font-medium">{error}</p>
                </div>
              )}

              {!quote && !rampOrderId ? (
                <button
                  onClick={handleGetQuote}
                  disabled={txLoading || !amount || parseFloat(amount) <= 0}
                  className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
                >
                  {txLoading ? t('cetes.quoting') : t('cetes.quoteWithdrawal')}
                </button>
              ) : !rampOrderId ? (
                <button
                  onClick={handleConfirmSPEI}
                  disabled={txLoading}
                  className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
                >
                  {txLoading ? (
                    <>
                      <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                      {t('cetes.processingTx')}
                    </>
                  ) : t('cetes.confirmWithdrawal')}
                </button>
              ) : null}
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-2 uppercase tracking-wide">
                  {tab === 'buy' ? t('cetes.payWith') : t('cetes.receiveIn')}
                </label>
                <div className="flex gap-2">
                  {(['XLM', 'USDC'] as SourceAsset[]).map((a) => (
                    <button
                      key={a}
                      onClick={() => setSourceAsset(a)}
                      className={`flex-1 min-h-12 py-2 rounded-sm font-bold text-sm border transition-all ${
                        sourceAsset === a
                          ? 'bg-verde text-papel border-primary'
                          : 'bg-papel text-on-surface-variant border-linea'
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-2 uppercase tracking-wide">
                  {tab === 'buy' ? t('cetes.amountIn', { asset: sourceAsset }) : t('cetes.amountInCetes')}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-xl font-bold text-on-surface focus:outline-none focus:border-primary transition-colors"
                />
              </div>

              {amount && parseFloat(amount) > 0 && (
                <div className="bg-primary/5 rounded-sm px-4 py-3 flex justify-between items-center">
                  <span className="text-sm text-on-surface-variant">
                    {t('cetes.willReceive')}
                  </span>
                  <span className="font-bold text-on-surface">
                    {cetesPreview()} {tab === 'buy' ? 'CETES' : sourceAsset}
                  </span>
                </div>
              )}

              {error && (
                <div className="bg-error/10 border border-error/20 rounded-sm px-4 py-3">
                  <p className="text-sm text-error font-medium">{error}</p>
                </div>
              )}

              {txResult && (
                <div className="bg-[#e6f9f1] border-2 border-tinta rounded-sm px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-verde-claro text-xl">check_circle</span>
                    <p className="font-bold text-verde-claro">
                      {txResult.simulated ? t('cetes.simulatedSuccess') : t('cetes.txSent')}
                    </p>
                  </div>
                  <p className="text-xs text-on-surface-variant">
                    Hash: <span className="font-mono">{shortHash(txResult.hash)}</span>
                  </p>
                  {txResult.cetesReceived && (
                    <p className="text-sm font-bold text-on-surface">
                      {t('cetes.creditedCetes', { amount: txResult.cetesReceived })}
                    </p>
                  )}
                  <a
                    href={txResult.explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-verde font-bold"
                  >
                    {t('cetes.viewOnStellarExplorer')}
                    <span className="material-symbols-outlined text-sm">open_in_new</span>
                  </a>
                </div>
              )}

              <button
                onClick={handleTx}
                disabled={txLoading || !amount || parseFloat(amount) <= 0}
                className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:translate-x-[2px] active:translate-y-[2px]"
              >
                {txLoading ? (
                  <>
                    <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                    {t('cetes.processing')}
                  </>
                ) : tab === 'buy' ? (
                  <>
                    {t('cetes.buy')}
                    <span className="material-symbols-outlined text-lg">arrow_forward</span>
                  </>
                ) : (
                  <>
                    {t('cetes.sell')}
                    <span className="material-symbols-outlined text-lg">swap_horiz</span>
                  </>
                )}
              </button>
            </>
          )}
        </div>

        {/* "¿Sin cripto?" — entry point to the real Etherfuse SPEI ramp built into
            this screen (payMethod === 'spei' above), not the P2P cash-agent
            network. If KYC is already approved, reveal that tab in place; if
            not, KYC is the actual prerequisite for connecting a bank via SPEI,
            so send the user there instead of the unrelated /deposit flow. */}
        {!(tab === 'buy' && payMethod === 'spei') && (
          <button
            onClick={() => {
              if (canDepositSpei) {
                setTab('buy');
                setPayMethod('spei');
              } else {
                onBanco?.();
              }
            }}
            className="w-full bg-papel border-2 border-tinta rounded-sm p-5 flex items-center gap-4 active:translate-x-[2px] active:translate-y-[2px] transition-all text-left"
          >
            <div className="w-10 h-10 bg-primary/10 rounded-sm flex items-center justify-center flex-shrink-0">
              <span className="material-symbols-outlined text-verde">account_balance_wallet</span>
            </div>
            <div className="flex-1">
              <p className="font-bold text-on-surface text-sm">{t('cetes.noCrypto')}</p>
              <p className="text-xs text-on-surface-variant">{t('cetes.connectBank')}</p>
            </div>
            <span className="material-symbols-outlined text-on-surface-variant">chevron_right</span>
          </button>
        )}

        <p className="text-center text-xs text-gris pb-4">
          {t('cetes.footer', { network: rate?.network ?? 'TESTNET' })}
        </p>
      </main>
    </div>
  );
};

export default CETESScreen;