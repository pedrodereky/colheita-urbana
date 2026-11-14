import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm } from '../server/lib/maps.js';

test('haversineKm calcula distâncias conhecidas', () => {
  const p = { latitude: -15.7939, longitude: -47.8828 };
  assert.equal(haversineKm(p, p), 0);
  // 1 grau de latitude ≈ 111,19 km
  const um = haversineKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
  assert.ok(Math.abs(um - 111.19) < 0.05, `obtido ${um}`);
  // simétrica
  const q = { latitude: -23.5505, longitude: -46.6333 };
  assert.equal(haversineKm(p, q), haversineKm(q, p));
  // Brasília -> São Paulo ≈ 873 km em linha reta
  assert.ok(Math.abs(haversineKm(p, q) - 873) < 10);
});
