// Prueba: verifyWebhookSignature acepta solo firmas correctas, rechaza las
// manipuladas y es tolerante a los casos invalidos sin lanzar.

import { createHmac, randomBytes } from 'node:crypto';
import { ok, strictEqual } from 'node:assert';
import { canonicalJson, mapEtherfuseKyc, verifyWebhookSignature } from '../services/etherfuseV2.service.js';

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

  console.log('  8. firma sobre el JSON canonico (RFC 8785) pasa aunque el body llegue con otro orden y espacios');
  // Ejemplo de kycUpdated de openapi-v2.json, firmado como Etherfuse: sobre la forma canonica.
  const evento = {
    event: 'kycUpdated',
    eventId: '0d6f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    occurredAt: '2026-09-29T19:00:00Z',
    organizationId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    kyc: { status: 'inProgress', approved: false, needsWork: true, userMessage: 'Please upload a current government-issued ID.' },
  };
  const canonico = canonicalJson(evento);
  strictEqual(
    canonico,
    '{"event":"kycUpdated","eventId":"0d6f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b","kyc":{"approved":false,"needsWork":true,"status":"inProgress","userMessage":"Please upload a current government-issued ID."},"occurredAt":"2026-09-29T19:00:00Z","organizationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890"}',
  );
  const desordenado = JSON.stringify(evento, null, 2);
  ok(verifyWebhookSignature(desordenado, sign(canonico, secretBytes), secretB64u));

  console.log('  9. el JSON canonico con un valor cambiado falla');
  const alterado = JSON.stringify({ ...evento, organizationId: 'ffffffff-e5f6-7890-abcd-ef1234567890' });
  ok(!verifyWebhookSignature(alterado, sign(canonico, secretBytes), secretB64u));

  console.log(' 10. body que no es JSON y no coincide en crudo → false, no lanza');
  ok(!verifyWebhookSignature('no-es-json', sign(canonico, secretBytes), secretB64u));

  console.log(' 11. canonicalJson: numeros, arrays anidados y llaves por unidades UTF-16');
  strictEqual(canonicalJson({ b: [1, 2.5, { z: null, a: 'x' }], a: 1e21, 'é': true, B: 0 }), '{"B":0,"a":1e+21,"b":[1,2.5,{"a":"x","z":null}],"é":true}');

  console.log(' 12. mapEtherfuseKyc: estados de Etherfuse a nuestra columna');
  strictEqual(mapEtherfuseKyc('approved', false), 'approved');
  strictEqual(mapEtherfuseKyc('approved', true), 'approved');
  strictEqual(mapEtherfuseKyc('denied', true), 'rejected');
  strictEqual(mapEtherfuseKyc('inProgress', true), 'action_required');
  strictEqual(mapEtherfuseKyc('inProgress', false), 'review');
  strictEqual(mapEtherfuseKyc('submitted', false), 'review');
  strictEqual(mapEtherfuseKyc('notStarted', false), 'not_started');

  console.log('\nAll Etherfuse v2 webhook signature tests passed.');
  strictEqual(true, true);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
