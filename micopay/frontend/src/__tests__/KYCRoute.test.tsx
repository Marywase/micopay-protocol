import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { KYCRoute, DiditKYCRoute, ProviderOnboardingRoute, AppContext, type AppCtx } from '../App';
import * as api from '../services/api';
import * as secureStorage from '../services/secureStorage';

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })),
  },
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

// Estas pruebas son del build interno, con CETES abierto. El build de Play
// (CETES cerrado) se prueba al final: ahi el KYC vuelve al inicio.
const features = vi.hoisted(() => ({ cetes: true }));
vi.mock('../constants/features', () => ({
  get CETES_AVAILABLE() { return features.cetes; },
  get BLEND_AVAILABLE() { return features.cetes; },
  get DEFI_TRADING_ENABLED() { return features.cetes; },
  SPEI_RAMP_ENABLED: false,
}));

vi.mock('../services/api', () => ({
  startKYC: vi.fn(),
  getKYCStatus: vi.fn(),
}));

// El onboarding real consulta al servidor; aquí solo importa su botón de KYC.
vi.mock('../pages/ProviderOnboarding', () => ({
  default: ({ onOpenKyc }: { onOpenKyc: () => void }) => (
    <button onClick={onOpenKyc}>open-kyc</button>
  ),
}));

vi.mock('../services/secureStorage', () => ({
  readJSON: vi.fn(),
  writeJSON: vi.fn(),
  removeKey: vi.fn(),
}));

const mockGetKYCStatus = vi.mocked(api.getKYCStatus);
const mockReadJSON = vi.mocked(secureStorage.readJSON);
const mockWriteJSON = vi.mocked(secureStorage.writeJSON);

function createMockAppCtx(overrides: Partial<AppCtx> = {}): AppCtx {
  return {
    sessionUser: {
      id: 'user-1',
      token: 'mock-session-token',
      username: 'testuser',
    } as any,
    activeTrade: null,
    lockTxHash: null,
    releaseTxHash: null,
    activeAmount: 0,
    tradeLoading: false,
    tradeError: null,
    flow: null,
    devicePublicKey: 'GXXXXXX',
    setActiveAmount: vi.fn(),
    setFlow: vi.fn(),
    setReleaseTxHash: vi.fn(),
    handleOfferSelected: vi.fn().mockResolvedValue(true),
    handleDepositOfferSelected: vi.fn().mockResolvedValue(true),
    clearTradeError: vi.fn(),
    retryTradeFlow: vi.fn().mockResolvedValue(true),
    handleAccountDeleted: vi.fn(),
    resetTradeFlow: vi.fn(),
    envName: 'test',
    backendUrl: 'http://localhost:3000',
    isDemoMode: false,
    isMockStellar: true,
    backendConnected: true,
    backendHealth: {},
    setDebugOpen: vi.fn(),
    ...overrides,
  };
}

function LocationTracker() {
  const location = useLocation();
  return <div data-testid="location-path">{location.pathname}</div>;
}

