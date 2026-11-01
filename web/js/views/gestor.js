import { GET, POST, qs } from '../api.js';
import { h, montar, campo, entrada, selecao, aviso, botao, confirmar, modal, erroBox, selo, fmtData, fmtDia, fmtKg, fmtNum, rotulo, paraInputLocal, deInputLocal } from '../ui.js';
import { ouvir } from '../ctx.js';
import { arquivo } from './componentes.js';

const kpi = (valor, texto) => h('div', { class: 'cartao kpi' }, h('b', null, valor), h('span', null, texto));

// ---------- painel (UC39/UC40) ----------
export async function painel() {
  const hoje = new Date(); const f = { de: new Date(hoje.getTime() - 30 * 86400e3).toISOString().slice(0, 10), ate: hoje.toISOString().slice(0, 10) };
  const corpo = h('div');
  async function carregar() {
    const r = await GET(`/api/gestor/painel${qs(f)}`); const i = r.indicadores; const s = r.situacao;
    const linkRel = (fmt) => `/api/gestor/relatorio${qs({ ...f, formato: fmt })}`;
    montar(corpo,
      h('div', { class: 'grade estreita' }, kpi(fmtKg(i.quilosResgatados), 'resgatados'), kpi(fmtNum(i.refeicoesEquivalentes), 'refeições equivalentes'), kpi(i.doacoesConcluidas, 'doações concluídas'), kpi(`${i.taxaOfertasExpiradas}%`, 'ofertas expiradas sem retirada')),
      h('h2', null, 'Situação da plataforma'),
      h('div', { class: 'grade estreita' },
        h('a', { class: 'cartao kpi', href: '#/cadastros', style: 'text-decoration:none;color:inherit' }, h('b', null, s.cadastrosPendentes), h('span', null, 'cadastros pendentes')),
        kpi(s.entregasEmAndamento, 'entregas em andamento'), kpi(s.aguardandoTransportador, 'aguardando voluntário'),
        h('a', { class: 'cartao kpi', href: '#/suporte', style: 'text-decoration:none;color:inherit' }, h('b', null, s.chamadosAbertos), h('span', null, 'chamados abertos')),
        h('a', { class: 'cartao kpi', href: '#/feedbacks', style: 'text-decoration:none;color:inherit' }, h('b', null, s.feedbacksNovos), h('span', null, 'feedbacks novos')),
        kpi(s.validadeCritica, 'ofertas com validade crítica')),
      s.validadeCritica ? h('div', { class: 'alerta' }, `⚠️ ${s.validadeCritica} oferta(s) disponível(is) vencem em menos de 12h sem reserva.`) : null,
      h('div', { class: 'grade', style: 'margin-top:1rem' },
        h('div', { class: 'cartao' }, h('h3', null, 'Ofertas por estado'), Object.keys(s.ofertasPorEstado).length ? Object.entries(s.ofertasPorEstado).map(([k, n]) => h('div', { class: 'linha entre' }, selo(k), h('b', null, n))) : h('p', { class: 'suave' }, 'Sem ofertas.')),
        h('div', { class: 'cartao' }, h('h3', null, 'Distribuição por OSC'), i.distribuicaoPorOsc.length ? h('table', null, h('thead', null, h('tr', null, h('th', null, 'OSC'), h('th', null, 'Kg'), h('th', null, 'Doações'))), h('tbody', null, i.distribuicaoPorOsc.map((d) => h('tr', null, h('td', null, d.osc), h('td', null, fmtNum(d.kg)), h('td', null, d.doacoes))))) : h('p', { class: 'suave' }, 'Sem doações no período.'))),
      h('div', { class: 'linha', style: 'margin-top:1rem' }, h('a', { class: 'botao sec', href: linkRel('csv') }, '⬇ Exportar CSV'), h('a', { class: 'botao sec', href: linkRel('pdf') }, '⬇ Exportar PDF')));
  }
  await carregar();
  ouvir((ev) => { if (ev === 'notificacao') carregar(); });
  const mud = (k) => (e) => { f[k] = e.target.value; carregar(); };
  return h('div', null, h('h1', null, 'Painel de gestão'),
    h('div', { class: 'linha' }, h('div', null, campo('De', entrada('de', { type: 'date', value: f.de, onchange: mud('de') }))), h('div', null, campo('Até', entrada('ate', { type: 'date', value: f.ate, onchange: mud('ate') })))), corpo);
}

