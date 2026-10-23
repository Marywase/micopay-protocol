import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Label, MoneyBlock } from '../components/ui';
import { Logo } from '../components/Logo';
import ErrorBanner from '../components/ErrorBanner';
import {
  getTradeHistory,
  getMerchantTrades,
  getXlmMxnRate,
  TradeHistoryItem,
  getCurrentUser,
} from '../services/api';
import { mapApiError, type MappedApiError } from '../utils/apiError';
import { useWalletBalance } from '../hooks/useWalletBalance';
import BetaBanner from '../components/BetaBanner';
import { getPendingSignatureRequests, SignatureRequest } from '../services/signRequestService';
import { STELLAR_NETWORK_LABEL } from '../utils/stellarExplorer';

const EXPLORER = "https://stellar.expert/explorer/testnet/tx";

/**
 * Cuantas operaciones se ven en Inicio. El resto vive en /history.
 *
 * Sin tope, la lista crecia indefinidamente y empujaba hacia abajo lo que
 * viniera despues — que era, precisamente, la accion principal del producto.
 */
const HOME_HISTORY_LIMIT = 4;

const STATUS_COLOR: Record<string, string> = {
  completed: "text-verde-claro",
  locked: "text-primary",
  revealing: "text-primary",
  pending: "text-gris",
  cancelled: "text-error",
  refunded: "text-gris",
};

interface HomeProps {
  onNavigateCashout: () => void;
  onNavigateDeposit: () => void;
  onNavigateHistory?: () => void;
  onNavigateBankWithdraw?: () => void;
  token: string | null;
  merchantToken: string | null;
  onNavigateInbox: () => void;
  username?: string | null;
}

