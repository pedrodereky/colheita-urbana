import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { Cliente, criar, prepararGestor, gestor, dadosOferta, horas, fechar, PDF, clock, dbm, maps, jobs, auth } from './helpers.js';
import { gerarCnpj } from '../server/seed.js';
import { indice } from '../server/lib/crypto.js';
import { cnpjValido, cpfValido, paraKg } from '../server/lib/validators.js';

after(fechar);
before(prepararGestor);

const codigo = (r) => r.dados.codigo;

test('validadores: CNPJ, CPF e unidades equivalentes a kg', () => {
  assert.equal(cnpjValido(gerarCnpj('123456780001')), true);
  assert.equal(cnpjValido('11.111.111/1111-11'), false);
  assert.equal(cnpjValido('12.345.678/0001-00'), false);
  assert.equal(cpfValido('529.982.247-25'), true);
  assert.equal(cpfValido('111.111.111-11'), false);
  assert.equal(paraKg(1500, 'g'), 1.5);
  assert.equal(paraKg(2, 't'), 2000);
});

test('cadastro: CNPJ inválido, irregular, duplicado, termos e senha fraca (RN17, RN22)', async () => {
  const c = new Cliente();
  const base = { nome: 'Mercado X', email: 'x@t.local', senha: 'Senha@123', telefone: '1', endereco: 'R', latitude: -15, longitude: -47, termos: true, ramo: 'Mercado' };
  assert.equal(codigo(await c.post('/api/cadastro/estabelecimento', { ...base, cnpj: '12345678000100' })), 'CNPJ_INVALIDO');
  const irregular = gerarCnpj('000000990002');
  dbm.run('INSERT INTO cnpjs_irregulares (cnpj_idx, motivo) VALUES (?,?)', indice(irregular), 't');
  assert.equal(codigo(await c.post('/api/cadastro/estabelecimento', { ...base, cnpj: irregular })), 'CNPJ_IRREGULAR');
  const ok = gerarCnpj('000000880001');
  assert.equal(codigo(await c.post('/api/cadastro/estabelecimento', { ...base, cnpj: ok, termos: false })), 'TERMOS_NAO_ACEITOS');
  assert.equal(codigo(await c.post('/api/cadastro/estabelecimento', { ...base, cnpj: ok, senha: 'abc' })), 'SENHA_FRACA');
  const r = await c.post('/api/cadastro/estabelecimento', { ...base, cnpj: ok });
  assert.equal(r.dados.statusCadastro, 'PENDENTE');
  assert.equal(codigo(await c.post('/api/cadastro/estabelecimento', { ...base, email: 'y@t.local', cnpj: ok })), 'CNPJ_DUPLICADO');
  // pendente não publica
  await c.login('x@t.local');
  assert.equal(codigo(await c.post('/api/ofertas', dadosOferta())), 'CADASTRO_NAO_APROVADO');
  // dados sensíveis cifrados em repouso (RNF01)
  const linha = dbm.get('SELECT telefone_enc, email_enc FROM usuarios WHERE id=?', r.dados.id);
  assert.match(linha.telefone_enc, /^v1:/);
  assert.ok(!linha.email_enc.includes('x@t.local'));
  // rejeição com motivo e perfil volta para análise ao corrigir
  assert.equal((await gestor.post(`/api/gestor/cadastros/${r.dados.id}/rejeitar`, {})).status, 400);
  assert.equal((await gestor.post(`/api/gestor/cadastros/${r.dados.id}/rejeitar`, { motivo: 'Documento ilegível' })).status, 200);
  await c.patch('/api/perfil', { telefone: '61988887777' });
  assert.equal((await c.get('/api/me')).dados.usuario.statusCadastro, 'PENDENTE');
  // só gestor analisa (RN23)
  assert.equal((await c.post(`/api/gestor/cadastros/${r.dados.id}/aprovar`)).status, 403);
});

test('publicação: quantidade mínima, validade mínima, janela (RN06, RN16, RF06)', async () => {
  const e = await criar('ESTABELECIMENTO');
  assert.equal(codigo(await e.post('/api/ofertas', dadosOferta({ quantidade: 500, unidade: 'g' }))), 'QUANTIDADE_MINIMA');
  assert.equal((await e.post('/api/ofertas', dadosOferta({ quantidade: 1000, unidade: 'g' }))).status, 200);
  assert.equal(codigo(await e.post('/api/ofertas', dadosOferta({ validade: horas(30), janelaFim: horas(20) }))), 'VALIDADE_MINIMA');
  assert.equal(codigo(await e.post('/api/ofertas', dadosOferta({ janelaInicio: horas(5), janelaFim: horas(2) }))), 'JANELA_INVALIDA');
  assert.equal(codigo(await e.post('/api/ofertas', dadosOferta({ janelaFim: horas(70) }))), 'JANELA_INVALIDA');
  assert.equal(codigo(await e.post('/api/ofertas', dadosOferta({ imagens: ['data:image/gif;base64,AAAA'] }))), 'ARQUIVO_FORMATO');
  // repetir oferta (UC12)
  const lista = await e.get('/api/ofertas/minhas');
  const modelo = await e.get(`/api/ofertas/${lista.dados.ofertas[0].id}/modelo`);
  assert.equal(modelo.dados.modelo.categoria, 'Panificação');
});

