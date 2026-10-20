/**
 * WP-C · selector de activo en las pantallas de monto.
 *
 * Fija lo que el plan promete al cliente: XLM viene elegido y las opciones sin
 * escrow no se pueden elegir ni con clic ni con teclado; la pregunta cambia
 * segun quien entrega el activo; el equivalente es un estimado que no depende
 * de una peticion por tecla; una tasa caida no bloquea continuar; y la
 * respuesta de un activo anterior no pisa la del actual. Ademas, que el activo
 * elegido llega a `createTrade`.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18n from '../i18n';
import AssetSelector from '../components/AssetSelector';
import CashoutRequest from '../pages/CashoutRequest';
import DepositRequest from '../pages/DepositRequest';

vi.mock('../services/api', () => ({
  getEscrowAssetRate: vi.fn(async () => ({ rate: 3.263255 })),
}));

beforeAll(async () => {
  await i18n.changeLanguage('es');
});

const XLM = 'stellar:XLM';

function radio(key: string): HTMLInputElement {
  return screen.getByDisplayValue(key) as HTMLInputElement;
}

describe('AssetSelector', () => {
  it('starts with XLM selected and the other options disabled', async () => {
    render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={async () => ({ rate: 3.263255 })} />);
    expect(radio(XLM).checked).toBe(true);
    expect(radio(XLM).disabled).toBe(false);
    for (const key of ['stellar:USDC']) {
      expect(radio(key).disabled).toBe(true);
    }
    expect(screen.getAllByText('Próximamente')).toHaveLength(1);
    // MXNe salio de la app: no hay ni opcion "Proximamente".
    expect(screen.queryByDisplayValue('stellar:MXNE')).toBeNull();
    await screen.findByTestId('asset-estimate');
  });

  /**
   * jsdom no implementa la navegacion con flechas entre radios, asi que simular
   * teclas aqui no probaria nada. Lo que excluye una opcion del teclado en un
   * navegador real es el atributo nativo `disabled` (no `aria-disabled`), y eso
   * es lo que se fija, junto con clic en el radio y en su etiqueta.
   */
  it('disabled options are natively disabled and ignore clicks on radio or label', async () => {
    const onChange = vi.fn();
    render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={onChange} fetchRate={async () => ({ rate: 3.26 })} />);
    for (const key of ['stellar:USDC']) {
      const input = radio(key);
      expect(input).toHaveAttribute('disabled');
      fireEvent.click(input);
      fireEvent.click(input.closest('label')!);
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(radio(XLM).checked).toBe(true);
    await screen.findByTestId('asset-estimate');
  });

  it('does not show XRP or Solana yet', async () => {
    render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={async () => ({ rate: 3 })} />);
    expect(screen.queryByDisplayValue('xrpl:XRP')).toBeNull();
    expect(screen.queryByDisplayValue('solana:USDC')).toBeNull();
    expect(screen.queryByText('XRPL')).toBeNull();
    expect(screen.queryByText('Solana')).toBeNull();
    await screen.findByTestId('asset-estimate');
  });

  it('asks "¿Con qué pagas?" in cash-out and "¿Qué quieres recibir?" in deposit', async () => {
    const { unmount } = render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={async () => ({ rate: 3 })} />);
    expect(screen.getByText('¿Con qué pagas?')).toBeInTheDocument();
    await screen.findByTestId('asset-estimate');
    unmount();
    render(<AssetSelector flow="deposit" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={async () => ({ rate: 3 })} />);
    expect(screen.getByText('¿Qué quieres recibir?')).toBeInTheDocument();
    await screen.findByTestId('asset-estimate');
  });

  it('shows ≈ 153.22 XLM for $500 at 3.263255, labeled as an estimate', async () => {
    render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={async () => ({ rate: 3.263255 })} />);
    const estimate = await screen.findByTestId('asset-estimate');
    expect(estimate.textContent).toBe('≈ 153.22 XLM · 1 XLM = $3.26');
    expect(screen.getByText('Estimado. La tasa se fija al crear la operación.')).toBeInTheDocument();
  });

  it('recomputes locally when the amount changes, without refetching', async () => {
    const fetchRate = vi.fn(async () => ({ rate: 4 }));
    const { rerender } = render(<AssetSelector flow="cashout" amountMxn={400} value={XLM} onChange={() => {}} fetchRate={fetchRate} />);
    expect((await screen.findByTestId('asset-estimate')).textContent).toContain('100.00 XLM');
    rerender(<AssetSelector flow="cashout" amountMxn={800} value={XLM} onChange={() => {}} fetchRate={fetchRate} />);
    rerender(<AssetSelector flow="cashout" amountMxn={1000} value={XLM} onChange={() => {}} fetchRate={fetchRate} />);
    expect(screen.getByTestId('asset-estimate').textContent).toContain('250.00 XLM');
    expect(fetchRate).toHaveBeenCalledTimes(1);
  });

  it.each([[null], [Number.NaN], [99]])('hides the estimate for amount %p', async (amount) => {
    const fetchRate = vi.fn(async () => ({ rate: 3 }));
    render(<AssetSelector flow="cashout" amountMxn={amount} value={XLM} onChange={() => {}} fetchRate={fetchRate} />);
    await waitFor(() => expect(fetchRate).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId('asset-estimate')).toBeNull();
  });

  it('a failed rate hides the estimate and says so', async () => {
    render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={async () => { throw new Error('down'); }} />);
    expect(await screen.findByText('No pudimos obtener la tasa. Se fija al crear la operación.')).toBeInTheDocument();
    expect(screen.queryByTestId('asset-estimate')).toBeNull();
  });

  it('an invalid rate is treated as a failure, not as data', async () => {
    render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={async () => ({ rate: 0 })} />);
    expect(await screen.findByText('No pudimos obtener la tasa. Se fija al crear la operación.')).toBeInTheDocument();
  });

  it('a stale response for a previous asset does not overwrite the current one', async () => {
    let resolveOld!: (v: { rate: number }) => void;
    const fetchRate = vi.fn((code: string) =>
      code === 'XLM' ? new Promise<{ rate: number }>((r) => { resolveOld = r; }) : Promise.resolve({ rate: 2 }),
    );
    const { rerender } = render(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={fetchRate} />);
    // Cambia a una clave inexistente (desmonta la peticion de XLM) y vuelve a XLM
    // con una tasa nueva: la respuesta vieja llega tarde y debe ignorarse.
    rerender(<AssetSelector flow="cashout" amountMxn={500} value="stellar:NOPE" onChange={() => {}} fetchRate={fetchRate} />);
    const fresh = vi.fn(async () => ({ rate: 5 }));
    rerender(<AssetSelector flow="cashout" amountMxn={500} value={XLM} onChange={() => {}} fetchRate={fresh} />);
    expect((await screen.findByTestId('asset-estimate')).textContent).toContain('100.00 XLM');
    await act(async () => { resolveOld({ rate: 1 }); });
    expect(screen.getByTestId('asset-estimate').textContent).toContain('100.00 XLM');
  });
});

