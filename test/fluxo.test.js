import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Cliente, criar, prepararGestor, gestor, dadosOferta, horas, fechar, PNG } from './helpers.js';

after(fechar);
before(prepararGestor);

test('fluxo completo da doação: publicar → reservar → coletar → entregar → recibo → avaliar → histórico', async () => {
  const estab = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC', { dLat: 0.05 });
  const transp = await criar('TRANSPORTADOR');

  const pub = await estab.post('/api/ofertas', dadosOferta({ imagens: [PNG] }));
  assert.equal(pub.status, 200);
  assert.equal(pub.dados.oferta.estado, 'DISPONIVEL');
  assert.equal(pub.dados.oferta.imagens.length, 1);
  const ofertaId = pub.dados.oferta.id;

  const lista = await osc.get('/api/ofertas');
  assert.ok(lista.dados.ofertas.some((o) => o.id === ofertaId && o.distanciaKm > 0));

  // UC15/UC16
  const semModalidade = await osc.post(`/api/ofertas/${ofertaId}/reservar`, {});
  assert.equal(semModalidade.status, 400);
  const res = await osc.post(`/api/ofertas/${ofertaId}/reservar`, { modalidade: 'VOLUNTARIO' });
  assert.equal(res.status, 200);
  const { reservaId, coletaId } = res.dados;

  // Não aparece mais para as outras OSCs e não pode ser cancelada (RN30)
  const cancel = await estab.post(`/api/ofertas/${ofertaId}/cancelar`);
  assert.equal(cancel.status, 409);
  assert.equal(cancel.dados.codigo, 'OFERTA_JA_RESERVADA');

  // UC19
  const disp = await transp.get('/api/coletas/disponiveis');
  assert.ok(disp.dados.coletas.some((c) => c.id === coletaId));
  assert.equal((await transp.post(`/api/coletas/${coletaId}/aceitar`)).status, 200);

  // UC20
  const rota = await transp.get(`/api/coletas/${coletaId}/rota`);
  assert.equal(rota.status, 200);
  assert.ok(rota.dados.minutos >= 0 && rota.dados.trechos.length === 2);

  // UC23: localização só durante a entrega, visível a estabelecimento e OSC
  assert.equal((await transp.post(`/api/coletas/${coletaId}/localizacao`, { latitude: -15.8, longitude: -47.9 })).status, 200);
  const vistaOsc = await osc.get(`/api/coletas/${coletaId}`);
  assert.equal(vistaOsc.dados.entrega.localizacao.latitude, -15.8);

  // UC25 chat
  assert.equal((await estab.post(`/api/coletas/${coletaId}/chat`, { texto: 'Portão dos fundos' })).status, 200);
  const chat = await transp.get(`/api/coletas/${coletaId}/chat`);
  assert.equal(chat.dados.mensagens.length, 1);
  assert.equal(chat.dados.ativo, true);

  // UC21
  const col = await transp.post(`/api/coletas/${coletaId}/registrar-coleta`);
  assert.equal(col.status, 200);
  assert.ok(col.dados.previsaoChegada);

  // Só a OSC confirma
  assert.equal((await transp.post(`/api/coletas/${coletaId}/confirmar-recebimento`)).status, 403);
  // RN07: não pode avaliar antes de confirmar
  assert.equal((await osc.post(`/api/reservas/${reservaId}/avaliar-doacao`, { nota: 5 })).dados.codigo, 'RECEBIMENTO_NAO_CONFIRMADO');
  const conf = await osc.post(`/api/coletas/${coletaId}/confirmar-recebimento`);
  assert.equal(conf.status, 200);
  assert.match(conf.dados.recibo.numero, /^CU-\d{4}-\d{6}$/); // RN33

  // RN34 chat encerrado, RN32 localização apagada
  assert.equal((await estab.post(`/api/coletas/${coletaId}/chat`, { texto: 'oi' })).dados.codigo, 'CHAT_ENCERRADO');
  assert.equal((await transp.post(`/api/coletas/${coletaId}/localizacao`, { latitude: 1, longitude: 1 })).dados.codigo, 'FORA_DE_ENTREGA');
  assert.equal((await osc.get(`/api/coletas/${coletaId}`)).dados.entrega.localizacao, null);

  // Recibo (JSON, PDF, verificação pública)
  const recibos = await estab.get('/api/recibos');
  assert.equal(recibos.dados.recibos.length, 1);
  const pdf = await estab.get(`/api/recibos/${recibos.dados.recibos[0].id}/pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.dados.subarray(0, 5).toString(), '%PDF-');
  const ver = await new Cliente().get(`/api/verificar-recibo/${recibos.dados.recibos[0].codigoVerificacao}`);
  assert.equal(ver.dados.valido, true);
  assert.equal(ver.dados.doador.startsWith('ESTAB'), true);

  // UC29/UC30
  assert.equal((await osc.post(`/api/reservas/${reservaId}/avaliar-doacao`, { nota: 5, comentario: 'ótimo' })).status, 200);
  assert.equal((await osc.post(`/api/reservas/${reservaId}/avaliar-doacao`, { nota: 5 })).status, 409);
  assert.equal((await osc.post(`/api/reservas/${reservaId}/avaliar-entrega`, { nota: 4 })).status, 200);

  // UC34–36
  const hist = await osc.get('/api/historico?ordenar=quantidade&ordem=desc&nota=5');
  assert.equal(hist.dados.historico.length, 1);
  assert.equal(hist.dados.historico[0].situacao, 'ENTREGUE');
  assert.equal((await osc.get('/api/historico?nota=1')).dados.historico.length, 0);

  // UC31 ranking
  const rk = await osc.get('/api/ranking?tipo=ESTABELECIMENTO');
  assert.equal(rk.dados.disponivel, true);
  assert.equal(rk.dados.ranking[0].doacoes, 1);

  // UC39/UC40
  const painel = await gestor.get('/api/gestor/painel');
  assert.equal(painel.dados.indicadores.quilosResgatados, 10);
  assert.equal(painel.dados.indicadores.refeicoesEquivalentes, 20);
  const csv = await gestor.get('/api/gestor/relatorio?formato=csv');
  assert.match(csv.dados.toString(), /Quilos resgatados;10/);
  assert.equal((await gestor.get('/api/gestor/relatorio?formato=pdf')).dados.subarray(0, 4).toString(), '%PDF');

  // Estado final e trilha de auditoria (RNF07)
  const of = await estab.get(`/api/ofertas/${ofertaId}`);
  assert.equal(of.dados.oferta.estado, 'AVALIADA');
  const aud = await gestor.get(`/api/gestor/auditoria?entidade=oferta&entidadeId=${ofertaId}&verificar=1`);
  const estados = aud.dados.logs.filter((l) => l.acao === 'MUDAR_ESTADO').map((l) => l.para).reverse();
  assert.deepEqual(estados, ['RESERVADA', 'EM_COLETA', 'EM_TRANSPORTE', 'ENTREGUE', 'AVALIADA']);
  assert.equal(aud.dados.integridade.integra, true);
  assert.ok(aud.dados.logs.every((l) => /^U-|^sistema$/.test(l.autor))); // RNF20
});

test('transporte próprio dispensa transportador voluntário (RN25)', async () => {
  const estab = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC');
  const { dados } = await estab.post('/api/ofertas', dadosOferta());
  const sem = await osc.post(`/api/ofertas/${dados.oferta.id}/reservar`, { modalidade: 'PROPRIO' });
  assert.equal(sem.status, 400); // falta responsável pela retirada
  const r = await osc.post(`/api/ofertas/${dados.oferta.id}/reservar`, { modalidade: 'PROPRIO', responsavelRetirada: 'Dona Rita' });
  assert.equal(r.status, 200);
  assert.equal((await osc.get(`/api/coletas/${r.dados.coletaId}`)).dados.entrega.estado, 'EM_COLETA');
  assert.equal((await osc.post(`/api/coletas/${r.dados.coletaId}/registrar-coleta`)).status, 200);
  assert.equal((await osc.post(`/api/coletas/${r.dados.coletaId}/confirmar-recebimento`)).status, 200);
});

test('recusa por má qualidade: justificativa, sem avaliação, sem recibo (RN07, RN24, RN33)', async () => {
  const estab = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC');
  const { dados } = await estab.post('/api/ofertas', dadosOferta());
  const r = await osc.post(`/api/ofertas/${dados.oferta.id}/reservar`, { modalidade: 'PROPRIO', responsavelRetirada: 'Zé' });
  await osc.post(`/api/coletas/${r.dados.coletaId}/registrar-coleta`);
  assert.equal((await osc.post(`/api/coletas/${r.dados.coletaId}/recusar`, {})).status, 400);
  assert.equal((await osc.post(`/api/coletas/${r.dados.coletaId}/recusar`, { justificativa: 'Produto azedo' })).status, 200);
  assert.equal((await osc.post(`/api/reservas/${r.dados.reservaId}/avaliar-doacao`, { nota: 1 })).dados.codigo, 'DOACAO_RECUSADA');
  assert.equal((await estab.get('/api/recibos')).dados.recibos.length, 0);
  const n = await estab.get('/api/notificacoes');
  assert.ok(n.dados.notificacoes.some((x) => x.mensagem.includes('Produto azedo')));
});
