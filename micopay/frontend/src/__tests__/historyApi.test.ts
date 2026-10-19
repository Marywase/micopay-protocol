/**
 * UX-3 (#434) · getTradeHistory sends the status as a query parameter.
 *
 * Home calls it with no status and must keep getting the unfiltered history;
 * the History tabs call it with the selected tab.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('axios', () => ({
  default: {
    create: () => ({
      get,
      post: vi.fn(),
      interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
    }),
  },
}));

import { getTradeHistory } from '../services/api';

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: { trades: [{ id: 't1' }] } });
});

describe('getTradeHistory', () => {
  it('sends no filter when there is no status (what Home does)', async () => {
    await getTradeHistory('tok');

    const [url, config] = get.mock.calls[0];
    expect(url).toBe('/trades/history');
    expect(config.params).toBeUndefined();
    expect(config.headers.Authorization).toBe('Bearer tok');
  });

  it('treats "all" as no filter', async () => {
    await getTradeHistory('tok', 'all');
    expect(get.mock.calls[0][1].params).toBeUndefined();
  });

  it.each(['completed', 'cancelled', 'expired', 'refunded', 'locked'])(
    'sends status=%s as a query parameter',
    async (status) => {
      await getTradeHistory('tok', status);
      expect(get.mock.calls[0][1].params).toEqual({ status });
    },
  );

  it('sends nothing else: page and limit stay with the server defaults', async () => {
    await getTradeHistory('tok', 'expired');
    expect(Object.keys(get.mock.calls[0][1].params)).toEqual(['status']);
  });

  it('returns the trades from the response', async () => {
    await expect(getTradeHistory('tok', 'expired')).resolves.toEqual([{ id: 't1' }]);
  });
});