test('reserva: duplicidade, capacidade, perfil e cadastro (RN01, RN14, RN19)', async () => {
  const e = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC', { campos: { capacidadeSecaKg: 15 } });
  const pendente = await criar('OSC', { aprovar: false });
  const o1 = (await e.post('/api/ofertas', dadosOferta({ quantidade: 10 }))).dados.oferta.id;
  const o2 = (await e.post('/api/ofertas', dadosOferta({ quantidade: 10 }))).dados.oferta.id;
  assert.equal(codigo(await pendente.post(`/api/ofertas/${o1}/reservar`, { modalidade: 'VOLUNTARIO' })), 'CADASTRO_NAO_APROVADO');
  assert.equal((await e.post(`/api/ofertas/${o1}/reservar`, { modalidade: 'VOLUNTARIO' })).status, 403); // estabelecimento não reserva
  assert.equal((await osc.post(`/api/ofertas/${o1}/reservar`, { modalidade: 'VOLUNTARIO' })).status, 200);
  assert.equal(codigo(await osc.post(`/api/ofertas/${o2}/reservar`, { modalidade: 'VOLUNTARIO' })), 'CAPACIDADE_EXCEDIDA'); // 10 + 10 > 15
  const outra = await criar('OSC');
  assert.equal(codigo(await outra.post(`/api/ofertas/${o1}/reservar`, { modalidade: 'VOLUNTARIO' })), 'OFERTA_INDISPONIVEL');
  // documentação vencida bloqueia (RN15)
  dbm.run("UPDATE oscs SET validade_documentacao='2020-01-01' WHERE usuario_id=?", outra.id);
  assert.equal(codigo(await outra.post(`/api/ofertas/${o2}/reservar`, { modalidade: 'VOLUNTARIO' })), 'OSC_INAPTA');
});

test('coleta: limite de 3 simultâneas e veículo compatível (RN10, RN18)', async () => {
  const e = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC', { campos: { capacidadeSecaKg: 5000 } });
  const bici = await criar('TRANSPORTADOR', { campos: { tipoVeiculo: 'BICICLETA' } });
  const carro = await criar('TRANSPORTADOR');
  const coletas = [];
  for (const kg of [10, 10, 10, 10, 50]) {
    const o = (await e.post('/api/ofertas', dadosOferta({ quantidade: kg }))).dados.oferta.id;
    coletas.push((await osc.post(`/api/ofertas/${o}/reservar`, { modalidade: 'VOLUNTARIO' })).dados.coletaId);
  }
  const grande = coletas[4];
  assert.equal(codigo(await bici.post(`/api/coletas/${grande}/aceitar`)), 'VEICULO_INCOMPATIVEL');
  assert.ok(!(await bici.get('/api/coletas/disponiveis')).dados.coletas.some((c) => c.id === grande));
  for (const c of coletas.slice(0, 3)) assert.equal((await carro.post(`/api/coletas/${c}/aceitar`)).status, 200);
  assert.equal(codigo(await carro.post(`/api/coletas/${coletas[3]}/aceitar`)), 'LIMITE_COLETAS');
  // transportador pendente não aceita (RN02)
  const novo = await criar('TRANSPORTADOR', { aprovar: false });
  assert.equal(codigo(await novo.post(`/api/coletas/${coletas[3]}/aceitar`)), 'TRANSPORTADOR_INAPTO');
  // desistir devolve a coleta (RN29)
  assert.equal((await carro.post(`/api/coletas/${coletas[0]}/desistir`)).status, 200);
  assert.equal((await bici.get(`/api/coletas/${coletas[0]}`)).status, 403);
  assert.equal((await carro.post(`/api/coletas/${coletas[3]}/aceitar`)).status, 200);
});

