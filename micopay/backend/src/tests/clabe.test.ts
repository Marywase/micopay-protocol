// Prueba: validateClabe acepta solo CLABEs con el digito de control correcto
// (algoritmo del Banco de Mexico).

import { ok, strictEqual } from 'node:assert';
import { validateClabe } from '../services/rampWithdraw.service.js';

async function run() {
  console.log('Running CLABE validation tests...');

  console.log('  1. formato invalido');
  for (const bad of ['', '123', 'abcdefghijklmnopqr', '12345678901234567', '1234567890123456789', 'XAXX010101000----']) {
    ok(!validateClabe(bad), `deberia rechazar "${bad}"`);
  }

  console.log('  2. CLABE de ejemplo de la documentacion de Etherfuse');
  // De /v2/api-reference/payment-accounts: ejemplo "012180000000000002"
  ok(validateClabe('012180000000000002'));
  // ejemplo de response: "646180000000000009"
  ok(validateClabe('646180000000000009'));

  console.log('  3. digito de control invalido');
  ok(!validateClabe('012180000000000001'));
  ok(!validateClabe('012180000000000003'));

  console.log('  4. CLABE ficticia de 11 digitos, con digito calculado');
  // 012 (BBVA) + 180 (plaza) + 01234567890 (cuenta ficticia) + 9 (check).
  // El 9 lo calcula el mismo algoritmo oficial del Banco de Mexico.
  ok(validateClabe('012180012345678909'));

  console.log('\nAll CLABE validation tests passed.');
  strictEqual(true, true);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
