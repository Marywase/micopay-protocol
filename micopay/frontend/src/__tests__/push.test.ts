/**
 * Al tocar un aviso se abre la pantalla que corresponde. El `data` lo arma el
 * backend (push.service): `type` y el id, todo como string.
 */
import { describe, it, expect } from 'vitest';
import { routeForNotification } from '../lib/push';

describe('routeForNotification', () => {
  it('un cambio de operación abre su detalle', () => {
    expect(routeForNotification({ type: 'trade_update', kind: 'cancelled', tradeId: 'abc-1' })).toBe('/trade/abc-1');
  });

  it('una operación nueva abre la bandeja del agente', () => {
    expect(routeForNotification({ type: 'new_trade', tradeId: 'abc-1' })).toBe('/inbox');
  });

  it('una solicitud de firma abre su pantalla', () => {
    expect(routeForNotification({ type: 'sign_request', requestId: 'req-9' })).toBe('/sign-request/req-9');
  });

  it('un pago recibido abre el inicio, donde se ve el saldo', () => {
    expect(routeForNotification({ type: 'payment_received', txHash: 'f'.repeat(64) })).toBe('/');
  });

  it('un aviso sin datos o desconocido no navega', () => {
    expect(routeForNotification(undefined)).toBeNull();
    expect(routeForNotification({ type: 'trade_update' })).toBeNull();
    expect(routeForNotification({ type: 'otro', tradeId: 'x' })).toBeNull();
  });

  it('el id no puede inyectar otra ruta', () => {
    expect(routeForNotification({ type: 'trade_update', tradeId: '../profile' })).toBe('/trade/..%2Fprofile');
  });
});
