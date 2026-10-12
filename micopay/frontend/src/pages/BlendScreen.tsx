import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getBlendPools,
  blendSupply,
  blendBorrow,
  BlendPool,
  BlendTxResult,
  getUsdcMxnRate,
} from '../services/api';
import { extractApiErrorPayload } from '../utils/apiError';
import BetaBanner from '../components/BetaBanner';

interface BlendScreenProps {
  onBack: () => void;
  userToken?: string;
}

type MainTab = 'loan' | 'yield';

const BlendScreen = ({ onBack }: BlendScreenProps) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<MainTab>('loan');
  const [pools, setPools] = useState<BlendPool[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(true);

  // Loan tab state
  const [collateralAmount, setCollateralAmount] = useState('');
  const [collateralLoading, setCollateralLoading] = useState(false);
  const [collateralResult, setCollateralResult] = useState<BlendTxResult | null>(null);
  const [borrowAmount, setBorrowAmount] = useState('');
  const [borrowAsset, setBorrowAsset] = useState<'USDC'>('USDC');
  const [borrowLoading, setBorrowLoading] = useState(false);
  const [borrowResult, setBorrowResult] = useState<BlendTxResult | null>(null);

  // Yield tab state
  const [supplyAmount, setSupplyAmount] = useState('');
  const [supplyAsset, setSupplyAsset] = useState('XLM');
  const [supplyLoading, setSupplyLoading] = useState(false);
  const [supplyResult, setSupplyResult] = useState<BlendTxResult | null>(null);

  const [error, setError] = useState<string | null>(null);

  const [usdcMxnRate, setUsdcMxnRate] = useState<number | null>(null);

  useEffect(() => {
    getBlendPools()
      .then((data) => setPools(data.pools))
      .catch(() => {})
      .finally(() => setPoolsLoading(false));

    getUsdcMxnRate()
      .then(({ rate }) => setUsdcMxnRate(rate))
      .catch(() => setUsdcMxnRate(null));
  }, []);

  const mainPool = pools[0] ?? null;

  // Health factor mock: if no collateral deposited, show 0
  const xlmCollateral = collateralResult ? parseFloat(collateralResult.amount) : 0;
  const maxBorrow = xlmCollateral * 0.7 * 0.058; // 70% LTV, ~$0.058 per XLM in USDC
  // FX del backend; sin cotización el máximo en pesos no se muestra
  // (docs/AUDIT_MOBILE_MAINNET.md §3: nada de FX literal en el frontend).
  const maxBorrowMxn = usdcMxnRate != null ? maxBorrow * usdcMxnRate : null;
  const healthFactor = borrowResult
    ? (xlmCollateral * 0.058 * 1.1) / parseFloat(borrowResult.amount)
    : 999;

  const handleCollateral = async () => {
    if (!collateralAmount || parseFloat(collateralAmount) <= 0) return;
    setCollateralLoading(true);
    setError(null);
    try {
      const result = await blendSupply(collateralAmount, 'XLM', true);
      setCollateralResult(result);
    } catch (err: unknown) {
      setError(extractApiErrorPayload(err).message);
    } finally {
      setCollateralLoading(false);
    }
  };

  const handleBorrow = async () => {
    if (!borrowAmount || parseFloat(borrowAmount) <= 0) return;
    setBorrowLoading(true);
    setError(null);
    try {
      const result = await blendBorrow(borrowAmount, borrowAsset);
      setBorrowResult(result);
    } catch (err: unknown) {
      setError(extractApiErrorPayload(err).message);
    } finally {
      setBorrowLoading(false);
    }
  };

  const handleSupply = async () => {
    if (!supplyAmount || parseFloat(supplyAmount) <= 0) return;
    setSupplyLoading(true);
    setError(null);
    try {
      const result = await blendSupply(supplyAmount, supplyAsset, false);
      setSupplyResult(result);
    } catch (err: unknown) {
      setError(extractApiErrorPayload(err).message);
    } finally {
      setSupplyLoading(false);
    }
  };

  const shortHash = (h: string) => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-8)}` : h);

  const TxCard = ({ result }: { result: BlendTxResult }) => (
    <div className="bg-[#e6f9f1] border-2 border-tinta rounded-sm px-4 py-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-verde-claro text-xl">check_circle</span>
        <p className="font-bold text-verde-claro">
          {result.simulated ? '¡Prueba simulada!' : '¡Operación enviada!'}
        </p>
      </div>
      {result.simulated && (
        <p className="text-xs text-on-surface-variant">
          Demostración — no se movieron fondos reales on-chain.
        </p>
      )}
      <p className="text-xs text-on-surface-variant font-mono">{shortHash(result.hash)}</p>
      <a
        href={result.explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-primary font-bold"
      >
        Ver en el explorador Stellar
        <span className="material-symbols-outlined text-sm">open_in_new</span>
      </a>
    </div>
  );

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col pb-10">
      {/* Header */}
      <header className="fixed top-0 left-0 w-full z-50 flex items-center gap-4 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta">
        <button
          onClick={onBack}
          aria-label={t('a11y.back')}
          className="min-h-12 min-w-12 flex items-center justify-center rounded-sm hover:bg-surface-container-low transition-colors"
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <div>
          <h1 className="font-headline font-bold text-lg leading-tight">Blend Capital</h1>
          <p className="text-[11px] text-on-surface-variant">Protocolo financiero en Stellar</p>
        </div>
        <div className="ml-auto bg-on-surface/5 border-2 border-tinta rounded-full px-3 py-1">
          <span className="text-on-surface font-bold text-xs">
            TVL ${((mainPool?.tvl ?? 2_450_000) / 1_000_000).toFixed(2)}M
          </span>
        </div>
      </header>

      <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-4 pt-4 space-y-5">
        {/* Antes del saldo, a proposito: la cifra se lee como real. */}
        <BetaBanner className="-mx-4 mb-6" />
        {/* Main tabs */}
        <div className="flex gap-2 bg-surface-container-low rounded-sm p-1">
          <button
            onClick={() => { setTab('loan'); setError(null); }}
            className={`flex-1 min-h-12 py-2.5 rounded-sm font-bold text-sm transition-all ${
              tab === 'loan' ? 'bg-papel text-on-surface ' : 'text-on-surface-variant'
            }`}
          >
            Préstamo
          </button>
          <button
            onClick={() => { setTab('yield'); setError(null); }}
            className={`flex-1 min-h-12 py-2.5 rounded-sm font-bold text-sm transition-all ${
              tab === 'yield' ? 'bg-papel text-primary ' : 'text-on-surface-variant'
            }`}
          >
            Rendimiento
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-error/10 border border-error/20 rounded-sm px-4 py-3">
            <p className="text-sm text-error font-medium">{error}</p>
          </div>
        )}

        {/* ── LOAN TAB ── */}
        {tab === 'loan' && (
          <div className="space-y-4">
            {/* Step 1: Deposit collateral */}
            <div className="bg-papel rounded-sm p-5 border-2 border-tinta space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-primary rounded-sm flex items-center justify-center flex-shrink-0">
                  <span className="text-papel font-bold text-sm">1</span>
                </div>
                <div>
                  <p className="font-bold text-on-surface">Depositar garantía</p>
                  <p className="text-xs text-on-surface-variant">Usa XLM como colateral</p>
                </div>
                {collateralResult && (
                  <div className="ml-auto bg-verde-claro/10 rounded-full px-2 py-1">
                    <p className="text-xs font-bold text-verde-claro">
                      {collateralResult.amount} XLM
                    </p>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-2 uppercase tracking-wide">
                  Cantidad XLM
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={collateralAmount}
                  onChange={(e) => setCollateralAmount(e.target.value)}
                  className="w-full bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-xl font-bold focus:outline-none focus:border-primary transition-colors"
                />
              </div>

              {collateralAmount && parseFloat(collateralAmount) > 0 && (
                <div className="bg-primary/5 rounded-sm px-4 py-2 flex justify-between">
                  <span className="text-xs text-on-surface-variant">Capacidad de préstamo</span>
                  <span className="text-xs font-bold text-on-surface">
                    ~${(parseFloat(collateralAmount) * 0.058 * 0.7).toFixed(2)} USDC
                  </span>
                </div>
              )}

              {collateralResult && <TxCard result={collateralResult} />}

              <button
                onClick={handleCollateral}
                disabled={collateralLoading || !collateralAmount || parseFloat(collateralAmount) <= 0}
                className="w-full bg-on-surface text-papel font-bold py-3 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:translate-x-[2px] active:translate-y-[2px]"
              >
                {collateralLoading ? (
                  <>
                    <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                    Procesando…
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg">lock</span>
                    Depositar XLM como garantía
                  </>
                )}
              </button>
            </div>

            {/* Step 2: Borrow */}
            <div className="bg-papel rounded-sm p-5 border-2 border-tinta space-y-4">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-sm flex items-center justify-center flex-shrink-0 ${collateralResult ? 'bg-primary' : 'bg-outline'}`}>
                  <span className="text-papel font-bold text-sm">2</span>
                </div>
                <div>
                  <p className="font-bold text-on-surface">Pedir prestado</p>
                  <p className="text-xs text-on-surface-variant">
                    {collateralResult
                      ? `Máx ~${maxBorrow.toFixed(2)} ${borrowAsset}${maxBorrowMxn != null ? ` (~$${maxBorrowMxn.toFixed(0)} MXN)` : ''}`
                      : 'Deposita garantía primero'}
                  </p>
                </div>
              </div>

              {/* Asset selector */}
              <div className="flex gap-2">
                {(['USDC'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setBorrowAsset(a)}
                    className={`flex-1 min-h-12 py-2 rounded-sm font-bold text-sm border transition-all ${
                      borrowAsset === a
                        ? 'bg-primary text-papel border-primary'
                        : 'bg-papel text-on-surface-variant border-linea'
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>

              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={borrowAmount}
                onChange={(e) => setBorrowAmount(e.target.value)}
                disabled={!collateralResult}
                className="w-full bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-xl font-bold focus:outline-none focus:border-primary transition-colors disabled:opacity-40"
              />

              {/* Health factor */}
              {collateralResult && borrowAmount && parseFloat(borrowAmount) > 0 && (
                <div className="bg-surface-container-low rounded-sm px-4 py-2 flex justify-between">
                  <span className="text-xs text-on-surface-variant">Health Factor</span>
                  <span className={`text-xs font-bold ${healthFactor > 1.5 ? 'text-verde-claro' : healthFactor > 1.0 ? 'text-aviso-texto' : 'text-error'}`}>
                    {healthFactor > 99 ? '∞' : healthFactor.toFixed(2)}
                  </span>
                </div>
              )}

              {borrowResult && <TxCard result={borrowResult} />}

              <button
                onClick={handleBorrow}
                disabled={borrowLoading || !borrowAmount || parseFloat(borrowAmount) <= 0 || !collateralResult}
                className="w-full bg-primary text-papel font-bold py-3 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:translate-x-[2px] active:translate-y-[2px]"
              >
                {borrowLoading ? (
                  <>
                    <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                    Procesando…
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg">payments</span>
                    Pedir prestado
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ── YIELD TAB ── */}
        {tab === 'yield' && (
          <div className="space-y-4">
            {/* Pool cards */}
            {poolsLoading ? (
              <div className="flex justify-center py-8">
                <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
              </div>
            ) : mainPool ? (
              <div className="space-y-3">
                {mainPool.assets.map((asset) => (
                  <div
                    key={asset.code}
                    className="bg-papel rounded-sm p-4 border-2 border-tinta "
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-primary/10 rounded-sm flex items-center justify-center">
                          <span className="material-symbols-outlined text-primary text-lg">
                            {/* `currency_peso` no existe en Material Symbols: se
                                renderizaba como el texto crudo. `payments` si
                                existe y es el que usa el resto de la app para
                                pesos. */}
                            {asset.code === 'XLM' ? 'star' : asset.code === 'USDC' ? 'attach_money' : 'payments'}
                          </span>
                        </div>
                        <p className="font-bold text-on-surface">{asset.code}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-extrabold text-primary text-lg">{asset.supplyApy}%</p>
                        <p className="text-[10px] text-on-surface-variant">APY supply</p>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs text-on-surface-variant">
                      <span>Préstamo: <strong className="text-on-surface">{asset.borrowApy}%</strong></span>
                      <span>Liquidez: <strong className="text-on-surface">${(asset.liquidity / 1000).toFixed(0)}K</strong></span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-on-surface-variant text-sm py-8">No hay fondos disponibles</p>
            )}

            {/* Supply form */}
            <div className="bg-papel rounded-sm p-5 border-2 border-tinta space-y-4">
              <p className="font-bold text-on-surface">Depositar para ganar</p>

              {/* Asset selector */}
              <div className="flex gap-2">
                {(['XLM', 'USDC'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setSupplyAsset(a)}
                    className={`flex-1 min-h-12 py-2 rounded-sm font-bold text-sm border transition-all ${
                      supplyAsset === a
                        ? 'bg-primary text-papel border-primary'
                        : 'bg-papel text-on-surface-variant border-linea'
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>

              <input
                type="text"
                inputMode="decimal"
                placeholder="0.00"
                value={supplyAmount}
                onChange={(e) => setSupplyAmount(e.target.value)}
                className="w-full bg-surface-container-low border-2 border-tinta rounded-sm px-4 py-3 text-xl font-bold focus:outline-none focus:border-primary transition-colors"
              />

              {supplyAmount && parseFloat(supplyAmount) > 0 && mainPool && (
                <div className="bg-primary/5 rounded-sm px-4 py-2">
                  <p className="text-xs text-on-surface-variant">
                    Ganarás ~{(
                      (parseFloat(supplyAmount) *
                        (mainPool.assets.find((a) => a.code === supplyAsset)?.supplyApy ?? 4)) /
                      100
                    ).toFixed(4)} {supplyAsset} / año
                  </p>
                </div>
              )}

              {supplyResult && <TxCard result={supplyResult} />}

              <button
                onClick={handleSupply}
                disabled={supplyLoading || !supplyAmount || parseFloat(supplyAmount) <= 0}
                className="w-full bg-primary text-papel font-bold py-3 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 transition-all active:translate-x-[2px] active:translate-y-[2px]"
              >
                {supplyLoading ? (
                  <>
                    <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                    Procesando…
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-lg">savings</span>
                    Depositar y ganar
                  </>
                )}
              </button>
            </div>

            <p className="text-center text-xs text-gris pb-4">
              Blend Capital · Stellar Testnet · Las tasas son orientativas
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

export default BlendScreen;
