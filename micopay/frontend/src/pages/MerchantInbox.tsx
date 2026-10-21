import { useState, useEffect, useCallback } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQRScanner } from '../hooks/useQRScanner';
import { useCountdown } from '../hooks/useCountdown';
import {
  getMerchantTrades,
  merchantConfirmScan,
  completeTrade,
  type MerchantTrade,
  type MerchantConfirmResult,
} from '../services/api';
import { parseQRPayload } from '../utils/qrPayload';
import { confirmCashReceived, cashConfirmErrorMessage } from '../utils/cashConfirm';
import SupportLink from '../components/SupportLink';
import { Pill } from '../components/ui';
import { getPushPermission, requestPushPermission, type PushPermission } from '../lib/push';

// ── Status display config ──────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  locked: 'bg-blue-100 text-blue-800',
  revealing: 'bg-purple-100 text-purple-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-800',
  refunded: 'bg-gray-100 text-gray-800',
};

const STATUS_ICONS: Record<string, string> = {
  pending: 'hourglass_top',
  locked: 'lock',
  revealing: 'qr_code',
  completed: 'check_circle',
  cancelled: 'cancel',
  refunded: 'undo',
};

// ── Scan state machine ─────────────────────────────────────────────────────

type ScanView =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'parse_error'; message: string }
  | { type: 'api_error'; message: string; tradeId?: string }
  | { type: 'confirmation'; data: MerchantConfirmResult }
  | { type: 'cash_confirmed'; tradeId: string };

// ── Trade confirmation screen ──────────────────────────────────────────────

