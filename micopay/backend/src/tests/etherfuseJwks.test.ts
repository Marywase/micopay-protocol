// Prueba: PEM publico -> JWKS valido, el kid es estable y una firma hecha
// con la privada se verifica con la JWK publica.

import { generateKeyPairSync, createSign, createVerify, createPublicKey } from 'node:crypto';
import { strictEqual, ok, equal } from 'node:assert';
import {
  publicPemToJwk,
  rfc7638Thumbprint,
  getPublicJwks,
  signLaunchToken,
  _resetJwksCacheForTests,
} from '../lib/etherfuseJwt.js';

async function run() {
  console.log('Running Etherfuse JWKS tests...');

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  console.log('  1. publicPemToJwk: campos obligatorios');
  const jwk = publicPemToJwk(publicKey);
  strictEqual(jwk.kty, 'RSA');
  strictEqual(jwk.use, 'sig');
  strictEqual(jwk.alg, 'RS256');
  ok(typeof jwk.n === 'string' && jwk.n.length > 0);
  strictEqual(jwk.e, 'AQAB');
  ok(typeof jwk.kid === 'string' && jwk.kid.length === 43, `kid base64url sha256 = 43 chars, got ${jwk.kid.length}`);

  console.log('  2. kid estable: dos conversiones dan el mismo thumbprint');
  const jwk2 = publicPemToJwk(publicKey);
  strictEqual(jwk.kid, jwk2.kid);
  strictEqual(jwk.kid, rfc7638Thumbprint(jwk.n, jwk.e));

  console.log('  3. getPublicJwks lee del env y cachea');
  process.env.ETHERFUSE_JWT_PUBLIC_KEY_PEM = publicKey;
  _resetJwksCacheForTests();
  const jwks = getPublicJwks();
  strictEqual(jwks.keys.length, 1);
  strictEqual(jwks.keys[0].kid, jwk.kid);
  const jwks2 = getPublicJwks();
  equal(jwks, jwks2, 'segunda llamada reusa el cache');

  console.log('  4. getPublicJwks sin env lanza error');
  delete process.env.ETHERFUSE_JWT_PUBLIC_KEY_PEM;
  _resetJwksCacheForTests();
  try {
    getPublicJwks();
    throw new Error('deberia haber lanzado');
  } catch (err: any) {
    ok(String(err.message).includes('ETHERFUSE_JWT_PUBLIC_KEY_PEM'));
  }

  console.log('  5. una firma RS256 con la privada se verifica con la JWK publica');
  const payload = Buffer.from('.test-payload-' + Date.now());
  const signer = createSign('RSA-SHA256');
  signer.update(payload);
  const sig = signer.sign(privateKey);
  // Reconstruir la publica a partir de la JWK y verificar.
  const reconstructed = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(payload);
  ok(verifier.verify(reconstructed, sig), 'firma debe verificarse con la JWK publica');

  console.log('  6. publicPemToJwk rechaza PEM que no es publica');
  try {
    publicPemToJwk(privateKey);
    throw new Error('deberia haber lanzado');
  } catch (err: any) {
    ok(String(err.message).includes('publica'));
  }

  console.log('  7. signLaunchToken produce RS256 verificable con la publica');
  process.env.ETHERFUSE_JWT_PRIVATE_KEY_PEM = privateKey;
  process.env.ETHERFUSE_JWT_PUBLIC_KEY_PEM = publicKey;
  _resetJwksCacheForTests();
  const token = signLaunchToken('customer-abc-123', { ttlSeconds: 300, nowSec: 1700000000 });
  const parts = token.split('.');
  strictEqual(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  strictEqual(header.alg, 'RS256');
  strictEqual(header.typ, 'JWT');
  strictEqual(header.kid, jwk.kid);
  strictEqual(claims.iss, 'https://api.micopay.app');
  strictEqual(claims.sub, 'customer-abc-123');
  strictEqual(claims.iat, 1700000000);
  strictEqual(claims.exp, 1700000300);
  ok(typeof claims.jti === 'string' && claims.jti.length > 0);
  // verifica la firma usando la publica
  const signedBytes = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sigBytes = Buffer.from(parts[2], 'base64url');
  const vv = createVerify('RSA-SHA256');
  vv.update(signedBytes);
  ok(vv.verify(createPublicKey(publicKey), sigBytes), 'firma del JWT debe verificar');

  console.log('  8. signLaunchToken sin subject, sin privada o ttl invalido lanza');
  for (const [name, fn] of [
    ['sin subject', () => signLaunchToken('')],
    ['sin privada', () => {
      delete process.env.ETHERFUSE_JWT_PRIVATE_KEY_PEM;
      try { signLaunchToken('x'); } finally { process.env.ETHERFUSE_JWT_PRIVATE_KEY_PEM = privateKey; }
    }],
    ['ttl 0', () => signLaunchToken('x', { ttlSeconds: 0 })],
    ['ttl 7200', () => signLaunchToken('x', { ttlSeconds: 7200 })],
  ] as const) {
    try { fn(); throw new Error(`${name} deberia haber lanzado`); } catch (err: any) {
      ok(err.message, name);
    }
  }

  console.log('  9. extraClaims se mezclan y el issuer es sobreescribible');
  const t2 = signLaunchToken('u', { extraClaims: { aud: 'etherfuse-sandbox', scope: 'kyc' }, issuer: 'https://other.example', nowSec: 1700000000 });
  const c2 = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString('utf-8'));
  strictEqual(c2.aud, 'etherfuse-sandbox');
  strictEqual(c2.scope, 'kyc');
  strictEqual(c2.iss, 'https://other.example');

  console.log('\nAll Etherfuse JWKS tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
