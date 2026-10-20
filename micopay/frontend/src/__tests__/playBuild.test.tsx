/**
 * Build de Play Store: CETES y Blend como "Próximamente".
 *
 * En Play, CETES y Blend aún no mueven el dinero de la persona de verdad, así
 * que se muestran pero no se abren. Esto fija tres cosas:
 *   1. `.env.play` es `.env.testnet` con las dos funciones apagadas, y nada más
 *      distinto (si alguien cambia testnet y olvida Play, aquí truena).
 *   2. Explorar muestra las tarjetas con "Próximamente" en vez de esconderlas.
 *   3. Las rutas /cetes y /blend no abren la pantalla real cuando están apagadas.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import '../i18n';
import Explore from '../pages/Explore';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function vars(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of read(file).split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('.env.play', () => {
  it('apaga CETES y Blend', () => {
    const play = vars('.env.play');
    expect(play.VITE_ENABLE_DEFI_TRADING).toBe('false');
    expect(play.VITE_ENABLE_SPEI_RAMP).toBe('false');
  });

  it('en todo lo demás es igual a .env.testnet', () => {
    const { VITE_ENABLE_DEFI_TRADING: _a, VITE_ENABLE_SPEI_RAMP: _b, ...play } = vars('.env.play');
    const { VITE_ENABLE_DEFI_TRADING: _c, VITE_ENABLE_SPEI_RAMP: _d, ...testnet } = vars('.env.testnet');
    expect(play).toEqual(testnet);
  });

  it('existe el script build:play', () => {
    expect(JSON.parse(read('package.json')).scripts['build:play']).toMatch(/--mode play/);
  });
});

describe('features', () => {
  it('sin banderas, CETES y Blend quedan cerrados', async () => {
    vi.stubEnv('VITE_ENABLE_DEFI_TRADING', 'false');
    vi.stubEnv('VITE_ENABLE_SPEI_RAMP', 'false');
    const f = await import('../constants/features');
    expect(f.CETES_AVAILABLE).toBe(false);
    expect(f.BLEND_AVAILABLE).toBe(false);
  });

  it('la rampa SPEI sola abre CETES pero no Blend', async () => {
    vi.stubEnv('VITE_ENABLE_DEFI_TRADING', 'false');
    vi.stubEnv('VITE_ENABLE_SPEI_RAMP', 'true');
    const f = await import('../constants/features');
    expect(f.CETES_AVAILABLE).toBe(true);
    expect(f.BLEND_AVAILABLE).toBe(false);
  });
});

describe('Explorar', () => {
  it('apagados: se ven las dos tarjetas con "Próximamente" y no navegan', () => {
    const onNavigate = vi.fn();
    render(<Explore onNavigate={onNavigate} cetesAvailable={false} blendAvailable={false} />);
    const buttons = screen.getAllByRole('button', { name: /próximamente/i });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toBeDisabled();
      b.click();
    }
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('abiertos: los botones llevan a CETES y a Blend', () => {
    const onNavigate = vi.fn();
    render(<Explore onNavigate={onNavigate} cetesAvailable blendAvailable />);
    expect(screen.queryByRole('button', { name: /próximamente/i })).toBeNull();
    screen.getByRole('button', { name: /ver cetes/i }).click();
    expect(onNavigate).toHaveBeenCalledWith('cetes');
  });
});

describe('rutas', () => {
  const app = read('src/App.tsx');
  const body = (name: string) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n}\n', app.indexOf(`function ${name}(`)));

  it('/cetes y /blend muestran "Próximamente" antes de la pantalla real', () => {
    for (const [route, flag, screenName] of [['CetesRoute', 'CETES_AVAILABLE', '<CETESScreen'], ['BlendRoute', 'BLEND_AVAILABLE', '<BlendScreen']]) {
      const b = body(route);
      expect(b).toContain(`if (!${flag})`);
      expect(b.indexOf('<ComingSoon')).toBeLessThan(b.indexOf(screenName));
    }
  });

  it('tras aprobar el KYC no se manda a CETES si está cerrado', () => {
    expect(body('KYCApprovedNextRoute')).toContain("CETES_AVAILABLE ? '/cetes' : '/'");
  });
});
