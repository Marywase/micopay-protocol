import { useState, useEffect, useCallback } from 'react';
import { Pill } from '../components/ui';
import { useTranslation } from 'react-i18next';
import ErrorBanner from '../components/ErrorBanner';
import { getTradeHistory, getPaymentHistory, TradeHistoryItem, type PaymentHistoryItem } from '../services/api';
import { mapApiError, type MappedApiError } from '../utils/apiError';
import { buildTxUrl } from '../utils/stellarExplorer';

/** Renglon del historial: una operacion de efectivo o una transferencia de la red. */
type Row =
  | { kind: 'trade'; at: number; trade: TradeHistoryItem }
  | { kind: 'payment'; at: number; payment: PaymentHistoryItem };

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatAmount(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n) ? n.toLocaleString('es-MX', { maximumFractionDigits: 7 }) : amount;
}

const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  completed: { label: 'Completado', color: 'text-verde-claro', bg: 'bg-verde-claro/10' },
  locked:    { label: 'Bloqueado',  color: 'text-primary',   bg: 'bg-primary/10' },
  revealing: { label: 'Revelando',  color: 'text-primary',   bg: 'bg-primary/10' },
  pending:   { label: 'Pendiente',  color: 'text-gris',   bg: 'bg-outline/10' },
  cancelled: { label: 'Cancelado',  color: 'text-error',     bg: 'bg-error/10' },
  expired:   { label: 'Expirado',   color: 'text-gris',   bg: 'bg-outline/10' },
  refunded:  { label: 'Reembolsado', color: 'text-[#8b5cf6]', bg: 'bg-[#8b5cf6]/10' },
};

interface HistoryProps {
  onBack: () => void;
  onSelectTrade: (trade: TradeHistoryItem) => void;
  token: string | null;
}

const FILTERS = [
  { id: 'all', label: 'Todos' },
  { id: 'transfers', label: 'Transferencias' },
  { id: 'completed', label: 'Completados' },
  { id: 'cancelled', label: 'Cancelados' },
  { id: 'expired', label: 'Expirados' },
  { id: 'refunded', label: 'Reembolsados' },
];

