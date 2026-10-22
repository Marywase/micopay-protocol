// Prueba: verifyWebhookSignature acepta solo firmas correctas, rechaza las
// manipuladas y es tolerante a los casos invalidos sin lanzar.

import { createHmac, randomBytes } from 'node:crypto';
import { ok, strictEqual } from 'node:assert';
import { verifyWebhookSignature } from '../services/etherfuseV2.service.js';

function sign(body: string, secret: Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

async function run() {
  console.log('Running Etherfuse v2 webhook signature tests...');

  const secretBytes = randomBytes(32);
  const secretB64u = secretBytes.toString('base64url');
  const body = JSON.stringify({ event: 'orderUpdated', data: { id: 'abc', status: 'funded' } });

  console.log('  1. firma correcta pasa');
  ok(verifyWebhookSignature(body, sign(body, secretBytes), secretB64u));

  console.log('  2. body cambiado falla');
  ok(!verifyWebhookSignature(body + ' ', sign(body, secretBytes), secretB64u));

  console.log('  3. secret distinto falla');
  const otroSecret = randomBytes(32).toString('base64url');
  ok(!verifyWebhookSignature(body, sign(body, secretBytes), otroSecret));

  console.log('  4. header sin prefijo sha256= falla');
  const sig = createHmac('sha256', secretBytes).update(body).digest('hex');
  ok(!verifyWebhookSignature(body, sig, secretB64u));

  console.log('  5. header ausente, secret vacio y hex no-hex → false, no lanza');
  ok(!verifyWebhookSignature(body, undefined, secretB64u));
  ok(!verifyWebhookSignature(body, 'sha256=xxxx', secretB64u));
  ok(!verifyWebhookSignature(body, sign(body, secretBytes), ''));

  console.log('  6. acepta body como Buffer');
  const buf = Buffer.from(body);
  ok(verifyWebhookSignature(buf, sign(body, secretBytes), secretB64u));

  console.log('  7. diferencia de longitud en la firma falla (sin igualar longitudes)');
  const corta = 'sha256=' + 'ab'.repeat(10);
  ok(!verifyWebhookSignature(body, corta, secretB64u));

  console.log('\nAll Etherfuse v2 webhook signature tests passed.');
  strictEqual(true, true);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
