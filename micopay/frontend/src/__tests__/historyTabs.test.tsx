/**
 * UX-3 (#434) · The History tabs ask the server for their status.
 *
 * History used to fetch the full history and filter on the phone with
 * `t.status === status`. "Expirados" can never match that way: `expired` is
 * derived from `expires_at` on the server and is never a stored trade status,
 * so the tab was always empty.
 *
 * History now sends the selected tab to `getTradeHistory` and shows what the
 * server returns. The server owns the definition of each tab.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import i18n from '../i18n';

vi.mock('../services/api', () => ({
  getTradeHistory: vi.fn(),
  getPaymentHistory: vi.fn(),
}));

import { getPaymentHistory, getTradeHistory, type TradeHistoryItem } from '../services/api';
import History from '../pages/History';

/** Testing Library waits 1s by default; a busy CI runner can need longer to render the page. */
const WAIT_MS = 10_000;

const mockGetTradeHistory = vi.mocked(getTradeHistory);
const mockGetPaymentHistory = vi.mocked(getPaymentHistory);

beforeAll(async () => {
  await i18n.changeLanguage('es');
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTradeHistory.mockResolvedValue([]);
  mockGetPaymentHistory.mockResolvedValue([]);
});

afterEach(() => cleanup());

function trade(id: string, status: string, amount = 500): TradeHistoryItem {
  return {
    id,
    status,
    amount_mxn: amount,
    platform_fee_mxn: 4,
    lock_tx_hash: null,
    release_tx_hash: null,
    created_at: '2026-10-01T12:00:00.000Z',
    completed_at: null,
    seller_id: `seller-${id}-0000`,
    buyer_id: `buyer-${id}-0000`,
    flow: 'cashout',
    provider_id: `buyer-${id}-0000`,
  } as TradeHistoryItem;
}

function renderHistory() {
  render(<History onBack={() => {}} onSelectTrade={() => {}} token="tok" />);
}

/** The arguments of the most recent getTradeHistory call. */
const lastCall = () => mockGetTradeHistory.mock.calls.at(-1);

async function openTab(label: string) {
  const before = mockGetTradeHistory.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(mockGetTradeHistory.mock.calls.length).toBeGreaterThan(before), { timeout: WAIT_MS });
}

describe('History · the selected tab is sent to the server', () => {
  it('"Todos" asks for the history with no status, like Home does', async () => {
    renderHistory();
    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });
    expect(lastCall()).toEqual(['tok', undefined]);
  });

  it.each([
    ['Completados', 'completed'],
    ['Cancelados', 'cancelled'],
    ['Expirados', 'expired'],
    ['Reembolsados', 'refunded'],
  ])('"%s" sends status=%s', async (label, status) => {
    renderHistory();
    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });

    await openTab(label);

    expect(lastCall()).toEqual(['tok', status]);
  });

  it('going back to "Todos" drops the status again', async () => {
    renderHistory();
    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });

    await openTab('Expirados');
    expect(lastCall()).toEqual(['tok', 'expired']);

    await openTab('Todos');
    expect(lastCall()).toEqual(['tok', undefined]);
  });

  it('"Transferencias" asks for payments only, not for trades', async () => {
    renderHistory();
    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });
    mockGetTradeHistory.mockClear();
    mockGetPaymentHistory.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Transferencias' }));
    await waitFor(() => expect(mockGetPaymentHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });

    expect(mockGetTradeHistory).not.toHaveBeenCalled();
  });

  it('a trade tab does not ask for payments', async () => {
    renderHistory();
    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });
    mockGetPaymentHistory.mockClear();

    await openTab('Expirados');

    expect(mockGetPaymentHistory).not.toHaveBeenCalled();
  });

  it('asks again each time a tab is opened, one request per switch', async () => {
    renderHistory();
    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });

    await openTab('Cancelados');
    await openTab('Reembolsados');

    expect(mockGetTradeHistory).toHaveBeenCalledTimes(3);
  });
});

describe('History · shows what the server returns', () => {
  it('"Expirados" lists an open trade past its deadline, whose stored status is not "expired"', async () => {
    // The server's `expired` filter returns trades that are still `locked`,
    // `pending` or `revealing` but past their deadline. Filtering these again
    // on the phone by `status === 'expired'` is what emptied the tab.
    mockGetTradeHistory.mockImplementation(async (_token, status) =>
      status === 'expired' ? [trade('a', 'locked', 750)] : [],
    );

    renderHistory();
    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalledTimes(1), { timeout: WAIT_MS });
    await openTab('Expirados');

    expect(await screen.findByText('$750 MXN', undefined, { timeout: WAIT_MS })).toBeInTheDocument();
    expect(screen.queryByText('Sin transacciones')).not.toBeInTheDocument();
  });

  it('does not filter the server response again on the phone', async () => {
    mockGetTradeHistory.mockResolvedValue([
      trade('a', 'completed', 100),
      trade('b', 'locked', 200),
      trade('c', 'refunded', 300),
    ]);

    renderHistory();
    await openTab('Cancelados');

    expect(await screen.findByText('$100 MXN', undefined, { timeout: WAIT_MS })).toBeInTheDocument();
    expect(screen.getByText('$200 MXN')).toBeInTheDocument();
    expect(screen.getByText('$300 MXN')).toBeInTheDocument();
  });

  it('an empty answer shows the empty state', async () => {
    renderHistory();
    await openTab('Expirados');

    expect(await screen.findByText('Sin transacciones', undefined, { timeout: WAIT_MS })).toBeInTheDocument();
  });

  it('a failed request shows the error, not an empty list', async () => {
    mockGetTradeHistory.mockRejectedValue(new Error('network down'));

    renderHistory();

    await waitFor(() => expect(mockGetTradeHistory).toHaveBeenCalled(), { timeout: WAIT_MS });
    await waitFor(() => expect(screen.queryByText('Cargando historial...')).not.toBeInTheDocument(), { timeout: WAIT_MS });
    expect(screen.queryByText('Sin transacciones')).not.toBeInTheDocument();
  });
});

describe('History · without a session', () => {
  it('does not call the server', async () => {
    render(<History onBack={() => {}} onSelectTrade={() => {}} token={null} />);
    await Promise.resolve();
    expect(mockGetTradeHistory).not.toHaveBeenCalled();
  });
});
