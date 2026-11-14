import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailValido, senhaForte, soDigitos, paraKg, exigir } from '../server/lib/validators.js';

test('emailValido aceita e-mails comuns e recusa malformados', () => {
  assert.equal(emailValido('osc1@colheita.local'), true);
  assert.equal(emailValido('nome.sobrenome@empresa.com.br'), true);
  assert.equal(emailValido('sem-arroba.com'), false);
  assert.equal(emailValido('a@b'), false);
  assert.equal(emailValido('com espaco@x.com'), false);
  assert.equal(emailValido(null), false);
});

test('senhaForte exige 8+ caracteres com letra e número', () => {
  assert.equal(senhaForte('Senha@123'), true);
  assert.equal(senhaForte('abc12345'), true);
  assert.equal(senhaForte('curta1'), false);
  assert.equal(senhaForte('somenteletras'), false);
  assert.equal(senhaForte('12345678'), false);
  assert.equal(senhaForte(12345678), false);
});

test('soDigitos remove a máscara', () => {
  assert.equal(soDigitos('12.345.678/0001-90'), '12345678000190');
  assert.equal(soDigitos(undefined), '');
});

test('paraKg recusa quantidade ou unidade inválida', () => {
  assert.equal(paraKg(500, 'ML'), 0.5);
  assert.throws(() => paraKg(0, 'kg'), { status: 400 });
  assert.throws(() => paraKg(1, 'caixa'), { status: 400 });
  assert.throws(() => paraKg('abc', 'kg'), { status: 400 });
});