describe('amount screens', () => {
  it('cash-out renders the selector and a failed rate does not block continuing', async () => {
    const api = await import('../services/api');
    vi.mocked(api.getEscrowAssetRate).mockRejectedValueOnce(new Error('down'));
    const onSearch = vi.fn();
    render(<CashoutRequest onBack={() => {}} onSearch={onSearch} assetKey={XLM} onAssetChange={() => {}} />);
    expect(screen.getByText('¿Con qué pagas?')).toBeInTheDocument();
    await screen.findByText('No pudimos obtener la tasa. Se fija al crear la operación.');
    fireEvent.click(screen.getByRole('button', { name: 'Buscar ofertas de efectivo' }));
    expect(onSearch).toHaveBeenCalledWith(500);
  });

  it('deposit renders the selector with its own question', async () => {
    render(<DepositRequest onBack={() => {}} onSearch={() => {}} assetKey={XLM} onAssetChange={() => {}} />);
    expect(screen.getByText('¿Qué quieres recibir?')).toBeInTheDocument();
    expect((await screen.findByTestId('asset-estimate')).textContent).toBe('≈ 153.22 XLM · 1 XLM = $3.26');
  });
});

describe('wiring', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const app = readFileSync(resolve(dir, '../App.tsx'), 'utf8');

  it('createTrade receives the code of the selected asset', () => {
    expect(app).toMatch(/const assetCode = getEscrowAssetOption\(activeAssetKey\)\?\.code;/);
    expect(app).toMatch(/createTrade\(counterpartyId, activeAmount, sessionUser\.token, tradeFlow, assetCode\)/);
  });

  it('the asset resets to the default when the trade flow resets', () => {
    const reset = app.slice(app.indexOf('const resetTradeFlow'), app.indexOf('const clearTradeError'));
    expect(reset).toContain('setActiveAssetKey(DEFAULT_ESCROW_ASSET_KEY)');
  });

  it('both amount routes pass the context asset to the screen', () => {
    for (const route of ['function CashoutRoute', 'function DepositRoute']) {
      const start = app.indexOf(route);
      const body = app.slice(start, app.indexOf('\nfunction ', start + 10));
      expect(body).toContain('assetKey={activeAssetKey}');
      expect(body).toContain('onAssetChange={setActiveAssetKey}');
    }
  });
});
