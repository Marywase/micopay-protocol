// Llave para abrir /idv de Etherfuse. Nosotros firmamos un JWT por usuario
// con la privada; Etherfuse busca la publica en nuestra JWKS URL y verifica.
// Panel de Etherfuse: issuer = https://api.micopay.app,
// jwks = https://api.micopay.app/.well-known/jwks.json.

import { createHash, createPublicKey, type JsonWebKey } from 'node:crypto';

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
}