// ---------- cadastros (UC04/UC05) ----------
export async function cadastros() {
  let status = 'PENDENTE';
  const abas = h('div', { class: 'abas' }); const lista = h('div');
  async function carregar() {
    const { cadastros: itens } = await GET(`/api/gestor/cadastros?status=${status}`);
    montar(abas, [['PENDENTE', 'Pendentes'], ['APROVADO', 'Aprovados'], ['SUSPENSO', 'Suspensos'], ['REJEITADO', 'Rejeitados'], ['TODOS', 'Todos']].map(([k, t]) => h('button', { 'aria-pressed': String(status === k), onclick: () => { status = k; carregar(); } }, t)));
    montar(lista, itens.length ? h('div', { class: 'grade' }, itens.map((c) => h('article', { class: 'cartao coluna' },
      h('div', { class: 'linha entre' }, h('h3', { style: 'margin:0' }, c.nome), selo(c.statusCadastro)), h('span', { class: 'suave pequeno' }, `${rotulo2(c.tipo)} · cadastrado em ${fmtDia(c.criadoEm)}`),
      botao('Analisar', () => detalheCadastro(c, carregar), 'mini')))) : h('div', { class: 'cartao vazio' }, 'Nenhum cadastro nesta lista.'));
  }
  await carregar();
  return h('div', null, h('h1', null, 'Cadastros'), abas, lista);
}
const rotulo2 = (t) => ({ ESTABELECIMENTO: 'Estabelecimento', OSC: 'OSC', TRANSPORTADOR: 'Transportador' })[t] || t;

function detalheCadastro(c, aoConcluir) {
  const linhas = [['E-mail', c.email], ['Telefone', c.telefone], ['Endereço', c.endereco], ['Localização', `${c.latitude}, ${c.longitude}`]];
  if (c.cnpj) linhas.push(['CNPJ', c.cnpj]);
  if (c.cpf) linhas.push(['CPF', c.cpf]);
  if (c.ramo) linhas.push(['Ramo', c.ramo]);
  if (c.tipo === 'OSC') linhas.push(['Capacidade refrigerada', fmtKg(c.capacidadeRefrigeradaKg)], ['Capacidade seca', fmtKg(c.capacidadeSecaKg)], ['Documentação válida até', fmtDia(c.validadeDocumentacao)]);
  if (c.tipo === 'TRANSPORTADOR') linhas.push(['Veículo', c.tipoVeiculo], ['Disponibilidade', c.disponibilidade], ['Entregas concluídas', c.entregasConcluidas]);
  const motivo = h('textarea', { placeholder: 'Motivo / justificativa (obrigatório para rejeitar ou suspender)', maxlength: 500 });
  const acaoComMotivo = (rota, rotuloBtn, classe, campoNome) => botao(rotuloBtn, async () => {
    if (!motivo.value.trim()) throw new Error('Informe o motivo / justificativa.');
    await POST(`/api/gestor/cadastros/${c.id}/${rota}`, { [campoNome]: motivo.value }); m.fechar(); aviso('Cadastro atualizado.', 'ok'); aoConcluir();
  }, classe);
  const botoes = [];
  if (c.statusCadastro === 'PENDENTE') botoes.push(botao('✅ Aprovar', async () => { await POST(`/api/gestor/cadastros/${c.id}/aprovar`); m.fechar(); aviso('Cadastro aprovado.', 'ok'); aoConcluir(); }), acaoComMotivo('rejeitar', 'Rejeitar', 'perigo', 'motivo'));
  if (c.statusCadastro === 'APROVADO') botoes.push(acaoComMotivo('suspender', 'Suspender cadastro', 'perigo', 'justificativa'));
  if (c.statusCadastro === 'SUSPENSO') botoes.push(acaoComMotivo('reativar', 'Reativar', '', 'justificativa'));
  const m = modal(c.nome, h('div', null, selo(c.statusCadastro), h('table', { style: 'margin:.6rem 0' }, h('tbody', null, linhas.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v ?? '—'))))),
    c.comprovante ? h('p', null, h('a', { href: arquivo(c.comprovante), target: '_blank', rel: 'noopener' }, '📎 Ver comprovante de regularidade')) : null,
    c.motivoStatus ? h('div', { class: 'alerta' }, `Último motivo: ${c.motivoStatus}`) : null,
    botoes.length ? [campo('Justificativa', motivo), h('div', { class: 'linha' }, botoes)] : null), { largo: true });
}