const History = ({ onBack, onSelectTrade, token }: HistoryProps) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<MappedApiError | null>(null);
  const [paymentsFailed, setPaymentsFailed] = useState(false);

  const loadHistory = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setLoadError(null);
    setPaymentsFailed(false);
    const wantTrades = status !== 'transfers';
    const wantPayments = status === 'all' || status === 'transfers';
    Promise.allSettled([
      wantTrades ? getTradeHistory(token) : Promise.resolve([]),
      wantPayments ? getPaymentHistory(token) : Promise.resolve([]),
    ])
      .then(([tradesRes, paymentsRes]) => {
        // Las operaciones son lo principal: si fallan, se muestra el error.
        // Si solo fallan las transferencias, se avisa sin tapar lo demas.
        if (tradesRes.status === 'rejected') {
          setLoadError(mapApiError(tradesRes.reason));
          setRows([]);
          return;
        }
        if (paymentsRes.status === 'rejected') setPaymentsFailed(true);
        const trades = status === 'all' || status === 'transfers'
          ? tradesRes.value
          : tradesRes.value.filter((t) => t.status === status);
        const payments = paymentsRes.status === 'fulfilled' ? paymentsRes.value : [];
        const next: Row[] = [
          ...trades.map((trade): Row => ({ kind: 'trade', at: Date.parse(trade.created_at), trade })),
          ...payments.map((payment): Row => ({ kind: 'payment', at: Date.parse(payment.created_at), payment })),
        ];
        next.sort((a, b) => b.at - a.at);
        setRows(next);
      })
      .finally(() => setLoading(false));
  }, [token, status, page]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleFilterChange = (newStatus: string) => {
    setStatus(newStatus);
    setPage(1);
  };

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col">
      <header className="fixed top-0 left-0 w-full z-50 flex items-center px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-papel border-b-2 border-tinta">
        <button aria-label={t('a11y.back')} onClick={onBack} className="min-h-12 min-w-12 min-h-12 min-w-12 flex items-center justify-center rounded-sm transition-colors">
          <span className="material-symbols-outlined text-on-surface">arrow_back</span>
        </button>
        <h1 className="flex-1 text-center font-headline font-bold text-lg mr-10">Historial de Transacciones</h1>
      </header>

      <main className="flex-1 mt-[calc(5rem+env(safe-area-inset-top))] px-6 pb-24">
        {/* Status Filters */}
        <section className="flex gap-2 overflow-x-auto pb-4 no-scrollbar mb-4">
          {FILTERS.map((f) => (
            <Pill
              key={f.id}
              activa={status === f.id}
              onClick={() => handleFilterChange(f.id)}
            >
              {f.label}
            </Pill>
          ))}
        </section>

        {loadError ? (
          <ErrorBanner
            message={loadError.message}
            action={loadError.action}
            onRetry={loadHistory}
            onDismiss={() => setLoadError(null)}
            supportState="HISTORY"
            className="mb-4"
          />
        ) : null}

        {!loading && paymentsFailed ? (
          <p className="text-xs text-gris mb-4">
            No pudimos cargar tus transferencias de la red. Aparecerán al volver a abrir el historial.
          </p>
        ) : null}

        {/* Trade List */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 opacity-50">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-sm font-medium">Cargando historial...</p>
          </div>
        ) : loadError ? null : rows.length === 0 ? (
          <div className="bg-papel rounded-sm border-2 border-tinta p-12 text-center mt-10">
            <div className="w-16 h-16 bg-surface-container-low rounded-sm flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-gris text-3xl">history_toggle_off</span>
            </div>
            <h3 className="font-headline font-bold text-on-surface mb-2">Sin transacciones</h3>
            <p className="text-sm text-gris leading-relaxed max-w-[200px] mx-auto">
              No encontramos transacciones que coincidan con tu filtro actual.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {rows.map((row) => {
              if (row.kind === 'payment') return <PaymentRow key={`p-${row.payment.id}`} payment={row.payment} />;
              const trade = row.trade;
              const s = STATUS_LABEL[trade.status] || STATUS_LABEL.pending;
              const isCashIn = false;
              const date = new Date(trade.created_at).toLocaleDateString('es-MX', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
              });

              return (
                <div
                  key={trade.id}
                  onClick={() => onSelectTrade(trade)}
                  className="bg-papel rounded-sm p-4 border-2 border-tinta hover:transition-all active:translate-x-[2px] active:translate-y-[2px] cursor-pointer"
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-sm flex items-center justify-center flex-shrink-0 ${isCashIn ? 'bg-verde-claro/10' : 'bg-primary/10'}`}>
                      <span className={`material-symbols-outlined ${isCashIn ? 'text-verde-claro' : 'text-primary'}`}>
                        {isCashIn ? 'south_west' : 'north_east'}
                      </span>
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start mb-1">
                        <p className="font-bold text-on-surface text-sm truncate">
                          {trade.seller_id.slice(0, 8)}…
                        </p>
                        <p className="font-black text-on-surface text-sm">
                          ${trade.amount_mxn.toLocaleString('es-MX')} MXN
                        </p>
                      </div>
                      
                      <div className="flex justify-between items-center">
                        <p className="text-[11px] text-gris font-medium uppercase tracking-wider">{date}</p>
                        <span className={`px-2 py-0.5 rounded-sm text-[10px] font-black uppercase tracking-widest ${s.color} ${s.bg}`}>
                          {s.label}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {!loading && rows.length > 0 && (
          <div className="flex items-center justify-between mt-8">
            <button
              disabled={page === 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              className="flex items-center gap-2 px-4 py-2 rounded-sm border-2 border-tinta text-sm font-bold disabled:opacity-30 disabled:pointer-events-none hover:bg-surface-container-low transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-sm">chevron_left</span>
              Anterior
            </button>
            <span className="text-xs font-bold text-gris">Página {page}</span>
            <button
              disabled={rows.length < 10}
              onClick={() => setPage(p => p + 1)}
              className="flex items-center gap-2 px-4 py-2 rounded-sm border-2 border-tinta text-sm font-bold disabled:opacity-30 disabled:pointer-events-none hover:bg-surface-container-low transition-colors"
            >
              Siguiente
              <span aria-hidden="true" className="material-symbols-outlined text-sm">chevron_right</span>
            </button>
          </div>
        )}
      </main>
    </div>
  );
};

/** Transferencia de la red. Al tocarla se abre en el explorador. */
function PaymentRow({ payment }: { payment: PaymentHistoryItem }) {
  const incoming = payment.direction === 'in';
  const who = payment.counterparty_username ? `@${payment.counterparty_username}` : shortAddress(payment.counterparty);
  const date = new Date(payment.created_at).toLocaleDateString('es-MX', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
  return (
    <a
      href={buildTxUrl(payment.tx_hash)}
      target="_blank"
      rel="noopener noreferrer"
      className="block bg-papel rounded-sm p-4 border-2 border-tinta active:translate-x-[2px] active:translate-y-[2px]"
    >
      <div className="flex items-center gap-4">
        <div className={`w-12 h-12 rounded-sm flex items-center justify-center flex-shrink-0 ${incoming ? 'bg-verde-claro/10' : 'bg-primary/10'}`}>
          <span aria-hidden="true" className={`material-symbols-outlined ${incoming ? 'text-verde-claro' : 'text-primary'}`}>
            {incoming ? 'south_west' : 'north_east'}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start mb-1">
            <p className="font-bold text-on-surface text-sm truncate">
              {incoming ? 'De' : 'A'} {who}
            </p>
            <p className={`font-black text-sm ${incoming ? 'text-verde-claro' : 'text-on-surface'}`}>
              {incoming ? '+' : '−'}{formatAmount(payment.amount)} {payment.asset}
            </p>
          </div>
          <div className="flex justify-between items-center">
            <p className="text-[11px] text-gris font-medium uppercase tracking-wider">{date}</p>
            <span className="px-2 py-0.5 rounded-sm text-[10px] font-black uppercase tracking-widest text-gris bg-outline/10">
              {incoming ? 'Recibido' : 'Enviado'}
            </span>
          </div>
        </div>
      </div>
    </a>
  );
}

export default History;
