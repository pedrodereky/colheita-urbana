import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exigir } from '../server/lib/validators.js';

test('exigir.texto apara espaços e valida tamanho', () => {
  assert.equal(exigir.texto({ nome: '  Padaria  ' }, 'nome', 'o nome'), 'Padaria');
  assert.throws(() => exigir.texto({ nome: '   ' }, 'nome', 'o nome'), { status: 400, code: 'CAMPO_OBRIGATORIO' });
  assert.throws(() => exigir.texto({ nome: 'abcdef' }, 'nome', 'Nome', { max: 5 }), { code: 'CAMPO_LONGO' });
});

test('exigir.opcional devolve null quando vazio', () => {
  assert.equal(exigir.opcional({}, 'obs'), null);
  assert.equal(exigir.opcional({ obs: ' ok ' }, 'obs'), 'ok');
});

test('exigir.numero respeita limites e recusa vazio', () => {
  assert.equal(exigir.numero({ kg: '2.5' }, 'kg', 'Peso'), 2.5);
  assert.throws(() => exigir.numero({ kg: '' }, 'kg', 'Peso'), { code: 'NUMERO_INVALIDO' });
  assert.throws(() => exigir.numero({ kg: 11 }, 'kg', 'Peso', { max: 10 }), { code: 'NUMERO_INVALIDO' });
});

test('exigir.data, enum e coordenadas', () => {
  assert.ok(exigir.data({ d: '2026-01-01T10:00:00Z' }, 'd', 'Data') instanceof Date);
  assert.throws(() => exigir.data({ d: 'ontem' }, 'd', 'Data'), { code: 'DATA_INVALIDA' });
  assert.equal(exigir.enum({ c: 'AMBIENTE' }, 'c', 'Conservação', ['AMBIENTE', 'REFRIGERADO']), 'AMBIENTE');
  assert.throws(() => exigir.enum({ c: 'x' }, 'c', 'Conservação', ['AMBIENTE']), { code: 'VALOR_INVALIDO' });
  assert.deepEqual(exigir.coordenadas({ latitude: -15.79, longitude: -47.88 }), { latitude: -15.79, longitude: -47.88 });
  assert.throws(() => exigir.coordenadas({ latitude: 91, longitude: 0 }), { code: 'NUMERO_INVALIDO' });
});
