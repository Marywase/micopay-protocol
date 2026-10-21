import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor } from '@testing-library/react';
import Home from '../pages/Home';
import * as api from '../services/api';
import { useWalletBalance } from '../hooks/useWalletBalance';

vi.mock('../services/api', () => ({
  getTradeHistory: vi.fn(),
  getCurrentUser: vi.fn(),
  getMerchantTrades: vi.fn(),
  getXlmMxnRate: vi.fn(),
}));

vi.mock('../hooks/useWalletBalance', () => ({
  useWalletBalance: vi.fn(),
}));

const mockGetTradeHistory = vi.mocked(api.getTradeHistory);
const mockGetCurrentUser = vi.mocked(api.getCurrentUser);
const mockGetMerchantTrades = vi.mocked(api.getMerchantTrades);
const mockGetXlmMxnRate = vi.mocked(api.getXlmMxnRate);
const mockUseWalletBalance = vi.mocked(useWalletBalance);

function createProps(overrides = {}) {
  return {
    onNavigateCashout: vi.fn(),
    onNavigateDeposit: vi.fn(),
    onNavigateHistory: vi.fn(),
    token: 'buyer-token',
    merchantToken: 'merchant-token',
    onNavigateInbox: vi.fn(),
    // El saludo sale de la prop `username`; sin ella Home imprime "Hola, ..."
    // y la asercion /hola, juan/ del test no podia pasar.
    username: 'Juan',
    ...overrides,
  };
}

describe('Home — pending-trades badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWalletBalance.mockReturnValue({
      xlmBalance: '250.00',
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: null,
      refresh: vi.fn(),
      // Home calcula el total desde `tokens`, no desde `xlmBalance`. Sin este
      // campo el mock devolvia undefined y el componente reventaba en
      // `tokens.reduce` antes de renderizar nada.
      tokens: [{ code: 'XLM', balance: 250 }],
      usdMxnRate: 17.5,
    });
    mockGetTradeHistory.mockResolvedValue([]);
    mockGetCurrentUser.mockResolvedValue({ verification_status: 'verified' } as any);
    mockGetMerchantTrades.mockResolvedValue([]);
    mockGetXlmMxnRate.mockResolvedValue({ rate: 18.42, source: 'coingecko', fetchedAt: '2026-06-25T12:00:00Z' });
  });

  it('calls getMerchantTrades with merchantToken and "pending"', async () => {
    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(mockGetMerchantTrades).toHaveBeenCalledWith('merchant-token', 'pending');
    });
  });

  it('does NOT call getMerchantTrades when merchantToken is null', async () => {
    render(<Home {...createProps({ merchantToken: null })} />);

    await waitFor(() => {
      expect(mockUseWalletBalance).toHaveBeenCalled();
    });

    expect(mockGetMerchantTrades).not.toHaveBeenCalled();
  });

  it('shows the badge with the correct count when there are pending trades', async () => {
    mockGetMerchantTrades.mockResolvedValue([
      { id: 't1', client_handle: 'alice', flow: 'cashout', amount_mxn: 100, status: 'pending', created_at: '2024-06-01T10:00:00Z' },
      { id: 't2', client_handle: 'bob', flow: 'deposit', amount_mxn: 200, status: 'pending', created_at: '2024-06-01T11:00:00Z' },
    ]);

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  it('does NOT show the badge when there are zero pending trades', async () => {
    mockGetMerchantTrades.mockResolvedValue([]);

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(mockGetMerchantTrades).toHaveBeenCalled();
    });

    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('handles API error gracefully — no badge, no crash', async () => {
    mockGetMerchantTrades.mockRejectedValue(new Error('Network error'));

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(mockGetMerchantTrades).toHaveBeenCalled();
    });

    expect(screen.getByText(/hola, juan/i)).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('Home — XLM→MXN rate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWalletBalance.mockReturnValue({
      xlmBalance: '250.00',
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: null,
      refresh: vi.fn(),
      // Home calcula el total desde `tokens`, no desde `xlmBalance`. Sin este
      // campo el mock devolvia undefined y el componente reventaba en
      // `tokens.reduce` antes de renderizar nada.
      tokens: [{ code: 'XLM', balance: 250 }],
      usdMxnRate: 17.5,
    });
    mockGetTradeHistory.mockResolvedValue([]);
    mockGetCurrentUser.mockResolvedValue({ verification_status: 'verified' } as any);
    mockGetMerchantTrades.mockResolvedValue([]);
  });

  it('displays MXN value computed with the fetched rate', async () => {
    mockGetXlmMxnRate.mockResolvedValue({ rate: 18.42, source: 'coingecko', fetchedAt: '2026-06-25T12:00:00Z' });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText(/4,605/).length).toBeGreaterThanOrEqual(1);
    });
  });

  // Antes se mostraba un estimado con tilde (~ balance × 20). docs/AUDIT_MOBILE_MAINNET.md
  // §3 lo prohíbe: sin cotización se muestra "—", nunca un FX inventado.
  it('shows an em dash instead of an invented rate when the fetch fails', async () => {
    mockGetXlmMxnRate.mockRejectedValue(new Error('Network error'));

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText(/~5,000/)).not.toBeInTheDocument();
  });
});

