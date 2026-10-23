import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App as CapApp } from '@capacitor/app';

import { startKYC, getKYCStatus, type KYCProvider, type KYCStatus, type KYCStatusResponse } from '../services/api';
import { readJSON, writeJSON } from '../services/secureStorage';
import { extractApiErrorPayload } from '../utils/apiError';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROVIDER_NAMES: Record<KYCProvider, string> = {
  etherfuse: 'Etherfuse',
  didit: 'Didit',
};

// Cache key is per-provider so a Didit verification (#314/#315's tiered gate)
// and an Etherfuse verification (CETES-only) never clobber each other's
// cached status for the same user.
function secureStorageKey(provider: KYCProvider): string {
  return `kyc_status_${provider}`;
}

function StatusLine({ status }: { status: KYCStatus }) {
  const { t } = useTranslation();
  if (status === 'pending') {
    return (
      <div className="flex items-center gap-3 bg-primary/5 border border-primary/10 rounded-sm px-4 py-3">
        <span className="material-symbols-outlined text-verde">hourglass_top</span>
        <div>
          <p className="font-bold text-on-surface">{t('kyc.verifyingIdentity')}</p>
          <p className="text-xs text-on-surface-variant">{t('kyc.verifyingDesc')}</p>
        </div>
      </div>
    );
  }
  if (status === 'approved') {
    return (
      <div className="flex items-center gap-3 bg-verde-claro/10 border-2 border-tinta rounded-sm px-4 py-3">
        <span className="material-symbols-outlined text-verde-claro">check_circle</span>
        <div>
          <p className="font-bold text-on-surface">{t('kyc.identityVerified')}</p>
          <p className="text-xs text-on-surface-variant">{t('kyc.identityVerifiedDesc')}</p>
        </div>
      </div>
    );
  }
  // El backend tambien responde un estado de "nunca empezo" que no esta en
  // KYCStatus. Antes caia aqui y mostraba "No se pudo verificar" a quien ni
  // siquiera habia abierto la verificacion. Solo un rechazo real lo muestra.
  if (status !== 'rejected') return null;
  return (
    <div className="flex items-center gap-3 bg-error/10 border border-error/20 rounded-sm px-4 py-3">
      <span className="material-symbols-outlined text-error">error</span>
      <div>
        <p className="font-bold text-on-surface">{t('kyc.couldNotVerify')}</p>
        <p className="text-xs text-on-surface-variant">{t('kyc.couldNotVerifyDesc')}</p>
      </div>
    </div>
  );
}

type KYCScreenProps = {
  onApproved: () => void;
  token: string | null;
  /** Defaults to 'etherfuse' so the existing CETES onboarding call site is unaffected. */
  provider?: KYCProvider;
};