function TradeConfirmationCard({
  data,
  token,
  onReleased,
  onDismiss,
}: {
  data: MerchantConfirmResult;
  token: string | null;
  onReleased: (result: MerchantConfirmResult) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // CASH-4: el escaneo dejaba la operación a medias — confirmaba la entrega y
  // ahí terminaba, sin liberar el escrow. El proveedor entregaba efectivo y no
  // tenía cómo cobrarlo. Este estado gobierna ese último paso.
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const yaLiberado = data.status === 'completed' && !!data.release_tx_hash;
  // Solo el cash-out se cierra desde aquí: en depósito quien completa es el
  // cliente desde su propia pantalla.
  const puedeLiberar = data.flow === 'cashout' && !yaLiberado && !!token;

  const liberar = async () => {
    if (!token) return;
    setReleasing(true);
    setReleaseError(null);
    try {
      const { release_tx_hash } = await completeTrade(data.trade_id, token);
      // Éxito solo con un hash real persistido, nunca antes (criterio de #70).
      if (!release_tx_hash) {
        setReleaseError(t('inbox.releaseNoReceipt'));
        return;
      }
      onReleased({ ...data, status: 'completed', release_tx_hash });
    } catch (e) {
      // La entrega quedó registrada en el servidor, así que reintentar retoma
      // desde ahí: no hace falta volver a escanear ni entregar efectivo otra vez.
      setReleaseError(e instanceof Error ? e.message : t('inbox.releaseFailed'));
    } finally {
      setReleasing(false);
    }
  };
  const { label: countdownLabel, expired } = useCountdown(data.expires_at);
  const countdown = expired ? t('inbox.expired') : countdownLabel;
  const statusColor = STATUS_COLORS[data.status] || 'bg-gray-100 text-gray-800';
  const statusLabel = t(`home.status.${data.status}`, { defaultValue: data.status });
  const statusIcon = STATUS_ICONS[data.status] || 'info';

  return (
    <div className="bg-papel rounded-sm border border-emerald-200 overflow-hidden">
      {/* Header */}
      <div className="bg-emerald-50 px-5 py-4 flex items-center gap-3 border-b border-emerald-100">
        <div className="w-10 h-10 rounded-sm bg-emerald-100 flex items-center justify-center">
          <span
            className="material-symbols-outlined text-emerald-600"
            style={{ fontVariationSettings: '"FILL" 1' }}
          >
            verified
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm text-emerald-900">{t('inbox.qrVerified')}</p>
          <p className="text-xs text-emerald-700">{t('inbox.tradeConfirmed')}</p>
        </div>
        <button
          onClick={onDismiss}
          aria-label={t('a11y.close')}
          className="material-symbols-outlined text-emerald-600 text-base hover:bg-emerald-100 rounded-full p-1 transition-colors"
        >
          close
        </button>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        {/* Amount */}
        <div className="text-center">
          <p className="text-3xl font-extrabold text-on-surface">
            ${data.amount_mxn.toLocaleString('es-MX')}{' '}
            <span className="text-base font-medium text-gray-400">MXN</span>
          </p>
          {/* H5: el monto es el efectivo que cambia de mano. Lo que le importa
              al agente es su comision; la de plataforma la paga el cliente. */}
          {data.provider_fee_mxn !== undefined ? (
            <p className="text-xs text-gray-500 mt-1">
              {data.flow === 'cashout'
                ? t('inbox.cashToHand', { amount: data.amount_mxn, fee: data.provider_fee_mxn })
                : t('inbox.cashToReceive', { amount: data.amount_mxn, fee: data.provider_fee_mxn })}
            </p>
          ) : data.platform_fee_mxn > 0 ? (
            <p className="text-xs text-gray-500 mt-1">
              {t('inbox.platformFee', { amount: data.platform_fee_mxn })}
            </p>
          ) : null}
        </div>

        {/* Details */}
        <div className="bg-gray-50 rounded-sm p-4 space-y-3 text-sm">
          <div className="flex justify-between items-center">
            <span className="text-gray-500">{t('inbox.buyer')}</span>
            <span className="font-semibold text-on-surface">{data.client_handle}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">{t('inbox.status')}</span>
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${statusColor}`}
            >
              <span
                className="material-symbols-outlined text-xs"
                style={{ fontVariationSettings: '"FILL" 1' }}
              >
                {statusIcon}
              </span>
              {statusLabel}
            </span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">{t('inbox.expiresIn')}</span>
            <span className="font-semibold text-primary">{countdown}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-gray-500">{t('inbox.created')}</span>
            <span className="text-on-surface">
              {new Date(data.created_at).toLocaleString('es-MX', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </span>
          </div>
          {data.lock_tx_hash && (
            <div className="flex justify-between items-start">
              <span className="text-gray-500">{t('inbox.lockTx')}</span>
              <span className="font-mono text-xs text-primary break-all text-right max-w-[180px]">
                {data.lock_tx_hash.slice(0, 16)}…
              </span>
            </div>
          )}
          {data.release_tx_hash && (
            <div className="flex justify-between items-start">
              <span className="text-gray-500">{t('inbox.releaseTx')}</span>
              <span className="font-mono text-xs text-emerald-600 break-all text-right max-w-[180px]">
                {data.release_tx_hash.slice(0, 16)}…
              </span>
            </div>
          )}
          <div className="flex justify-between items-center">
            <span className="text-gray-500">{t('inbox.tradeId')}</span>
            <span className="font-mono text-xs text-gray-400">
              {data.trade_id.slice(0, 12)}…
            </span>
          </div>
        </div>

        {/* Security note */}
        <div className="bg-blue-50 border border-blue-100 rounded-sm p-3">
          <p className="text-xs text-blue-800 leading-relaxed">
            <Trans
              i18nKey="inbox.verifiedOnchain"
              components={{ strong: <span className="font-bold" /> }}
            />
          </p>
        </div>
      </div>

      {/* CASH-4: cierre del cash-out */}
      {puedeLiberar && (
        <div className="px-5 pb-4 space-y-2">
          {data.resumed && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-sm px-3 py-2">
              {t('inbox.resumedTrade')}
            </p>
          )}
          {releaseError && (
            <p role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-sm px-3 py-2">
              {releaseError}
            </p>
          )}
          <button
            onClick={liberar}
            disabled={releasing}
            className="w-full min-h-12 bg-naranja text-papel border-2 border-tinta shadow-solida font-bold py-3 rounded-sm transition-all active:translate-x-[3px] active:translate-y-[3px] active:shadow-solida-xs disabled:opacity-60"
          >
            {releasing ? t('inbox.releasing') : t('inbox.releaseFunds')}
          </button>
        </div>
      )}

      {yaLiberado && (
        <div className="px-5 pb-4">
          <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-sm px-3 py-2">
            {t('inbox.fundsReleased')}
          </p>
        </div>
      )}

      {/* Footer */}
      <div className="px-5 py-3 border-t border-gray-100 flex justify-center">
        <SupportLink state={data.status} tradeId={data.trade_id} />
      </div>
    </div>
  );
}

// ── Error card ─────────────────────────────────────────────────────────────

function ScanErrorCard({
  message,
  tradeId,
  onDismiss,
}: {
  message: string;
  tradeId?: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="bg-papel rounded-sm border border-red-200 overflow-hidden">
      <div className="bg-red-50 px-5 py-4 flex items-center gap-3 border-b border-red-100">
        <div className="w-10 h-10 rounded-sm bg-red-100 flex items-center justify-center">
          <span
            className="material-symbols-outlined text-red-600"
            style={{ fontVariationSettings: '"FILL" 1' }}
          >
            error
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm text-red-900">{t('inbox.qrVerificationError')}</p>
        </div>
        <button
          onClick={onDismiss}
          aria-label={t('a11y.close')}
          className="material-symbols-outlined text-red-600 text-base hover:bg-red-100 rounded-full p-1 transition-colors"
        >
          close
        </button>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-sm text-red-800 font-medium">{message}</p>
        {tradeId && (
          <p className="text-xs text-gray-400 font-mono">
            {t('inbox.tradeIdValue', { id: tradeId.slice(0, 12) })}
          </p>
        )}
        <div className="bg-amber-50 border border-amber-100 rounded-sm p-3">
          <p className="text-xs text-amber-800 leading-relaxed">
            {t('inbox.qrVerificationHint')}
          </p>
        </div>
      </div>
      <div className="px-5 py-3 border-t border-gray-100 flex justify-center">
        <SupportLink state="SCAN_ERROR" tradeId={tradeId} />
      </div>
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────────────────

interface MerchantInboxProps {
  token: string | null;
  onBack: () => void;
}

// ── Main component ─────────────────────────────────────────────────────────

const MerchantInbox = ({ token, onBack }: MerchantInboxProps) => {
  const { t } = useTranslation();
  const [trades, setTrades] = useState<MerchantTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [scanView, setScanView] = useState<ScanView>({ type: 'idle' });
  const { scan } = useQRScanner();

  // Con la app abierta Android no muestra el aviso: la bandeja se refresca
  // sola cada 30 s de todos modos. El aviso es para cuando esta cerrada.
  const [pushPermission, setPushPermission] = useState<PushPermission>('unsupported');
  useEffect(() => {
    getPushPermission().then(setPushPermission).catch(() => setPushPermission('unsupported'));
  }, []);
  const enableNotifications = useCallback(async () => {
    setPushPermission(await requestPushPermission());
  }, []);


  // ── Dismiss scan result ────────────────────────────────────────────────
  const dismissScan = useCallback(() => {
    setScanView({ type: 'idle' });
  }, []);

  // ── Fetch trades ───────────────────────────────────────────────────────
  const fetchTrades = useCallback(
    async (state: string = 'all') => {
      if (!token) return;
      setLoading(true);
      try {
        const result = await getMerchantTrades(token, state);
        setTrades(result);
      } catch (e) {
        console.error('Failed to fetch merchant trades', e);
      } finally {
        setLoading(false);
      }
    },
    [token],
  );

  const handleScan = useCallback(async () => {
    if (!token) return;
    const { value, error } = await scan();

    if (error) {
      setScanView({ type: 'parse_error', message: error });
      return;
    }

    // Parse the scanned QR into a typed MicoPay payload.
    const parsed = parseQRPayload(value);
    if (!parsed.ok) {
      setScanView({ type: 'parse_error', message: parsed.error });
      return;
    }

    // Depósito: el agente escanea el QR del cliente al recibir el efectivo.
    // El QR solo trae el trade_id; el servidor decide si a este agente le
    // toca confirmar (vendedor del escrow, operación en `locked`).
    if (parsed.payload.type === 'confirm') {
      const tradeId = parsed.payload.tradeId;
      setScanView({ type: 'loading' });
      try {
        await confirmCashReceived(tradeId, token);
        setScanView({ type: 'cash_confirmed', tradeId });
        fetchTrades(activeFilter).catch(() => {});
      } catch (e) {
        setScanView({ type: 'api_error', message: cashConfirmErrorMessage(e), tradeId });
      }
      return;
    }

    // Cash-out: the merchant scans the buyer's release QR: trade_id + a
    // one-time claim token. The HTLC preimage never travels in the QR (SEC-02).
    const release = parsed.payload.type === 'release' ? parsed.payload : null;

    if (!release) {
      setScanView({ type: 'parse_error', message: t('inbox.missingTradeId') });
      return;
    }

    const tradeId = release.tradeId;

    // Validate with backend.
    setScanView({ type: 'loading' });

    try {
      const result = await merchantConfirmScan(tradeId, release.claimToken, token);
      setScanView({ type: 'confirmation', data: result });
    } catch (e) {
      const message = e instanceof Error ? e.message : t('inbox.verificationFailed');
      setScanView({ type: 'api_error', message, tradeId });
    }
  }, [token, scan, activeFilter, fetchTrades, t]);

  // Main effect: fetch trades on filter change
  useEffect(() => {
    fetchTrades(activeFilter);
  }, [activeFilter, fetchTrades]);

  // Refresco mientras la bandeja esta a la vista, haya o no avisos: con la app
  // abierta el aviso no se muestra, y un aviso perdido no deja la lista vieja.
  useEffect(() => {
    if (!token) {
      return;
    }

    const pollInterval = setInterval(() => {
      // Only poll when the tab is visible
      if (document.visibilityState === 'visible') {
        fetchTrades(activeFilter).catch(() => {
          // Ignore polling errors silently
        });
      }
    }, 30_000); // Poll every 30 seconds

    return () => clearInterval(pollInterval);
  }, [token, activeFilter]);

  const filters = [
    { key: 'all', label: t('inbox.filterAll') },
    { key: 'pending', label: t('home.status.pending') },
    { key: 'locked', label: t('home.status.locked') },
    { key: 'revealing', label: t('home.status.revealing') },
    { key: 'completed', label: t('home.status.completed') },
  ];

  return (
    <div className="min-h-screen bg-fondo">
      <header className="border-b-2 border-tinta fixed top-0 left-0 w-full z-50 bg-papel px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] flex items-center gap-4">
        <button onClick={onBack} className="material-symbols-outlined text-verde min-h-12 min-w-12 flex items-center justify-center">
          arrow_back
        </button>
        <h1 className="font-headline font-bold text-lg flex-1">{t('inbox.title')}</h1>
        <button
          onClick={handleScan}
          aria-label={t('inbox.scanClientQr')}
          className="flex items-center gap-1 bg-primary text-papel min-h-12 px-3 rounded-sm text-xs font-bold active:translate-x-[2px] active:translate-y-[2px]"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-sm">
            qr_code_scanner
          </span>
          {t('inbox.scan')}
        </button>
      </header>

      <main className="pt-[calc(6rem+env(safe-area-inset-top))] px-6 pb-32">
        {/* Sin permiso de avisos: el agente no se entera con la app cerrada */}
        {(pushPermission === 'prompt' || pushPermission === 'denied') && token && (
          <div className="mb-4 rounded-sm p-4 bg-amber-50 border border-amber-200">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-amber-600">notifications_off</span>
              <div className="flex-1">
                <p className="text-sm text-amber-900 font-medium">
                  {t('inbox.pollBanner')}
                </p>
                {pushPermission === 'prompt' ? (
                  <p className="text-xs text-amber-800 mt-1">
                    <button type="button" onClick={() => { void enableNotifications(); }} className="underline inline-flex min-h-12 items-center font-bold">
                      {t('inbox.enableNotif')}
                    </button>
                  </p>
                ) : (
                  <p className="text-xs text-amber-800 mt-1">{t('inbox.notifDenied')}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {scanView.type === 'loading' && (
          <div className="mb-4 rounded-sm p-4 bg-emerald-50 border border-emerald-200 flex items-center gap-3">
            <span className="material-symbols-outlined animate-spin text-emerald-600">progress_activity</span>
            <p className="text-sm text-emerald-900 font-medium">{t('inbox.verifyingQr')}</p>
          </div>
        )}

        {scanView.type === 'parse_error' && (
          <div className="mb-4 rounded-sm p-4 bg-red-50 border border-red-200 flex items-start gap-3">
            <span className="material-symbols-outlined text-red-600">error</span>
            <p className="flex-1 text-sm text-red-800 font-medium">{scanView.message}</p>
            <button
              onClick={dismissScan}
              aria-label={t('a11y.close')}
              className="material-symbols-outlined text-on-surface-variant text-base"
            >
              close
            </button>
          </div>
        )}

        {scanView.type === 'api_error' && (
          <div className="mb-4 rounded-sm p-4 bg-red-50 border border-red-200">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-red-600">error</span>
              <p className="flex-1 text-sm text-red-800 font-medium">{scanView.message}</p>
              <button
                onClick={dismissScan}
                aria-label={t('a11y.close')}
                className="material-symbols-outlined text-on-surface-variant text-base"
              >
                close
              </button>
            </div>
            <div className="mt-2 pl-9">
              <SupportLink tradeId={scanView.tradeId} state="error_escaneo" />
            </div>
          </div>
        )}

        {scanView.type === 'cash_confirmed' && (
          <div
            role="status"
            className="mb-4 rounded-sm p-4 bg-emerald-50 border border-emerald-200 flex items-start gap-3"
          >
            <span className="material-symbols-outlined text-emerald-600" style={{ fontVariationSettings: '"FILL" 1' }}>
              task_alt
            </span>
            <div className="flex-1">
              <p className="font-bold text-sm text-emerald-900">{t('inbox.cashConfirmedTitle')}</p>
              <p className="text-xs text-emerald-700">
                {t('inbox.cashConfirmedDesc')}
              </p>
            </div>
            <button
              onClick={dismissScan}
              aria-label={t('a11y.close')}
              className="material-symbols-outlined text-on-surface-variant text-base"
            >
              close
            </button>
          </div>
        )}

        {scanView.type === 'confirmation' && (
          <div className="mb-4">
            <TradeConfirmationCard
              data={scanView.data}
              token={token}
              onReleased={(updated) => setScanView({ type: 'confirmation', data: updated })}
              onDismiss={dismissScan}
            />
          </div>
        )}

        {/* ── Filters ───────────────────────────────────────────────────── */}
        {/* Estos filtros eran chips propios: activo en verde y borde de 1 px.
            El estado activo del sistema es el cintillo de TINTA invertido
            (.pill[data-on]), no un relleno de color — es lo mismo que hace la
            pestaña activa de BottomNav. Ahora usan la primitiva. */}
        <div className="flex gap-2 mb-6 overflow-x-auto pb-2 -mx-6 px-6">
          {filters.map((f) => (
            <Pill
              key={f.key}
              activa={activeFilter === f.key}
              onClick={() => setActiveFilter(f.key)}
            >
              {f.label}
            </Pill>
          ))}
        </div>

        {/* ── Trade list ────────────────────────────────────────────────── */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          </div>
        ) : trades.length === 0 ? (
          /* §4.6: sin ilustración y sin icono gigante en gris de Tailwind, que
             además no era un gris del sistema. Queda la línea en --gris, que es
             la que dice qué falta. El cintillo se omite a propósito: el único
             texto disponible sería "Bandeja de entrada", que ya está en el
             encabezado, y el copy no se toca aquí (§7). */
          <div className="py-12">
            <p className="text-gris">{t('inbox.noTrades')}{activeFilter !== 'all' ? t('inbox.withStatus', { status: t(`home.status.${activeFilter}`) }) : ''}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {trades.map((trade) => (
              <div key={trade.id} className="bg-papel rounded-sm p-4 ">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <p className="font-medium text-on-surface">{trade.client_handle}</p>
                    {/* CASH-3: desde que la bandeja tambien trae los cash-out,
                        las dos clases de solicitud se veian identicas. Esta
                        linea dice lo unico que el proveedor necesita saber de
                        un vistazo: si va a recibir efectivo o a entregarlo. */}
                    <p className="text-sm text-gris">
                      {trade.flow === 'cashout' ? t('inbox.flowCashout') : t('inbox.flowDeposit')}
                    </p>
                    <p className="text-sm text-gray-500">
                      {new Date(trade.created_at).toLocaleDateString('es-MX')}
                    </p>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-medium ${
                      STATUS_COLORS[trade.status] || 'bg-gray-100'
                    }`}
                  >
                    {t(`home.status.${trade.status}`, { defaultValue: trade.status })}
                  </span>
                </div>
                <p className="num font-bold text-lg">${trade.amount_mxn} MXN</p>
                {trade.status === 'locked' && (
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-emerald-600">
                    <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>lock</span>
                    <span className="num font-medium">{t('inbox.locked', { amount: trade.amount_mxn.toLocaleString('es-MX') })}</span>
                  </div>
                )}
                {trade.status === 'pending' && (
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-amber-600">
                    <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>hourglass_top</span>
                    <span className="font-medium">{t('inbox.pending')}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default MerchantInbox;
