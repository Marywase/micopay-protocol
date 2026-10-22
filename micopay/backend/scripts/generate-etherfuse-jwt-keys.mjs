#!/usr/bin/env node
/**
 * Genera un par RSA 2048 para firmar los JWT que abren /idv de Etherfuse,
 * y lo escribe en SSM Parameter Store. La llave privada nunca pasa por
 * argumentos de proceso ni por stdout.
 *
 * Uso:
 *   node scripts/generate-etherfuse-jwt-keys.mjs sandbox
 *   node scripts/generate-etherfuse-jwt-keys.mjs prod
 *
 * Requiere: AWS CLI con credenciales activas y permiso ssm:PutParameter sobre
 * /micopay/{env}/ETHERFUSE_JWT_*. Si ya existe el parametro, se usa --overwrite.
 *
 * Lo que se imprime: solo la publica (PEM), el kid (thumbprint RFC 7638) y las
 * dos rutas de SSM. Lo que NO se imprime: la privada, nunca.
 */

import { generateKeyPairSync, createHash, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.argv[2];
if (!['sandbox', 'prod'].includes(env ?? '')) {
  console.error('Uso: node scripts/generate-etherfuse-jwt-keys.mjs {sandbox|prod}');
  process.exit(1);
}

const privateParam = `/micopay/${env}/ETHERFUSE_JWT_PRIVATE_KEY_PEM`;
const publicParam = `/micopay/${env}/ETHERFUSE_JWT_PUBLIC_KEY_PEM`;

console.log(`Generando RSA 2048 para ${env}...`);
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const jwk = createPublicKey(publicKey).export({ format: 'jwk' });
const canonical = `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`;
const kid = createHash('sha256').update(canonical).digest('base64url');

function putParameter(name, value, type) {
  // El valor va por archivo temporal (--value file://<path>) para que no
  // aparezca en argv ni en el historial del shell. El dir es de este usuario
  // (tmpdir) y se borra justo despues del put.
  const dir = mkdtempSync(join(tmpdir(), 'etherfuse-jwt-'));
  const file = join(dir, 'v');
  try {
    writeFileSync(file, value, { mode: 0o600 });
    const r = spawnSync(
      'aws',
      ['ssm', 'put-parameter', '--name', name, '--type', type, '--overwrite', '--value', `file://${file}`],
      { encoding: 'utf-8' }
    );
    if (r.status !== 0) {
      console.error(`FALLO ssm put-parameter ${name}: ${r.stderr}`);
      process.exit(1);
    }
    console.log(`OK ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

putParameter(privateParam, privateKey, 'SecureString');
putParameter(publicParam, publicKey, 'String');

console.log('\n--- Lista para el panel de Etherfuse ---');
console.log(`Entorno: ${env}`);
console.log(`Issuer URL: https://api.micopay.app`);
console.log(`JWKS URL:   https://api.micopay.app/.well-known/jwks.json`);
console.log(`kid (RFC 7638): ${kid}`);
console.log('\n--- Llave publica (PEM) ---');
console.log(publicKey);
console.log('--- La llave privada quedo en SSM, no se imprime ---');