describe('KYCRoute — Route navigation on KYC approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJSON.mockResolvedValue(null);
    mockGetKYCStatus.mockResolvedValue({ status: 'pending' });
  });

  /**
   * KYC-1: este caso afirmaba que una caché local `approved` bastaba para
   * navegar. Eso era justo el defecto: si el backend había expirado o
   * revocado el nivel, la app seguía entrando como verificada. Ahora la caché
   * pinta un estado provisional y quien desbloquea es el servidor, así que el
   * escenario se monta con el servidor confirmando.
   */
  it('navega a /cetes cuando el SERVIDOR confirma la aprobación', async () => {
    mockReadJSON.mockResolvedValue({ status: 'approved' });
    mockGetKYCStatus.mockResolvedValue({ status: 'approved' });

    render(
      <AppContext.Provider value={createMockAppCtx()}>
        <MemoryRouter initialEntries={['/kyc']}>
          <LocationTracker />
          <Routes>
            <Route path="/kyc" element={<KYCRoute />} />
            <Route path="/cetes" element={<div data-testid="cetes-screen">CETES Screen Content</div>} />
            <Route path="/" element={<div data-testid="home-screen">Home Screen</div>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('cetes-screen')).toBeInTheDocument();
      expect(screen.getByTestId('location-path')).toHaveTextContent('/cetes');
    });

    expect(screen.queryByTestId('home-screen')).not.toBeInTheDocument();
  });

  it('navigates to /cetes when status polling resolves to approved', async () => {
    mockReadJSON.mockResolvedValue({ status: 'pending' });
    mockGetKYCStatus.mockResolvedValue({ status: 'approved' });

    render(
      <AppContext.Provider value={createMockAppCtx()}>
        <MemoryRouter initialEntries={['/kyc']}>
          <LocationTracker />
          <Routes>
            <Route path="/kyc" element={<KYCRoute />} />
            <Route path="/cetes" element={<div data-testid="cetes-screen">CETES Screen Content</div>} />
            <Route path="/" element={<div data-testid="home-screen">Home Screen</div>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('cetes-screen')).toBeInTheDocument();
      expect(screen.getByTestId('location-path')).toHaveTextContent('/cetes');
    });

    expect(mockWriteJSON).toHaveBeenCalledWith('kyc_status_etherfuse', { status: 'approved' });
    expect(screen.queryByTestId('home-screen')).not.toBeInTheDocument();
  });

  it('navigates to /cetes when user clicks verified/continue button in header', async () => {
    mockReadJSON.mockResolvedValue({ status: 'pending' });
    mockGetKYCStatus.mockResolvedValue({ status: 'pending' });

    render(
      <AppContext.Provider value={createMockAppCtx()}>
        <MemoryRouter initialEntries={['/kyc']}>
          <LocationTracker />
          <Routes>
            <Route path="/kyc" element={<KYCRoute />} />
            <Route path="/cetes" element={<div data-testid="cetes-screen">CETES Screen Content</div>} />
            <Route path="/" element={<div data-testid="home-screen">Home Screen</div>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );

    expect(screen.getByTestId('location-path')).toHaveTextContent('/kyc');
    expect(screen.queryByTestId('cetes-screen')).not.toBeInTheDocument();

    const continueBtn = screen.getByRole('button', { name: 'kyc.continue' });
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(screen.getByTestId('cetes-screen')).toBeInTheDocument();
      expect(screen.getByTestId('location-path')).toHaveTextContent('/cetes');
    });
  });
});

describe('KYCRoute — HashRouter and URL hash integrity', () => {
  const loc = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJSON.mockResolvedValue({ status: 'approved' });
    // KYC-1: la caché ya no desbloquea por sí sola; quien dispara la
    // navegación es la confirmación del servidor.
    mockGetKYCStatus.mockResolvedValue({ status: 'approved' });
    loc.hash = '#/kyc';
  });

  afterEach(() => {
    loc.hash = '';
  });

  it('sets URL hash to #/cetes without duplicated #/#/cetes and does not fall through to wildcard', async () => {
    render(
      <AppContext.Provider value={createMockAppCtx()}>
        <HashRouter>
          <LocationTracker />
          <Routes>
            <Route path="/kyc" element={<KYCRoute />} />
            <Route path="/cetes" element={<div data-testid="cetes-screen">CETES Screen Content</div>} />
            <Route path="/" element={<div data-testid="home-screen">Home Screen</div>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('cetes-screen')).toBeInTheDocument();
      expect(screen.getByTestId('location-path')).toHaveTextContent('/cetes');
    });

    expect(loc.hash).toBe('#/cetes');
    expect(loc.hash).not.toContain('#/#');
    expect(screen.queryByTestId('home-screen')).not.toBeInTheDocument();
  });
});

/**
 * Un agente nuevo se verifica con Didit desde "Unirse a la Red", no con
 * Etherfuse, y al aprobar vuelve al onboarding.
 */