describe('Home — non-custodial wallet balance states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTradeHistory.mockResolvedValue([]);
    mockGetCurrentUser.mockResolvedValue({ verification_status: 'verified' } as any);
    mockGetMerchantTrades.mockResolvedValue([]);
    mockGetXlmMxnRate.mockResolvedValue({ rate: 18.42, source: 'coingecko', fetchedAt: '2026-06-25T12:00:00Z' });
  });

  it('shows 0.00 XLM and no MXNe row when the account is not funded (Horizon 404)', async () => {
    mockUseWalletBalance.mockReturnValue({
      xlmBalance: '0.00',
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: null,
      refresh: vi.fn(),
      tokens: [{ code: 'XLM', balance: 0 }],
      usdMxnRate: 17.5,
    });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('0.00 XLM').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText(/Peso Digital/)).toBeNull();
    expect(screen.queryByText(/MXNe/i)).toBeNull();
  });

  it('shows loading state when Horizon is loading', async () => {
    mockUseWalletBalance.mockReturnValue({
      xlmBalance: null,
      stellarAddress: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
      tokens: [],
      usdMxnRate: null,
    });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('Cargando balance…').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows fallback "--" when Horizon returns error', async () => {
    mockUseWalletBalance.mockReturnValue({
      xlmBalance: null,
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: new Error('Horizon connection failed'),
      refresh: vi.fn(),
      tokens: [],
      usdMxnRate: null,
    });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(1);
    });
  });
});

/**
 * La acción principal del producto estaba al FINAL de la pantalla, después del
 * historial. Con historial CERO ya quedaba fuera de la vista: en una cuenta
 * recién creada había que hacer scroll para encontrar "Convertir a efectivo",
 * y cada operación nueva la empujaba más abajo.
 *
 * Se fija por posición en la fuente, no por render: lo que importa es el ORDEN
 * de las secciones, y es exactamente lo que se puede volver a perder al añadir
 * una sección nueva sin pensar dónde va.
 */
describe('el orden de Inicio pone la acción antes que el registro', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../pages/Home.tsx'),
    'utf8',
  );

  const at = (needle: string) => {
    const i = source.indexOf(needle);
    expect(i, `no se encontró "${needle}" en Home.tsx`).toBeGreaterThan(-1);
    return i;
  };

  it('los CTA van antes que activos e historial', () => {
    const cta = at('onClick={onNavigateCashout}');
    expect(cta, 'el CTA debe ir antes de ACTIVOS').toBeLessThan(at("t('home.assets')"));
    expect(cta, 'el CTA debe ir antes del historial').toBeLessThan(
      at("t('home.recentActivity')"),
    );
  });

  it('el saldo sigue primero: responde "cuánto tengo" antes de "qué hago"', () => {
    expect(at("t('home.totalValue'")).toBeLessThan(at('onClick={onNavigateCashout}'));
  });

  it('el historial de Inicio está acotado', () => {
    // Sin tope volvería a empujar hacia abajo lo que venga después.
    expect(source).toContain('HOME_HISTORY_LIMIT');
    expect(source).toMatch(/trades\.slice\(0, HOME_HISTORY_LIMIT\)/);
  });
});
