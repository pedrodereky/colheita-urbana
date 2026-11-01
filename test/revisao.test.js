import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cliente, criar, prepararGestor, gestor, dadosOferta, fechar, PNG, PDF, dbm } from './helpers.js';

after(fechar);
before(prepararGestor);
const codigo = (r) => r.dados.codigo;

test('OSC cancela reserva antes da coleta; oferta volta à fila e ela não reserva de novo (RN19)', async () => {
  const e = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC');
  const outra = await criar('OSC');
  const t = await criar('TRANSPORTADOR');
  const o = (await e.post('/api/ofertas', dadosOferta())).dados.oferta.id;
  const r = await osc.post(`/api/ofertas/${o}/reservar`, { modalidade: 'VOLUNTARIO' });
  await t.post(`/api/coletas/${r.dados.coletaId}/aceitar`);
  assert.ok((await osc.get(`/api/coletas/${r.dados.coletaId}`)).dados.entrega.acoes.includes('CANCELAR_RESERVA'));
  assert.equal((await outra.post(`/api/reservas/${r.dados.reservaId}/cancelar`)).status, 404);
  assert.equal((await osc.post(`/api/reservas/${r.dados.reservaId}/cancelar`, { justificativa: 'Sem espaço' })).status, 200);
  assert.equal((await e.get(`/api/ofertas/${o}`)).dados.oferta.estado, 'DISPONIVEL');
  assert.equal(codigo(await osc.post(`/api/ofertas/${o}/reservar`, { modalidade: 'VOLUNTARIO' })), 'RESERVA_DUPLICADA');
  assert.equal((await outra.post(`/api/ofertas/${o}/reservar`, { modalidade: 'VOLUNTARIO' })).status, 200);
  // sem falta para o transportador, e ele foi avisado
  assert.equal(dbm.get('SELECT faltas_consecutivas AS f FROM transportadores WHERE usuario_id=?', t.id).f, 0);
  assert.ok((await t.get('/api/notificacoes')).dados.notificacoes.some((n) => n.mensagem.includes('cancelada')));
});

test('cancelamento é recusado depois que os alimentos foram coletados', async () => {
  const e = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC');
  const o = (await e.post('/api/ofertas', dadosOferta())).dados.oferta.id;
  const r = await osc.post(`/api/ofertas/${o}/reservar`, { modalidade: 'PROPRIO', responsavelRetirada: 'Rita' });
  await osc.post(`/api/coletas/${r.dados.coletaId}/registrar-coleta`);
  assert.equal(codigo(await osc.post(`/api/reservas/${r.dados.reservaId}/cancelar`)), 'ESTADO_INVALIDO');
});

test('RN12: três recusas alertam o gestor, sem suspender automaticamente', async () => {
  const e = await criar('ESTABELECIMENTO');
  for (let i = 0; i < 3; i++) {
    const osc = await criar('OSC');
    const o = (await e.post('/api/ofertas', dadosOferta())).dados.oferta.id;
    const r = await osc.post(`/api/ofertas/${o}/reservar`, { modalidade: 'PROPRIO', responsavelRetirada: 'x' });
    await osc.post(`/api/coletas/${r.dados.coletaId}/registrar-coleta`);
    await osc.post(`/api/coletas/${r.dados.coletaId}/recusar`, { justificativa: 'Produto estragado' });
  }
  assert.equal((await e.get('/api/me')).dados.usuario.statusCadastro, 'APROVADO');
  assert.ok(dbm.get("SELECT 1 AS x FROM logs_auditoria WHERE acao='ALERTA_INCONSISTENCIAS' AND entidade_id=?", String(e.id)));
  const n = (await gestor.get('/api/notificacoes')).dados.notificacoes;
  assert.ok(n.some((x) => x.mensagem.includes('Avalie a suspensão')));
  // o gestor decide suspender
  assert.equal((await gestor.post(`/api/gestor/cadastros/${e.id}/suspender`, { justificativa: 'Reincidência' })).status, 200);
});

test('arquivos só podem ser abertos por quem tem direito', async () => {
  const e = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC');
  const outraOsc = await criar('OSC');
  const t = await criar('TRANSPORTADOR');
  const estranho = await criar('ESTABELECIMENTO');

  // comprovante: só a própria OSC e o gestor
  const comprovante = dbm.get('SELECT comprovante AS c FROM oscs WHERE usuario_id=?', osc.id).c;
  assert.equal((await osc.get(`/api/arquivos/${comprovante}`)).status, 200);
  assert.equal((await gestor.get(`/api/arquivos/${comprovante}`)).status, 200);
  assert.equal((await outraOsc.get(`/api/arquivos/${comprovante}`)).status, 403);
  assert.equal((await new Cliente().get(`/api/arquivos/${comprovante}`)).status, 401);

  // foto de oferta: qualquer usuário logado
  const of = (await e.post('/api/ofertas', dadosOferta({ imagens: [PNG] }))).dados.oferta;
  assert.equal((await outraOsc.get(`/api/arquivos/${of.imagens[0]}`)).status, 200);

  // evidência de problema: só partes da entrega e gestor
  const r = await osc.post(`/api/ofertas/${of.id}/reservar`, { modalidade: 'VOLUNTARIO' });
  await t.post(`/api/coletas/${r.dados.coletaId}/aceitar`);
  await t.post(`/api/coletas/${r.dados.coletaId}/ocorrencias`, { tipo: 'EMBALAGEM_VIOLADA', descricao: 'rasgada', evidencia: PNG });
  const ev = dbm.get('SELECT evidencia AS e FROM ocorrencias ORDER BY id DESC LIMIT 1').e;
  for (const c of [t, osc, e, gestor]) assert.equal((await c.get(`/api/arquivos/${ev}`)).status, 200);
  assert.equal((await outraOsc.get(`/api/arquivos/${ev}`)).status, 403);
  assert.equal((await estranho.get(`/api/arquivos/${ev}`)).status, 403);

  // anexo de feedback anônimo: só gestor
  await osc.post('/api/feedback', { tipo: 'DENUNCIA', texto: 'x', anexo: PNG });
  const fb = dbm.get('SELECT anexo AS a FROM feedbacks_anonimos ORDER BY id DESC LIMIT 1').a;
  assert.equal((await osc.get(`/api/arquivos/${fb}`)).status, 403);
  assert.equal((await gestor.get(`/api/arquivos/${fb}`)).status, 200);
});
