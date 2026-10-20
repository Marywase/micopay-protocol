/**
 * El Historial muestra las transferencias de la red ("Enviar pago" y pagos de
 * fuera) junto a las operaciones de efectivo, ordenadas por fecha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import History from '../pages/History';
import * as api from '../services/api';

vi.mock('../services/api', () => ({
  getTradeHistory: vi.fn(),
  getPaymentHistory: vi.fn(),
}));

const mockTrades = vi.mocked(api.getTradeHistory);
const mockPayments = vi.mocked(api.getPaymentHistory);

const trade = {
  id: 'trade-1',
  seller_id: 'seller-abcdef12',
  buyer_id: 'buyer-1',
  amount_mxn: 500,
  status: 'completed',
  created_at: '2026-10-20T20:00:00Z',
} as unknown as api.TradeHistoryItem;

const received: api.PaymentHistoryItem = {
  id: 'op-1',
  tx_hash: 'f'.repeat(64),
  created_at: '2026-10-20T21:29:07Z',
  direction: 'in',
  amount: '5.0000000',
  asset: 'XLM',
  counterparty: 'GCC5LJ247GO7ZQUX7X2EVESAXHMR23DCNLCMUY4VVQP7BG2VFZ5VRGJO',
  counterparty_username: 'agente_demo_rgjo',
};

const sent: api.PaymentHistoryItem = {
  id: 'op-2',
  tx_hash: 'e'.repeat(64),
  created_at: '2026-10-20T19:00:00Z',
  direction: 'out',
  amount: '1.5000000',
  asset: 'USDC',
  counterparty: 'GAAXO3ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZWXYZ',
  counterparty_username: null,
};

function renderHistory() {
  return render(<History onBack={vi.fn()} onSelectTrade={vi.fn()} token="tok" />);
}

describe('Historial con transferencias', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrades.mockResolvedValue([trade]);
    mockPayments.mockResolvedValue([received, sent]);
  });

  it('"Todos" mezcla operaciones y transferencias, la más nueva primero', async () => {
    renderHistory();
    await screen.findByText('De @agente_demo_rgjo');

    const rows = screen.getAllByText(/^(De|A) |seller-a/).map((el) => el.textContent);
    expect(rows).toEqual(['De @agente_demo_rgjo', 'seller-a…', 'A GAAXO3…WXYZ']);
    expect(screen.getByText('+5 XLM')).toBeInTheDocument();
    expect(screen.getByText('−1.5 USDC')).toBeInTheDocument();
  });

  it('una transferencia abre su transacción en el explorador', async () => {
    renderHistory();
    const row = (await screen.findByText('De @agente_demo_rgjo')).closest('a');
    expect(row?.getAttribute('href')).toContain(`/tx/${'f'.repeat(64)}`);
  });

  it('"Transferencias" muestra solo las transferencias', async () => {
    renderHistory();
    await screen.findByText('De @agente_demo_rgjo');
    fireEvent.click(screen.getByText('Transferencias'));
    await waitFor(() => expect(screen.queryByText('seller-a…')).not.toBeInTheDocument());
    expect(screen.getByText('De @agente_demo_rgjo')).toBeInTheDocument();
  });

  it('un filtro de estado deja fuera las transferencias', async () => {
    renderHistory();
    await screen.findByText('De @agente_demo_rgjo');
    fireEvent.click(screen.getByText('Completados'));
    await screen.findByText('seller-a…');
    expect(screen.queryByText('De @agente_demo_rgjo')).not.toBeInTheDocument();
  });

  it('si fallan las transferencias, las operaciones se siguen viendo', async () => {
    mockPayments.mockRejectedValue(new Error('502'));
    renderHistory();
    await screen.findByText('seller-a…');
    expect(screen.getByText(/No pudimos cargar tus transferencias/)).toBeInTheDocument();
  });
});