describe('ProviderOnboardingRoute — KYC del agente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJSON.mockResolvedValue(null);
    mockGetKYCStatus.mockResolvedValue({ status: 'pending' });
  });

  it('abre Didit y al aprobar vuelve a /join-network', async () => {
    render(
      <AppContext.Provider value={createMockAppCtx({ refreshProviderStatus: vi.fn() } as any)}>
        <MemoryRouter initialEntries={['/join-network']}>
          <LocationTracker />
          <Routes>
            <Route path="/join-network" element={<ProviderOnboardingRoute />} />
            <Route path="/kyc/didit" element={<DiditKYCRoute />} />
            <Route path="/kyc" element={<div data-testid="etherfuse-kyc">Etherfuse</div>} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );

    mockGetKYCStatus.mockResolvedValue({ status: 'approved' });
    fireEvent.click(screen.getByRole('button', { name: 'open-kyc' }));

    await waitFor(() => expect(mockGetKYCStatus).toHaveBeenCalledWith('mock-session-token', 'didit'));
    await waitFor(() => {
      expect(screen.getByTestId('location-path')).toHaveTextContent('/join-network');
    });
    expect(screen.queryByTestId('etherfuse-kyc')).not.toBeInTheDocument();
  });
});

/**
 * KYC-1 · La caché no puede desbloquear por sí sola.
 *
 * Es el criterio "a stale local `approved` cache cannot navigate as verified
 * after backend expiry/revocation". Con la caché diciendo `approved` y el
 * servidor diciendo otra cosa, la app NO debe navegar como verificada.
 */
describe('KYC-1 — la caché local no manda', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no navega si el servidor ya no aprueba, aunque la caché diga que sí', async () => {
    mockReadJSON.mockResolvedValue({ status: 'approved' });
    mockGetKYCStatus.mockResolvedValue({ status: 'pending' });

    render(
      <AppContext.Provider value={createMockAppCtx()}>
        <MemoryRouter initialEntries={['/kyc']}>
          <LocationTracker />
          <Routes>
            <Route path="/kyc" element={<KYCRoute />} />
            <Route path="/cetes" element={<div data-testid="cetes-screen">CETES Screen Content</div>} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );

    await waitFor(() => expect(mockGetKYCStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('cetes-screen')).not.toBeInTheDocument();
    expect(screen.getByTestId('location-path')).toHaveTextContent('/kyc');
  });

  it('tampoco navega si el servidor no responde', async () => {
    mockReadJSON.mockResolvedValue({ status: 'approved' });
    mockGetKYCStatus.mockRejectedValue(new Error('network'));

    render(
      <AppContext.Provider value={createMockAppCtx()}>
        <MemoryRouter initialEntries={['/kyc']}>
          <LocationTracker />
          <Routes>
            <Route path="/kyc" element={<KYCRoute />} />
            <Route path="/cetes" element={<div data-testid="cetes-screen">CETES Screen Content</div>} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );

    await waitFor(() => expect(mockGetKYCStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('cetes-screen')).not.toBeInTheDocument();
  });
});

describe('KYCRoute — build de Play (CETES "Próximamente")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    features.cetes = false;
  });
  afterEach(() => {
    features.cetes = true;
  });

  it('al aprobar vuelve al inicio, no a una pantalla cerrada', async () => {
    mockReadJSON.mockResolvedValue({ status: 'approved' });
    mockGetKYCStatus.mockResolvedValue({ status: 'approved' });

    render(
      <AppContext.Provider value={createMockAppCtx()}>
        <MemoryRouter initialEntries={['/kyc']}>
          <LocationTracker />
          <Routes>
            <Route path="/kyc" element={<KYCRoute />} />
            <Route path="/cetes" element={<div data-testid="cetes-screen">CETES Screen Content</div>} />
            <Route path="/" element={<div data-testid="home-screen">Home Screen</div>} />
          </Routes>
        </MemoryRouter>
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-screen')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('cetes-screen')).not.toBeInTheDocument();
  });
});