const Home = ({
  onNavigateCashout,
  onNavigateDeposit,
  onNavigateHistory,
  onNavigateBankWithdraw,
  token,
  merchantToken,
  onNavigateInbox,
  username: usernameProp,
}: HomeProps) => {
  const [trades, setTrades] = useState<TradeHistoryItem[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [xlmMxnRate, setXlmMxnRate] = useState<number | null>(null);
  const [rateLoading, setRateLoading] = useState(true);
  const [rateError, setRateError] = useState(false);
  const [historyError, setHistoryError] = useState<MappedApiError | null>(null);
  const [pendingError, setPendingError] = useState<MappedApiError | null>(null);

  const {
    xlmBalance,
    stellarAddress: rawStellarAddress,
    loading: balanceLoading,
    error: walletBalanceError,
    refresh: loadBalance,
    tokens,
    usdMxnRate,
  } = useWalletBalance();

  const stellarAddress = rawStellarAddress || "";

  const [showBalanceError, setShowBalanceError] = useState(false);

  useEffect(() => {
    if (walletBalanceError) {
      setShowBalanceError(true);
    } else {
      setShowBalanceError(false);
    }
  }, [walletBalanceError]);

  const loadHistory = useCallback(() => {
    if (!token) return;
    setHistoryError(null);
    getTradeHistory(token)
      .then(setTrades)
      .catch((e) => {
        setHistoryError(mapApiError(e));
        setTrades([]);
      });
  }, [token]);

  const loadPendingCount = useCallback(() => {
    if (!merchantToken) return;
    setPendingError(null);
    getMerchantTrades(merchantToken, 'pending')
      .then((items) => setPendingCount(items.length))
      .catch((e) => setPendingError(mapApiError(e)));
  }, [merchantToken]);

  const [pendingSignRequests, setPendingSignRequests] = useState<SignatureRequest[]>([]);

  useEffect(() => {
    if (!token) return;
    getPendingSignatureRequests(token)
      .then((requests) => setPendingSignRequests(requests))
      .catch(() => setPendingSignRequests([]));
  }, [token]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    loadPendingCount();
  }, [loadPendingCount]);

  useEffect(() => {
    let cancelled = false;
    setRateLoading(true);
    setRateError(false);
    getXlmMxnRate()
      .then((data) => {
        if (!cancelled) {
          setXlmMxnRate(data.rate);
          setRateLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRateError(true);
          setRateLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const MXN_PEGGED = new Set(['CETES', 'GTOKEN', 'MXN']);

  // Sin cotización no se muestra un monto: un FX inventado sobre dinero real da
  // cifras equivocadas (docs/AUDIT_MOBILE_MAINNET.md §3).
  const ratesReady = xlmMxnRate != null && usdMxnRate != null && !rateError;

  const totalMxn = ratesReady
    ? tokens.reduce((sum, t) => {
        if (t.code === 'XLM') return sum + t.balance * xlmMxnRate!;
        if (t.code === 'USDC') return sum + t.balance * usdMxnRate!;
        if (MXN_PEGGED.has(t.code)) return sum + t.balance;
        return sum;
      }, 0)
    : null;

  const mxnBalance = balanceLoading || rateLoading || totalMxn == null
    ? "—"
    : `$${totalMxn.toLocaleString("es-MX", { maximumFractionDigits: 2 })} MXN`;

  // Per-asset MXN value for the XLM row (its own value, not the grand total).
  const rawXlm = tokens.find((t) => t.code === 'XLM')?.balance ?? 0;
  const xlmMxnValue = balanceLoading || rateLoading || rateError || xlmMxnRate == null
    ? "—"
    : `$${(rawXlm * xlmMxnRate).toLocaleString("es-MX", { maximumFractionDigits: 2 })} MXN`;

  /* Solo la primera letra. La clase `capitalize` de CSS sube la inicial de
     CADA palabra, y en es-MX eso imprimia "Jueves, 6 De Agosto". */
  const rawToday = new Date().toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const today = rawToday.charAt(0).toUpperCase() + rawToday.slice(1);

  const { t } = useTranslation();

  const [availability, setAvailabilityState] = useState<
    "online" | "offline" | "paused"
  >("online");

  const username = usernameProp || '';

  useEffect(() => {
    if (!merchantToken) return;
    getCurrentUser(merchantToken)
      .then((user) => {
        // KYC-1: era `user.verification_status`, campo inexistente, asi que
        // esto siempre caia en "offline". Lo que se quiere leer aqui es la
        // disponibilidad comercial, que si existe.
        const status = user.availability;
        // Y comparaba contra "verified", un valor que ese campo nunca tuvo.
        setAvailabilityState(
          status === "online"
            ? "online"
            : status === "paused"
              ? "paused"
              : "offline",
        );
      })
      .catch(() => {});
  }, [merchantToken]);

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col">
      {/* TopAppBar */}
      <header className="border-b-2 border-tinta fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel">
        <Logo />
        <div className="flex items-center gap-4">
          <button
            onClick={onNavigateInbox}
            aria-label={
              pendingCount > 0
                ? t('a11y.notificationsPending', { count: pendingCount })
                : t('a11y.notifications')
            }
            className="relative min-h-12 min-w-12 flex items-center justify-center rounded-sm transition-colors"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-verde min-h-12 min-w-12 flex items-center justify-center"
            >
              notifications
            </span>
            {pendingCount > 0 && (
              /* §4.5: cuadro de 18 dp con radio 2 px y borde de tinta, en
                 NARANJA, no un circulo rojo. Una notificacion pendiente aqui
                 casi siempre es "alguien quiere cobrarte o entregarte
                 efectivo" — es accion, y la accion es naranja. El rojo queda
                 para lo destructivo. */
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 h-[18px] min-w-[18px] rounded-sm border-[1.5px] border-tinta bg-naranja px-1 text-[10px] font-extrabold text-papel flex items-center justify-center num">
                {pendingCount}
              </span>
            )}
          </button>
          {/* Aqui habia un tile con la marca dibujada a mano en los hexes de la
              paleta anterior (#1A2830 / #1D9E75 / #00694C), sin handler: era el
              logo repetido a dos centimetros del logo. Fuera, por las dos
              razones del sistema — desaparece el tile de icono sobre el
              encabezado, y no quedan hexes de la paleta muerta. */}
        </div>
      </header>

      <main className="flex-1 mt-[5.5rem] px-6 pb-32" style={{ paddingTop: 'max(0px, env(safe-area-inset-top))' }}>
        {/* Antes del saldo, a proposito: la cifra se lee como real. */}
        <BetaBanner className="-mx-6 mb-6" />
        {availability === "paused" && (
          <div className="mb-6 bg-error/10 border border-error/20 rounded-sm p-4 flex items-center gap-3">
            <span className="material-symbols-outlined text-error">
              pause_circle
            </span>
            <div className="flex-1">
              <p className="text-sm font-bold text-error">
                {t('home.operationsPaused')}
              </p>
              <p className="text-[11px] text-error/80">
                {t('home.operationsPausedDesc')}
              </p>
            </div>
          </div>
        )}
        {/* Pending Signature Requests Banner */}
        {pendingSignRequests.length > 0 && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-700">
                <span className="material-symbols-outlined text-xl">gavel</span>
              </div>
              <div>
                <p className="text-sm font-bold text-amber-900">
                  {t('signatureApproval.externalRequestHeader')}
                </p>
                <p className="text-xs text-amber-700">
                  {pendingSignRequests.length} {t('signatureApproval.requestSourceLabel').toLowerCase()}
                </p>
              </div>
            </div>
            <a
              href={`/#/sign-request/${pendingSignRequests[0].id}`}
              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold transition-colors"
            >
              {t('signatureApproval.title')}
            </a>
          </div>
        )}

        {/* Saludo */}
        <section className="mb-8">
          <h1 className="font-headline font-extrabold text-3xl text-on-surface leading-tight mb-1">
            {t('home.greeting', { name: username || '...' })}
          </h1>
          <p className="text-on-surface-variant font-medium opacity-70">
            {today}
          </p>
        </section>

        {showBalanceError && walletBalanceError ? (
          <ErrorBanner
            message={walletBalanceError.message || "Error al cargar el balance"}
            action="retry"
            onRetry={loadBalance}
            onDismiss={() => setShowBalanceError(false)}
            supportState="HOME_BALANCE"
            className="mb-4"
          />
        ) : null}

        {/* Balance — el saldo es dinero DIGITAL, así que la cifra va en
            verde. El naranja queda reservado al efectivo por recibir: en el
            sitio las tres cifras naranjas son "Recibes...", ninguna es un
            saldo. Ver MoneyBlock.

            El pie lleva solo el estado transitorio: la red ya la dice la
            etiqueta ("VALOR TOTAL · STELLAR TESTNET"), y repetirla debajo
            imprimía "Stellar Testnet" dos veces en el mismo bloque. */}
        <MoneyBlock
          className="mb-8"
          onClick={loadBalance}
          etiqueta={t('home.totalValue', { network: STELLAR_NETWORK_LABEL.toUpperCase() })}
          cifra={balanceLoading ? t('home.loadingBalance') : walletBalanceError ? '--' : mxnBalance}
          pie={
            walletBalanceError
              ? t('home.notAvailable')
              : balanceLoading
                ? t('home.loadingBalanceStatus')
                : undefined
          }
        />

        {/* Activos */}
        {/* Red MicoPay · la accion principal del producto.
            Estaba al FINAL de la pantalla, despues del historial. Con historial
            cero ya quedaba fuera de la vista: habia que hacer scroll para
            encontrar la accion principal en una cuenta recien creada, y cada
            operacion nueva la empujaba mas abajo.
            El saldo responde "cuanto tengo" y aqui, justo debajo, va "que hago".
            Activos e historial son detalle y registro: van despues. */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <span className="num text-base" style={{ filter: 'grayscale(1) sepia(1) saturate(5) hue-rotate(-50deg) brightness(0.9)' }} aria-hidden="true">🍄</span>
          <span className="text-xs font-semibold text-on-surface-variant tracking-wide">
            Red Micopay
          </span>
        </div>

        {/* CTAs */}
        <div className="flex flex-col items-center gap-4 mb-8">
          <button
            onClick={onNavigateCashout}
            aria-label={t('home.cashout')}
            className="w-full h-[56px] bg-naranja text-papel border-2 border-tinta shadow-solida font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all duration-200 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              payments
            </span>
            {t('home.cashout')}
          </button>
          <button
            onClick={onNavigateDeposit}
            aria-label={t('home.deposit')}
            className="w-full h-[56px] bg-papel text-tinta border-2 border-tinta shadow-solida font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all duration-200 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              add_circle
            </span>
            {t('home.deposit')}
          </button>
          {onNavigateBankWithdraw && (
            <button
              onClick={onNavigateBankWithdraw}
              aria-label={t('home.bankWithdraw', { defaultValue: 'Retirar a banco' })}
              className="w-full h-[56px] bg-papel text-tinta border-2 border-tinta shadow-solida font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all duration-200 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <span aria-hidden="true" className="material-symbols-outlined">
                account_balance
              </span>
              {t('home.bankWithdraw', { defaultValue: 'Retirar a banco' })}
            </button>
          )}
          <p className="text-sm text-on-surface-variant font-medium opacity-60">
            {t('home.findNearby')}
          </p>
        </div>
        <section className="mb-8">
          <h2 className="mb-4"><Label>
            {t('home.assets')}
          </Label></h2>
          <div className="bg-papel rounded-sm border-2 border-tinta divide-y divide-linea">
            {/* XLM */}
            <div className="flex items-center gap-4 p-4">
              <div className="w-10 h-10 rounded-sm border-2 border-tinta bg-verde flex items-center justify-center flex-shrink-0">
                <span className="text-papel font-black text-sm">XLM</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-on-surface text-sm">
                  Stellar Lumens
                </p>
                <p className="text-[11px] text-gris truncate font-mono">
                  {stellarAddress
                    ? `${stellarAddress.substring(0, 8)}…${stellarAddress.slice(-6)}`
                    : "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold text-on-surface text-sm">
                  {xlmBalance ?? "—"} XLM
                </p>
                <p className="num text-[11px] text-gris">{xlmMxnValue}</p>
              </div>
            </div>
            {/* USDC */}
            <div className={`num flex items-center gap-4 p-4 ${balanceLoading ? 'opacity-40' : ''}`}>
              <div className="w-10 h-10 rounded-sm border-2 border-tinta bg-verde flex items-center justify-center flex-shrink-0">
                <span className="text-papel font-black text-xs">USDC</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-on-surface text-sm">
                  USD Coin
                </p>
                <p className="text-[11px] text-gris truncate font-mono">
                  {stellarAddress
                    ? `${stellarAddress.substring(0, 8)}…${stellarAddress.slice(-6)}`
                    : "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold text-on-surface text-sm">
                  {balanceLoading
                    ? "—"
                    : walletBalanceError
                      ? "--"
                      : `${(tokens.find((t) => t.code === 'USDC')?.balance ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`}
                </p>
              </div>
            </div>
          </div>
        </section>

        {pendingError ? (
          <ErrorBanner
            message={pendingError.message}
            action={pendingError.action}
            onRetry={loadPendingCount}
            onDismiss={() => setPendingError(null)}
            supportState="HOME_PENDING"
            className="mb-4"
          />
        ) : null}

        {/* Actividad */}
        <section className="mb-8">
          <h2 className="mb-4"><Label>
            {t('home.recentActivity')}
          </Label></h2>

          {historyError ? (
            <ErrorBanner
              message={historyError.message}
              action={historyError.action}
              onRetry={loadHistory}
              onDismiss={() => setHistoryError(null)}
              supportState="HOME_HISTORY"
            />
          ) : trades.length === 0 ? (
            <div className="bg-papel rounded-sm border-2 border-tinta p-6 text-center">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-gris text-3xl mb-2 block"
              >
                receipt_long
              </span>
              <p className="text-sm text-gris font-medium">
                {t('home.noTransactions')}
              </p>
            </div>
          ) : (
            <div className="bg-papel rounded-sm border-2 border-tinta divide-y divide-linea">
              {trades.slice(0, HOME_HISTORY_LIMIT).map((trade) => {
                const s = {
                  label: t(`home.status.${trade.status}`, { defaultValue: trade.status }),
                  color: STATUS_COLOR[trade.status] ?? "text-gris",
                };
                const date = new Date(trade.created_at).toLocaleString(
                  "es-MX",
                  {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                );
                return (
                  <div key={trade.id} className="p-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-sm bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <span
                            aria-hidden="true"
                            className="material-symbols-outlined text-primary text-base"
                          >
                            swap_horiz
                          </span>
                        </div>
                        <div>
                          <p className="font-bold text-on-surface text-sm">
                            ${trade.amount_mxn.toLocaleString("es-MX")} MXN
                          </p>
                          <p className="text-[11px] text-gris">{date}</p>
                        </div>
                      </div>
                      <span className={`text-[11px] font-bold ${s.color}`}>
                        {s.label}
                      </span>
                    </div>

                    {/* TX links */}
                    <div className="flex flex-col gap-1 pl-12">
                      {trade.lock_tx_hash &&
                        !trade.lock_tx_hash.startsWith("mock") && (
                          <a
                            href={`${EXPLORER}/${trade.lock_tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-primary font-mono flex items-center gap-1 hover:underline"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[12px]"
                            >
                              lock
                            </span>
                            lock · {trade.lock_tx_hash.substring(0, 14)}…
                          </a>
                        )}
                      {trade.release_tx_hash &&
                        !trade.release_tx_hash.startsWith("mock") && (
                          <a
                            href={`${EXPLORER}/${trade.release_tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-verde-claro font-mono flex items-center gap-1 hover:underline"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[12px]"
                            >
                              lock_open
                            </span>
                            release · {trade.release_tx_hash.substring(0, 14)}…
                          </a>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* El historial completo vive en su propia pantalla. El boton tiene
              que aparecer siempre que haya a donde ir: en /history esta la
              pestana "Transferencias", que no tiene nada que ver con los
              trades listados aqui. Antes lo escondiamos cuando habia 4 o
              menos trades, pero eso dejaba el pantalla de transferencias
              inaccesible para usuarios nuevos. */}
          {onNavigateHistory && (
            <button
              onClick={onNavigateHistory}
              className="mt-4 w-full min-h-12 border-2 border-tinta text-tinta font-bold rounded-sm active:translate-x-[2px] active:translate-y-[2px] transition-all"
            >
              {t('home.seeAllActivity', { defaultValue: 'Ver todo el historial' })}
            </button>
          )}
        </section>

      </main>
    </div>
  );
};

export default Home;