test('janela vencida devolve à fila e 3 faltas suspendem o transportador (RN03, RN20, RF10)', async () => {
  const e = await criar('ESTABELECIMENTO');
  const t = await criar('TRANSPORTADOR');
  const oscs = [await criar('OSC'), await criar('OSC'), await criar('OSC')];
  const ofertas = [];
  for (let i = 0; i < 3; i++) {
    const o = (await e.post('/api/ofertas', dadosOferta({ janelaFim: horas(4), validade: horas(80) }))).dados.oferta.id;
    const r = await oscs[i].post(`/api/ofertas/${o}/reservar`, { modalidade: 'VOLUNTARIO' });
    await t.post(`/api/coletas/${r.dados.coletaId}/aceitar`);
    ofertas.push({ o, osc: oscs[i], coleta: r.dados.coletaId });
  }
  clock.definirAgora(new Date(Date.now() + 5 * 3600e3)); // passou da janela
  try {
    assert.equal(jobs.devolverOfertasNaoRetiradas(), 3);
    for (const x of ofertas) {
      const of = (await e.get(`/api/ofertas/${x.o}`)).dados.oferta;
      assert.equal(of.estado, 'DISPONIVEL');
      assert.ok(new Date(of.janelaFim) > clock.agora(), 'janela renovada');
      // a mesma OSC não pode reservar de novo (RN19)
      assert.equal(codigo(await x.osc.post(`/api/ofertas/${x.o}/reservar`, { modalidade: 'VOLUNTARIO' })), 'RESERVA_DUPLICADA');
    }
    const perfil = (await t.get('/api/me')).dados.usuario;
    assert.ok(perfil.suspensoAte, 'suspenso por 3 faltas');
    assert.equal(codigo(await t.post(`/api/coletas/${ofertas[0].coleta}/aceitar`)), 'TRANSPORTADOR_INAPTO');
  } finally { clock.definirAgora(null); }
});

test('oferta sem reserva expira e gera alerta de validade crítica (RN26, RF36)', async () => {
  const e = await criar('ESTABELECIMENTO');
  const o = (await e.post('/api/ofertas', dadosOferta({ validade: horas(40), janelaFim: horas(30) }))).dados.oferta.id;
  clock.definirAgora(new Date(Date.now() + 30 * 3600e3)); // faltam ~10h
  try {
    assert.ok(jobs.alertarValidadeCritica() >= 1);
    assert.equal(jobs.alertarValidadeCritica(), 0); // sem duplicar
    assert.ok(dbm.get("SELECT 1 AS x FROM notificacoes WHERE tipo='VALIDADE_CRITICA'"));
    clock.definirAgora(new Date(Date.now() + 45 * 3600e3));
    jobs.expirarOfertasDisponiveis();
    assert.equal(dbm.get('SELECT estado FROM ofertas WHERE id=?', o).estado, 'EXPIRADA');
  } finally { clock.definirAgora(null); }
});

test('validade curta notifica OSCs elegíveis próximas e com capacidade (RF11)', async () => {
  const e = await criar('ESTABELECIMENTO');
  const perto = await criar('OSC');
  const longe = await criar('OSC', { dLat: 5 });
  const pequena = await criar('OSC', { campos: { capacidadeSecaKg: 5, capacidadeRefrigeradaKg: 5 } });
  const r = await e.post('/api/ofertas', dadosOferta({ validade: horas(50), quantidade: 20 }));
  assert.ok(r.dados.oscsNotificadas >= 1);
  const curtas = async (c) => (await c.get('/api/notificacoes')).dados.notificacoes.filter((n) => n.tipo === 'VALIDADE_CURTA').length;
  assert.equal(await curtas(perto), 1);
  assert.equal(await curtas(longe), 0);
  assert.equal(await curtas(pequena), 0);
});

test('mapas indisponíveis: lista ordena por validade e avisa (UC14 2a)', async () => {
  const e = await criar('ESTABELECIMENTO');
  const osc = await criar('OSC');
  await e.post('/api/ofertas', dadosOferta());
  maps.simularFalhaMapas(true);
  try {
    const r = await osc.get('/api/ofertas');
    assert.equal(r.dados.mapaIndisponivel, true);
    assert.ok(r.dados.ofertas.length >= 1 && r.dados.aviso);
  } finally { maps.simularFalhaMapas(false); }
});

