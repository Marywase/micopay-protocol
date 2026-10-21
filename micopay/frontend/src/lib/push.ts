import { Capacitor } from '@capacitor/core';

/**
 * Notificaciones push (Firebase Cloud Messaging) en la app nativa.
 *
 * El backend ya enviaba avisos, pero la app nunca pedia permiso ni registraba
 * su token, asi que no llegaba ninguno. Aqui se pide el permiso, se manda el
 * token al backend y, al tocar un aviso, se abre la pantalla que corresponde.
 *
 * En web no hace nada: no hay `google-services.json` ni service worker.
 */

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** Se dispara cuando la persona da permiso desde la bandeja, para registrar el token. */
export const PUSH_PERMISSION_GRANTED_EVENT = 'micopay:push-permission-granted';

/** Pantalla que abre un aviso segun su `data`. Los canales los fija el backend (push.service). */
export function routeForNotification(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  const type = typeof data.type === 'string' ? data.type : '';
  const tradeId = typeof data.tradeId === 'string' ? data.tradeId : '';
  const requestId = typeof data.requestId === 'string' ? data.requestId : '';

  if (type === 'trade_update' && tradeId) return `/trade/${encodeURIComponent(tradeId)}`;
  // El agente atiende la operacion nueva desde su bandeja, no desde el detalle.
  if (type === 'new_trade') return '/inbox';
  if (type === 'sign_request' && requestId) return `/sign-request/${encodeURIComponent(requestId)}`;
  // El saldo nuevo se ve en el inicio.
  if (type === 'payment_received') return '/';
  return null;
}

function isSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PushNotifications');
}

function toPermission(receive: string): PushPermission {
  if (receive === 'granted') return 'granted';
  if (receive === 'denied') return 'denied';
  return 'prompt';
}

export async function getPushPermission(): Promise<PushPermission> {
  if (!isSupported()) return 'unsupported';
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const { receive } = await PushNotifications.checkPermissions();
  return toPermission(receive);
}

/**
 * Pide el permiso si todavia no se pidio. Android solo muestra el dialogo una
 * vez: despues de un "no", la unica salida es Ajustes del telefono.
 */
export async function requestPushPermission(): Promise<PushPermission> {
  if (!isSupported()) return 'unsupported';
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const current = toPermission((await PushNotifications.checkPermissions()).receive);
  if (current !== 'prompt') return current;
  const result = toPermission((await PushNotifications.requestPermissions()).receive);
  if (result === 'granted') window.dispatchEvent(new Event(PUSH_PERMISSION_GRANTED_EVENT));
  return result;
}

/**
 * Registra el telefono si hay permiso y escucha los avisos tocados. Devuelve
 * con que deshacer los listeners (al cerrar sesion o cambiar de cuenta).
 */
export async function startPush(handlers: {
  askPermission: boolean;
  onToken: (pushToken: string) => void;
  onOpen: (route: string) => void;
}): Promise<() => void> {
  const noop = () => {};
  if (!isSupported()) return noop;

  const { PushNotifications } = await import('@capacitor/push-notifications');

  let permission = toPermission((await PushNotifications.checkPermissions()).receive);
  if (permission === 'prompt' && handlers.askPermission) {
    permission = toPermission((await PushNotifications.requestPermissions()).receive);
  }
  if (permission !== 'granted') return noop;

  // Los mismos `channelId` que usa el backend. Sin el canal creado, Android
  // manda el aviso al canal generico, sin sonido ni prioridad alta. Los canales
  // solo existen en Android: en iOS el metodo no esta implementado y se ignora.
  try {
    await PushNotifications.createChannel({
      id: 'trade_alerts',
      name: 'Operaciones',
      description: 'Operaciones nuevas, cancelaciones y reembolsos',
      importance: 5,
      // Privado: en la pantalla bloqueada se ve que hay aviso, no el monto.
      visibility: 0,
      sound: 'default',
    });
    await PushNotifications.createChannel({
      id: 'sign_alerts',
      name: 'Solicitudes de firma',
      description: 'Firmas pedidas desde otro dispositivo',
      importance: 5,
      visibility: 0,
      sound: 'default',
    });
  } catch {
    // iOS: sin canales.
  }

  const listeners = await Promise.all([
    PushNotifications.addListener('registration', (token) => handlers.onToken(token.value)),
    PushNotifications.addListener('registrationError', (err) => {
      console.warn('[push] No se pudo registrar el telefono', err.error);
    }),
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const route = routeForNotification(action.notification.data);
      if (route) handlers.onOpen(route);
    }),
  ]);

  await PushNotifications.register();

  return () => {
    for (const l of listeners) void l.remove();
  };
}