export default function KYCScreen({ onApproved, token, provider = 'etherfuse' }: KYCScreenProps) {
  const { t } = useTranslation();
  const providerName = PROVIDER_NAMES[provider];
  const [status, setStatus] = useState<KYCStatus>('pending');
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [startingToken, setStartingToken] = useState<string | null>(null);
  const startedAtRef = useRef<number | null>(null);

  const [statusPollingError, setStatusPollingError] = useState<string | null>(null);

  // Etherfuse's onboarding call now requires an email MicoPay's Stellar-keypair
  // auth never collects; POST /defi/kyc/start responds EMAIL_REQUIRED the first
  // time, and we prompt for it inline instead of failing silently.
  const [needsEmail, setNeedsEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);

  // Didit captura selfie y rostro: datos biometricos, sensibles segun la
  // LFPDPPP, que solo se tratan con consentimiento expreso. Sin la casilla
  // marcada no se abre el flujo de Didit.
  const needsBiometricConsent = provider === 'didit';
  const [biometricConsent, setBiometricConsent] = useState(false);
  const blockedByConsent = needsBiometricConsent && !biometricConsent;

  /**
   * KYC-1: la cache local mejora el arranque, pero NO decide.
   *
   * Antes esto llamaba a `onApproved()` con solo mirar el valor guardado, sin
   * preguntarle al servidor. Si el nivel habia expirado o se habia revocado,
   * la app seguia navegando como verificada. Ahora la cache solo pinta un
   * estado provisional; quien desbloquea es la respuesta del backend.
   */
  const loadCachedStatus = async () => {
    const cached = await readJSON<{ status: KYCStatus; reason?: string | null }>(secureStorageKey(provider));
    if (cached?.status === 'approved') {
      setStatus('approved');
      setReason(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      await loadCachedStatus();
      if (!token) return;
      try {
        const res = await getKYCStatus(token, provider);
        if (cancelled) return;
        // El servidor manda, tambien para desmentir a la cache.
        await applyStatus(res);
        if (res.status !== 'approved') {
          await writeJSON(secureStorageKey(provider), { status: res.status });
        }
      } catch {
        // Sin respuesta del servidor no se desbloquea nada: la cache se queda
        // como indicacion visual y el usuario puede reintentar.
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, provider]);

  const handleOpenHostedFlow = async (emailOverride?: string) => {
    if (blockedByConsent) return;
    if (!token) {
      setStatusPollingError(t('kyc.sessionError'));
      return;
    }
    setStatusPollingError(null);
    setReason(null);
    setLoading(true);

    try {
      const { onboardingUrl } = await startKYC(token, provider, emailOverride);
      setNeedsEmail(false);

      startedAtRef.current = Date.now();
      setStartingToken(onboardingUrl);
      setStatus('pending');

      // Open in system browser (preferred: Capacitor Browser plugin).
      // We lazy-load to avoid hard dependency on TS typings.
      try {
        const mod = await import('@capacitor/browser');
        const BrowserPlugin = (mod as any).Browser;
        if (BrowserPlugin?.open) {
          await BrowserPlugin.open({ url: onboardingUrl });
        } else {
          window.open(onboardingUrl, '_blank', 'noopener,noreferrer');
        }
      } catch {
        // Fallback for web builds / when plugin is not present.
        window.open(onboardingUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      // Previously uncaught: a failed startKYC() (e.g. Etherfuse rejecting the
      // request) silently opened nothing and left no trace for the user.
      const payload = extractApiErrorPayload(err);
      if (payload.error === 'EMAIL_REQUIRED') {
        setNeedsEmail(true);
      } else {
        setStatusPollingError(payload.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitEmail = () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setEmailError(t('kyc.emailInvalid'));
      return;
    }
    setEmailError(null);
    void handleOpenHostedFlow(trimmed);
  };

  const applyStatus = async (res: KYCStatusResponse) => {
    setStatus(res.status);
    setReason(res.reason ?? null);
    setStatusPollingError(null);

    if (res.status === 'approved') {
      await writeJSON(secureStorageKey(provider), { status: 'approved' });
      onApproved();
    }
  };

  const pollOnce = async () => {
    if (!token) return null;
    setStatusPollingError(null);
    try {
      const res = await getKYCStatus(token, provider);
      await applyStatus(res);
      return res;
    } catch (e: any) {
      const message = e?.message ?? t('kyc.pollError');
      setStatusPollingError(message);
      return null;
    }
  };

  useEffect(() => {
    if (!token) return;
    let intervalId: number | undefined;
    let cancelled = false;

    const startPolling = () => {
      intervalId = window.setInterval(async () => {
        if (cancelled) return;
        if (status !== 'pending') return;
        await pollOnce();
      }, 5000);
    };

    if (status === 'pending') {
      void pollOnce().then(() => {
        if (cancelled) return;
        startPolling();
      });
    }

    const sub = CapApp.addListener('appStateChange', (state) => {
      if (cancelled) return;
      if (state?.isActive && status === 'pending') {
        void pollOnce();
      }
    });

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
      (sub as any)?.remove?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, token]);

  if (!token) {
    return (
      <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <span className="material-symbols-outlined text-error text-4xl mb-3">lock</span>
        <h1 className="font-headline font-bold text-lg mb-2">{t('kyc.sessionNotAvailable')}</h1>
        <p className="text-sm text-on-surface-variant">
          {t('kyc.sessionNotAvailableDesc')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 bg-surface-container-lowest/80 border-b-2 border-tinta p-4">
        <div className="flex items-center gap-3">
          <button
            onClick={onApproved}
            className="min-h-12 min-w-12 flex items-center justify-center rounded-sm transition-colors text-verde"
            aria-label={t('kyc.continue')}
          >
            <span className="material-symbols-outlined">verified</span>
          </button>
          <div>
            <h1 className="font-headline font-bold text-lg">{t('kyc.identityVerification')}</h1>
            <p className="text-xs text-on-surface-variant">{t('kyc.oneStepWithProvider', { provider: providerName })}</p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-6 pb-8 pt-6">
        <section className="space-y-4">
          <div className="rounded-sm p-5 border border-primary/10">
            <h2 className="font-headline font-extrabold text-xl">{t('kyc.identityVerifiedWith', { provider: providerName })}</h2>
            <p className="text-sm text-on-surface-variant mt-2 leading-relaxed">
              {t('kyc.oneTimeProcess', { provider: providerName })}
            </p>
          </div>

          <StatusLine status={status} />

          {status === 'rejected' && reason && (
            <div className="bg-error/10 border border-error/20 rounded-sm px-4 py-3">
              <p className="text-sm font-bold text-error">{t('kyc.reason')}</p>
              <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">{reason}</p>
            </div>
          )}

          {statusPollingError && (
            <div className="bg-error/10 border border-error/20 rounded-sm px-4 py-3">
              <p className="text-sm font-bold text-error">{t('kyc.couldNotQuery')}</p>
              <p className="text-xs text-on-surface-variant mt-1 leading-relaxed">{statusPollingError}</p>
            </div>
          )}
        </section>

        <div className="mt-6 space-y-4">
          {needsBiometricConsent && status !== 'approved' && (
            <label className="flex items-start gap-3 bg-papel border-2 border-tinta rounded-sm p-4 cursor-pointer">
              <input
                type="checkbox"
                checked={biometricConsent}
                onChange={(e) => setBiometricConsent(e.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-verde"
              />
              <span className="text-xs text-on-surface leading-relaxed">
                {t('kyc.biometricConsent', { provider: providerName })}
              </span>
            </label>
          )}

          {needsEmail ? (
            <div className="bg-papel border-2 border-tinta rounded-sm p-5 space-y-3">
              <div>
                <p className="font-bold text-on-surface text-sm">{t('kyc.emailRequiredTitle')}</p>
                <p className="text-xs text-on-surface-variant mt-1">{t('kyc.emailRequiredDesc', { provider: providerName })}</p>
              </div>
              <input
                type="email"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setEmailError(null); }}
                placeholder={t('kyc.emailPlaceholder')}
                className="w-full rounded-sm border-2 border-tinta px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {emailError && <p className="text-xs text-error">{emailError}</p>}
              <button
                onClick={handleSubmitEmail}
                disabled={loading || !email.trim()}
                className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:translate-x-[2px] active:translate-y-[2px]"
              >
                {loading ? (
                  <>
                    <span className="material-symbols-outlined animate-spin">progress_activity</span>
                    {t('kyc.openingProvider', { provider: providerName })}
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined">verified_user</span>
                    {t('kyc.emailContinue')}
                  </>
                )}
              </button>
            </div>
          ) : (
            <button
              onClick={() => void handleOpenHostedFlow()}
              disabled={loading || blockedByConsent}
              className="w-full bg-verde text-papel font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 shadow-primary/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:translate-x-[2px] active:translate-y-[2px]"
            >
              {loading ? (
                <>
                  <span className="material-symbols-outlined animate-spin">progress_activity</span>
                  {t('kyc.openingProvider', { provider: providerName })}
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined">verified_user</span>
                  {t('kyc.verifyIdentity')}
                </>
              )}
            </button>
          )}

          {status === 'rejected' && (
            <button
              onClick={() => void handleOpenHostedFlow()}
              disabled={loading || blockedByConsent}
              className="w-full bg-papel border border-error/30 text-error font-bold py-3.5 rounded-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:translate-x-[2px] active:translate-y-[2px]"
            >
              <span className="material-symbols-outlined">refresh</span>
              {t('kyc.retryVerification')}
            </button>
          )}

          <p className="text-center text-xs text-gris pt-2">
            {t('kyc.sessionExpires')}
          </p>
        </div>
      </main>
    </div>
  );
}