// ---------- feedbacks anônimos (UC46) ----------
export async function feedbacks() {
  const f = { tipo: '', status: '' }; const lista = h('div');
  async function carregar() {
    const { feedbacks: itens } = await GET(`/api/gestor/feedbacks${qs(f)}`);
    montar(lista, itens.length ? h('div', { class: 'coluna' }, itens.map((x) => {
      const prov = h('input', { placeholder: 'Providência tomada (opcional)', value: x.providencia || '' });
      return h('article', { class: 'cartao coluna' }, h('div', { class: 'linha entre' }, h('div', { class: 'linha' }, selo(x.tipo), selo(x.status)), h('span', { class: 'suave pequeno' }, `Recebido em ${fmtDia(x.dataEnvio)} · autor não identificado`)),
        h('p', { style: 'white-space:pre-wrap' }, x.texto), x.anexo ? h('a', { href: arquivo(x.anexo), target: '_blank', rel: 'noopener' }, 'Ver anexo') : null, prov,
        h('div', { class: 'linha' }, botao('Em análise', async () => { await POST(`/api/gestor/feedbacks/${x.id}/status`, { status: 'EM_ANALISE', providencia: prov.value }); carregar(); }, 'sec mini'), botao('Resolvido', async () => { await POST(`/api/gestor/feedbacks/${x.id}/status`, { status: 'RESOLVIDO', providencia: prov.value }); carregar(); }, 'mini'),
          x.tipo === 'DENUNCIA' ? h('a', { class: 'botao sec mini', href: '#/cadastros' }, 'Ir para cadastros (suspender)') : null));
    })) : h('div', { class: 'cartao vazio' }, 'Nenhum feedback.'));
  }
  await carregar();
  const mud = (k) => (e) => { f[k] = e.target.value; carregar(); };
  return h('div', null, h('h1', null, 'Sugestões e denúncias'), h('div', { class: 'info' }, 'Os autores não são identificados em nenhum momento.'),
    h('div', { class: 'linha' }, campo('Tipo', selecao('t', [['', 'Todos'], ['SUGESTAO', 'Sugestões'], ['DENUNCIA', 'Denúncias']], '', { onchange: mud('tipo') })), campo('Situação', selecao('s', [['', 'Todas'], ['NOVO', 'Novos'], ['EM_ANALISE', 'Em análise'], ['RESOLVIDO', 'Resolvidos']], '', { onchange: mud('status') }))), lista);
}

