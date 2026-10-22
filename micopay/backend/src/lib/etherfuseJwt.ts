// Llave para abrir /idv de Etherfuse. Nosotros firmamos un JWT por usuario
// con la privada; Etherfuse busca la publica en nuestra JWKS URL y verifica.
// Panel de Etherfuse: issuer = https://api.micopay.app,
// jwks = https://api.micopay.app/.well-known/jwks.json.

import { createHash, createPrivateKey, createPublicKey, createSign, type JsonWebKey } from 'node:crypto';

export interface PublicJwk extends JsonWebKey {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  use: 'sig';
  alg: 'RS256';
}

export interface Jwks {
  keys: PublicJwk[];
}

/**
 * RFC 7638 thumbprint: sha256 del JWK canonico (solo kty/n/e, orden alfabetico),
 * base64url. Igual en Etherfuse y aqui, no cambia si el PEM se re-serializa.
 */
export function rfc7638Thumbprint(n: string, e: string): string {
  const canonical = `{"e":"${e}","kty":"RSA","n":"${n}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

export function publicPemToJwk(pem: string): PublicJwk {
  const trimmed = pem.trim();
  if (!trimmed.includes('BEGIN PUBLIC KEY') && !trimmed.includes('BEGIN RSA PUBLIC KEY')) {
    throw new Error('etherfuseJwt: PEM no es una llave publica');
  }
  const key = createPublicKey(trimmed);
  const jwk = key.export({ format: 'jwk' }) as JsonWebKey & { kty?: string; n?: string; e?: string };
  if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error(`etherfuseJwt: solo RSA; se recibio kty=${jwk.kty ?? 'desconocido'}`);
  }
  return {
    kty: 'RSA',
    n: jwk.n,
    e: jwk.e,
    kid: rfc7638Thumbprint(jwk.n, jwk.e),
    use: 'sig',
    alg: 'RS256',
  };
}

let cachedJwks: Jwks | null = null;
let cachedFromPem: string | null = null;

/**
 * Devuelve el JWKS a partir de ETHERFUSE_JWT_PUBLIC_KEY_PEM. Se guarda en memoria
 * para no re-parsear la llave en cada request. Si cambia el env (restart), se
 * vuelve a leer.
 */
export function getPublicJwks(): Jwks {
  const pem = process.env.ETHERFUSE_JWT_PUBLIC_KEY_PEM;
  if (!pem) {
    throw new Error('ETHERFUSE_JWT_PUBLIC_KEY_PEM no esta configurado');
  }
  if (cachedJwks && cachedFromPem === pem) return cachedJwks;
  cachedJwks = { keys: [publicPemToJwk(pem)] };
  cachedFromPem = pem;
  return cachedJwks;
}

/** Para pruebas; limpia el cache. No usar en runtime. */
export function _resetJwksCacheForTests(): void {
  cachedJwks = null;
  cachedFromPem = null;
  cachedPrivateKid = null;
  cachedPrivatePem = null;
}

// --- Firma de JWT para abrir /idv ----------------------------------------

let cachedPrivateKid: string | null = null;
let cachedPrivatePem: string | null = null;

function base64url(buf: Buffer | string): string {
  return (typeof buf === 'string' ? Buffer.from(buf) : buf).toString('base64url');
}

/**
 * Deriva el kid de la llave privada (debe coincidir con el de la publica, por
 * eso usamos la misma funcion). Se cachea para no re-exportar el JWK en cada
 * firma.
 */
function getPrivateKid(pem: string): string {
  if (cachedPrivateKid && cachedPrivatePem === pem) return cachedPrivateKid;
  const priv = createPrivateKey(pem);
  const pub = createPublicKey(priv).export({ format: 'jwk' }) as { n?: string; e?: string };
  if (!pub.n || !pub.e) {
    throw new Error('etherfuseJwt: la llave privada no es RSA');
  }
  cachedPrivateKid = rfc7638Thumbprint(pub.n, pub.e);
  cachedPrivatePem = pem;
  return cachedPrivateKid;
}

export interface SignLaunchOptions {
  /** Segundos de vigencia del JWT. Default 300 (5 min). */
  ttlSeconds?: number;
  /** Reclamos adicionales (aud, scope, etc.) segun lo que Etherfuse espere. */
  extraClaims?: Record<string, unknown>;
  /** Issuer; default lee de ETHERFUSE_JWT_ISSUER o https://api.micopay.app. */
  issuer?: string;
  /** Para pruebas: inyecta la hora. */
  nowSec?: number;
}

/**
 * Firma un JWT RS256 para abrir /idv de Etherfuse con un cliente especifico.
 * Reclamos: iss, sub (customer id de Etherfuse), iat, exp, jti.
 *
 * Etherfuse busca la publica via la URL JWKS registrada en su panel y verifica.
 * El panel exige que `iss` sea exactamente el registrado.
 */
export function signLaunchToken(subject: string, opts: SignLaunchOptions = {}): string {
  const pem = process.env.ETHERFUSE_JWT_PRIVATE_KEY_PEM;
  if (!pem) {
    throw new Error('ETHERFUSE_JWT_PRIVATE_KEY_PEM no esta configurado');
  }
  if (!subject || typeof subject !== 'string') {
    throw new Error('signLaunchToken: subject es requerido');
  }
  const kid = getPrivateKid(pem);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 300;
  if (ttl <= 0 || ttl > 3600) {
    throw new Error('signLaunchToken: ttlSeconds fuera de rango (1..3600)');
  }
  const issuer = opts.issuer ?? process.env.ETHERFUSE_JWT_ISSUER ?? 'https://api.micopay.app';

  const header = { alg: 'RS256', typ: 'JWT', kid };
  const payload = {
    iss: issuer,
    sub: subject,
    iat: now,
    exp: now + ttl,
    jti: `${now}-${createHash('sha256').update(subject + now).digest('base64url').slice(0, 16)}`,
    ...opts.extraClaims,
  };

  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const sig = base64url(signer.sign(createPrivateKey(pem)));
  return `${h}.${p}.${sig}`;
}
