import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { existsSync } from 'fs';
import { config } from '../config.js';
import db from '../db/schema.js';
import pino from 'pino';

const logger = pino({ name: 'push.service' });

let messaging: admin.messaging.Messaging | null = null;
let initialized = false;

/**
 * Initialize Firebase Admin SDK for FCM messaging.
 * Supports both service account JSON file and individual credential env vars.
 */
function initializeFirebase() {
  if (initialized) return;

  try {
    let serviceAccount: any;

    // Try loading from GOOGLE_APPLICATION_CREDENTIALS or FCM_SERVICE_ACCOUNT_JSON
    const serviceAccountPath =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      process.env.FCM_SERVICE_ACCOUNT_JSON;

    if (serviceAccountPath && existsSync(serviceAccountPath)) {
      try {
        const content = readFileSync(serviceAccountPath, 'utf-8');
        serviceAccount = JSON.parse(content);
      } catch (err) {
        logger.warn(
          { err, path: serviceAccountPath },
          'Failed to parse service account JSON file'
        );
      }
    }

    // Fallback: use individual env vars
    if (!serviceAccount) {
      if (
        process.env.FIREBASE_PROJECT_ID &&
        process.env.FIREBASE_CLIENT_EMAIL &&
        process.env.FIREBASE_PRIVATE_KEY
      ) {
        serviceAccount = {
          type: 'service_account',
          project_id: process.env.FIREBASE_PROJECT_ID,
          private_key_id: 'key-id',
          private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
          client_id: 'client-id',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
        };
      }
    }

    if (!serviceAccount) {
      logger.warn(
        'Firebase credentials not configured. Push notifications disabled. ' +
        'Set GOOGLE_APPLICATION_CREDENTIALS, FCM_SERVICE_ACCOUNT_JSON, or FIREBASE_* env vars.'
      );
      initialized = true;
      return;
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    messaging = admin.messaging();
    logger.info('Firebase Admin SDK initialized for push notifications');
    initialized = true;
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Firebase Admin SDK');
    initialized = true;
  }
}

type PushChannel = 'trade_alerts' | 'sign_alerts';

/**
 * Solo para pruebas: sustituye el cliente de Firebase por uno falso, para ver a
 * quien se dirige cada aviso sin credenciales ni red.
 */
export function setMessagingForTests(fake: Pick<admin.messaging.Messaging, 'send'> | null) {
  messaging = fake as admin.messaging.Messaging | null;
  initialized = true;
}

/**
 * Envia un aviso al telefono de `userId`. Nunca lanza: un aviso que no sale no
 * debe tumbar la operacion que lo disparo. Devuelve si se envio.
 *
 * `data` lleva lo que la app necesita para abrir la pantalla correcta al tocar
 * el aviso (`type` y el id). FCM solo acepta strings en `data`.
 */
async function sendToUser(
  userId: string,
  notification: { title: string; body: string },
  data: Record<string, string>,
  channelId: PushChannel,
): Promise<boolean> {
  if (!initialized) {
    initializeFirebase();
  }

  if (!messaging) {
    logger.info({ user_id: userId, type: data.type }, 'Firebase messaging not available, skipping push notification');
    return false;
  }

  let token: string | null = null;
  try {
    const user = await db.getOne<{ push_token: string | null }>(
      'SELECT push_token FROM users WHERE id = $1',
      [userId],
    );
    token = user?.push_token ?? null;
  } catch (err) {
    logger.error({ err, user_id: userId, type: data.type }, 'Failed to read push token');
    return false;
  }

  if (!token) {
    logger.info({ user_id: userId, type: data.type }, 'User has no push token, skipping push notification');
    return false;
  }

  try {
    await messaging.send({
      notification,
      data,
      android: {
        priority: 'high',
        notification: {
          channelId,
          priority: 'max',
          defaultSound: true,
          sound: 'default',
        },
      },
      token,
    });
    logger.info({ user_id: userId, type: data.type }, 'Push notification sent successfully');
    return true;
  } catch (err: any) {
    // El token ya no sirve (app desinstalada, datos borrados): se limpia para
    // no seguir intentando. La app manda uno nuevo la proxima vez que abra.
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      logger.warn({ user_id: userId, error_code: err.code }, 'FCM token expired, clearing for user');
      try {
        await db.execute('UPDATE users SET push_token = NULL WHERE id = $1', [userId]);
      } catch (updateErr) {
        logger.error({ err: updateErr }, 'Failed to clear expired push token');
      }
      return false;
    }

    logger.error({ err, user_id: userId, type: data.type }, 'Failed to send push notification');
    return false;
  }
}

export interface TradeNotificationPayload {
  tradeId: string;
  amount: string; // formatted with currency (e.g., "500.00 MXN")
  buyerUsername: string;
}

/**
 * Send a push notification to a merchant when a trade is created.
 * Fire-and-forget: never throws or fails the trade creation.
 */