test('suporte, pesquisa e feedback anônimo sem identificação (UC42–UC46, RN31)', async () => {
  const osc = await criar('OSC');
  const ch = await osc.post('/api/chamados', { categoria: 'ACESSO', assunto: 'Erro', descricao: 'Não consigo anexar' });
  assert.match(ch.dados.protocolo, /^CH-\d{8}-[0-9A-F]{4}$/);
  assert.equal((await osc.post('/api/chamados', { categoria: 'ACESSO', assunto: '', descricao: 'x' })).status, 400);
  await gestor.post(`/api/chamados/${ch.dados.id}/mensagens`, { texto: 'Estamos verificando' });
  assert.equal((await gestor.get(`/api/chamados/${ch.dados.id}`)).dados.chamado.status, 'EM_ATENDIMENTO');
  assert.equal((await osc.get(`/api/chamados/${ch.dados.id}`)).dados.mensagens.length, 1);
  const outro = await criar('OSC');
  assert.equal((await outro.get(`/api/chamados/${ch.dados.id}`)).status, 404);

  const p = await gestor.post('/api/gestor/pesquisas', { titulo: 'NPS', periodoInicio: horas(-1), periodoFim: horas(100), perguntas: ['Fácil?', 'Rápido?'] });
  const ativas = await osc.get('/api/pesquisas');
  assert.equal(ativas.dados.pesquisas[0].respondida, false);
  assert.equal((await osc.post(`/api/pesquisas/${p.dados.id}/responder`, { notaGeral: 5, respostas: [5, 4] })).status, 200);
  assert.equal(codigo(await osc.post(`/api/pesquisas/${p.dados.id}/responder`, { notaGeral: 5 })), 'JA_RESPONDIDA');

  assert.equal((await osc.post('/api/feedback', { tipo: 'DENUNCIA', texto: '' })).status, 400);
  assert.equal((await osc.post('/api/feedback', { tipo: 'DENUNCIA', texto: 'Estabelecimento X vende o que é doado' })).status, 200);
  const colunas = dbm.all('PRAGMA table_info(feedbacks_anonimos)').map((c) => c.name);
  assert.ok(!colunas.some((c) => /usuario|autor|^ip$|remoto/i.test(c)));
  const linha = dbm.get('SELECT * FROM feedbacks_anonimos ORDER BY id DESC LIMIT 1');
  assert.match(linha.data_envio, /^\d{4}-\d{2}-\d{2}$/);
  const fb = await gestor.get('/api/gestor/feedbacks');
  assert.equal(fb.dados.feedbacks.length, 1);
  assert.equal(JSON.stringify(fb.dados).includes(String(osc.id)), false);
  assert.equal((await osc.get('/api/gestor/feedbacks')).status, 403);
});

test('auditoria é imutável e a cadeia de hash detecta adulteração (RF18)', async () => {
  assert.throws(() => dbm.run("UPDATE logs_auditoria SET acao='X' WHERE id=1"), /imutáveis/);
  assert.throws(() => dbm.run('DELETE FROM logs_auditoria WHERE id=1'), /imutáveis/);
  assert.equal((await gestor.get('/api/gestor/auditoria?verificar=1')).dados.integridade.integra, true);
});

test('recuperação de senha: resposta neutra, token de uso único (UC07)', async () => {
  const u = await criar('OSC');
  const c = new Cliente();
  const email = (await u.get('/api/me')).dados.usuario.email;
  const a = await c.post('/api/senha/esqueci', { email: 'naoexiste@t.local' });
  const b = await c.post('/api/senha/esqueci', { email });
  assert.equal(a.dados.mensagem, b.dados.mensagem);
  auth.resetarLimitador();
  const mail = (await c.get('/api/dev/emails')).dados.emails.find((x) => x.assunto.includes('redefinição'));
  const token = mail.corpo.match(/token=([\w-]+)/)[1];
  assert.equal((await c.post('/api/senha/redefinir', { token, senha: 'fraca' })).status, 400);
  assert.equal((await c.post('/api/senha/redefinir', { token, senha: 'NovaSenha1' })).status, 200);
  assert.equal(codigo(await c.post('/api/senha/redefinir', { token, senha: 'OutraSenha2' })), 'TOKEN_INVALIDO');
  assert.equal((await new Cliente().login(email, 'NovaSenha1')).tipo, 'OSC');
});

test('autorização: rotas exigem login e perfil correto', async () => {
  const anon = new Cliente();
  assert.equal((await anon.get('/api/me')).status, 401);
  assert.equal((await anon.get('/api/gestor/painel')).status, 401);
  const t = await criar('TRANSPORTADOR');
  assert.equal((await t.get('/api/gestor/painel')).status, 403);
  assert.equal((await t.post('/api/ofertas', dadosOferta())).status, 403);
  const e = await criar('ESTABELECIMENTO');
  const o = (await e.post('/api/ofertas', dadosOferta())).dados.oferta.id;
  const outroEstab = await criar('ESTABELECIMENTO');
  assert.equal((await outroEstab.post(`/api/ofertas/${o}/cancelar`)).status, 404);
});
