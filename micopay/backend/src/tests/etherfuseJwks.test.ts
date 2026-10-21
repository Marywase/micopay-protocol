// Prueba: PEM publico -> JWKS valido, el kid es estable y una firma hecha
// con la privada se verifica con la JWK publica.

import { generateKeyPairSync, createSign, createVerify, createPublicKey } from 'node:crypto';
import { strictEqual, ok, equal } from 'node:assert';
import {
  publicPemToJwk,
  rfc7638Thumbprint,
  getPublicJwks,
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

  console.log('\nAll Etherfuse JWKS tests passed.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