export async function sendTradeNotificationToMerchant(
  merchantUserId: string,
  payload: TradeNotificationPayload
): Promise<void> {
  await sendToUser(
    merchantUserId,
    {
      title: 'Nueva solicitud de intercambio',
      body: `${payload.buyerUsername} quiere intercambiar ${payload.amount}`,
    },
    { type: 'new_trade', tradeId: payload.tradeId },
    'trade_alerts',
  );
}

/**
 * Cambios de una operacion que le importan a la contraparte de quien actuo.
 * Antes solo se avisaba al agente de una operacion nueva; el cliente no se
 * enteraba de nada si no tenia la pantalla abierta.
 */
export type TradeUpdateKind = 'locked' | 'cancelled' | 'refunded' | 'completed';

export interface TradeUpdatePayload {
  tradeId: string;
  kind: TradeUpdateKind;
  amountMxn: number;
  /** Solo en `cancelled` con fondos bloqueados y dirigido a quien los bloqueo. */
  refundAvailableAt?: string | Date | null;
}

function formatMxn(amount: number): string {
  return `$${amount.toLocaleString('es-MX', { maximumFractionDigits: 2 })} MXN`;
}

function formatTimeMx(when: string | Date): string {
  return new Date(when).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Mexico_City',
  });
}

export function buildTradeUpdateMessage(payload: TradeUpdatePayload): { title: string; body: string } {
  const amount = formatMxn(payload.amountMxn);
  switch (payload.kind) {
    case 'locked':
      return {
        title: 'Fondos asegurados',
        body: `Los ${amount} de tu operación ya están bloqueados. Ya pueden reunirse.`,
      };
    case 'cancelled':
      return {
        title: 'La operación se canceló',
        body: payload.refundAvailableAt
          ? `Tus ${amount} regresan a tu cuenta automáticamente a partir de las ${formatTimeMx(payload.refundAvailableAt)}.`
          : `La operación de ${amount} se canceló.`,
      };
    case 'refunded':
      return {
        title: 'Reembolso hecho',
        body: `Tus ${amount} ya están de vuelta en tu cuenta.`,
      };
    case 'completed':
      return {
        title: 'Operación completada',
        body: `La operación de ${amount} se completó.`,
      };
  }
}

/** Fire-and-forget, igual que el aviso de operacion nueva. */
export async function sendTradeUpdateNotification(
  userId: string,
  payload: TradeUpdatePayload,
): Promise<boolean> {
  return sendToUser(
    userId,
    buildTradeUpdateMessage(payload),
    { type: 'trade_update', kind: payload.kind, tradeId: payload.tradeId },
    'trade_alerts',
  );
}

export interface PaymentReceivedPayload {
  txHash: string;
  amount: string; // ya formateado, sin ceros de sobra
  asset: string;
  senderUsername: string | null;
}

export function buildPaymentReceivedMessage(payload: PaymentReceivedPayload): { title: string; body: string } {
  const from = payload.senderUsername ? ` de @${payload.senderUsername}` : '';
  return {
    title: 'Recibiste dinero',
    body: `Te llegaron ${payload.amount} ${payload.asset}${from}.`,
  };
}

/** Pago directo entre usuarios (Enviar pago). Ver paymentNotify.service. */
export async function sendPaymentReceivedNotification(
  userId: string,
  payload: PaymentReceivedPayload,
): Promise<boolean> {
  return sendToUser(
    userId,
    buildPaymentReceivedMessage(payload),
    { type: 'payment_received', txHash: payload.txHash },
    'trade_alerts',
  );
}

export interface BankWithdrawCompletedPayload {
  orderId: string;
  amountMxn: string;
  clabeLast4: string | null;
}

export function buildBankWithdrawCompletedMessage(payload: BankWithdrawCompletedPayload): { title: string; body: string } {
  const cuenta = payload.clabeLast4 ? ` a tu cuenta •••${payload.clabeLast4}` : '';
  return {
    title: 'Tu retiro llegó',
    body: `Enviamos $${payload.amountMxn} MXN${cuenta}.`,
  };
}

/** Llega cuando el webhook orderUpdated marca la orden como completed. */
export async function sendBankWithdrawCompletedNotification(
  userId: string,
  payload: BankWithdrawCompletedPayload,
): Promise<boolean> {
  return sendToUser(
    userId,
    buildBankWithdrawCompletedMessage(payload),
    { type: 'bank_withdraw_completed', orderId: payload.orderId },
    'trade_alerts',
  );
}

export interface SignRequestNotificationPayload {
  requestId: string;
  instruction?: string;
  deviceName?: string;
}

/**
 * Send a push notification to a user when a delegated sign request arrives.
 * Returns true if push notification was sent, false otherwise.
 */
export async function sendSignRequestNotification(
  userId: string,
  payload: SignRequestNotificationPayload
): Promise<boolean> {
  return sendToUser(
    userId,
    {
      title: 'Solicitud de Firma Recibida 🔐',
      body: payload.instruction || `Solicitud de firma desde ${payload.deviceName || 'dispositivo conectado'}`,
    },
    { type: 'sign_request', requestId: payload.requestId },
    'sign_alerts',
  );
}