// ---------- pesquisas de satisfação ----------
export async function pesquisas() {
  const { pesquisas: itens } = await GET('/api/gestor/pesquisas');
  const perguntas = h('textarea', { name: 'perguntas', required: true, placeholder: 'Uma pergunta por linha (nota de 1 a 5)', rows: 4 });
  const erro = h('div');
  const form = h('form', { class: 'cartao', novalidate: true }, h('h2', { style: 'margin-top:0' }, 'Nova pesquisa'),
    campo('Título', entrada('titulo', { required: true, maxlength: 150 })),
    h('div', { class: 'form-grade' }, campo('Início', entrada('periodoInicio', { type: 'datetime-local', required: true, value: paraInputLocal(new Date()) })), campo('Fim', entrada('periodoFim', { type: 'datetime-local', required: true, value: paraInputLocal(new Date(Date.now() + 14 * 86400e3)) }))),
    campo('Perguntas', perguntas), erro, h('button', { class: 'botao', type: 'submit' }, 'Publicar e notificar usuários'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); montar(erro);
    try {
      await POST('/api/gestor/pesquisas', { titulo: form.elements.titulo.value, periodoInicio: deInputLocal(form.elements.periodoInicio.value), periodoFim: deInputLocal(form.elements.periodoFim.value), perguntas: perguntas.value.split('\n') });
      aviso('Pesquisa publicada!', 'ok'); location.reload();
    } catch (e) { montar(erro, erroBox(e)); }
  });
  return h('div', null, h('h1', null, 'Pesquisas de satisfação'), form, h('h2', null, 'Resultados'),
    itens.length ? h('div', { class: 'grade' }, itens.map((p) => h('article', { class: 'cartao' }, h('h3', null, p.titulo), h('p', { class: 'suave pequeno' }, `${fmtDia(p.periodoInicio)} a ${fmtDia(p.periodoFim)} · ${p.respostas} resposta(s)`),
      h('p', null, h('b', null, `Nota geral: ${p.mediaGeral ?? '—'}`)), p.porPergunta.map((q) => h('div', { class: 'linha entre pequeno' }, h('span', null, q.pergunta), h('b', null, q.media ?? '—'))),
      p.comentarios.length ? h('details', null, h('summary', null, `${p.comentarios.length} comentário(s)`), p.comentarios.map((c) => h('p', null, `“${c}”`))) : null))) : h('div', { class: 'cartao vazio' }, 'Nenhuma pesquisa criada.'));
}

// ---------- auditoria (UC37) ----------
export async function auditoria() {
  const f = { entidade: '', acao: '' }; const corpo = h('div'); let integr = null;
  async function carregar() {
    const r = await GET(`/api/gestor/auditoria${qs({ ...f, verificar: integr ? 1 : '' })}`);
    montar(corpo, integr !== null && r.integridade ? h('div', { class: r.integridade.integra ? 'ok' : 'erro', role: 'status' }, r.integridade.integra ? '🔒 Cadeia de integridade verificada: nenhum registro foi alterado.' : `⚠️ Inconsistência detectada no registro ${r.integridade.falhaEm}.`) : null,
      h('div', { class: 'rolavel' }, h('table', null, h('thead', null, h('tr', null, ['Data/hora', 'Autor', 'Entidade', 'Ação', 'De → Para', 'Justificativa'].map((c) => h('th', null, c)))),
        h('tbody', null, r.logs.map((l) => h('tr', null, h('td', null, fmtData(l.timestamp)), h('td', null, l.autor), h('td', null, `${l.entidade}${l.entidadeId ? ` #${l.entidadeId}` : ''}`), h('td', null, l.acao), h('td', null, l.de || l.para ? `${l.de ?? '—'} → ${l.para ?? '—'}` : ''), h('td', null, l.justificativa || '')))))));
  }
  await carregar();
  return h('div', null, h('h1', null, 'Trilha de auditoria'), h('p', { class: 'suave' }, 'Registros imutáveis. Os autores são exibidos de forma pseudonimizada, permitindo a validação do fluxo sem expor dados pessoais.'),
    h('div', { class: 'linha' }, campo('Entidade', selecao('e', [['', 'Todas'], ['oferta', 'Oferta'], ['reserva', 'Reserva'], ['coleta', 'Coleta'], ['usuario', 'Usuário'], ['recibo', 'Recibo'], ['avaliacao', 'Avaliação'], ['chamado', 'Chamado'], ['transportador', 'Transportador']], '', { onchange: (e) => { f.entidade = e.target.value; carregar(); } })),
      h('div', { style: 'align-self:end;margin-bottom:.9rem' }, botao('Verificar integridade', async () => { integr = true; await carregar(); }, 'sec'))), corpo);
}
