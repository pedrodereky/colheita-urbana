import { GET, POST, PATCH, qs } from '../api.js';
import { h, montar, campo, entrada, selecao, aviso, botao, erroBox, selo, estrelas, fmtData, fmtDia, fmtKg, fmtNum, lerArquivo, rotulo } from '../ui.js';
import { sessao, ir, ouvir } from '../ctx.js';
import { lerForm, VEICULOS } from './publico.js';
import { CATEGORIAS } from './componentes.js';
import { arquivo } from './componentes.js';

// ---------- perfil (UC06) ----------
export async function perfil() {
  const { usuario: u } = await GET('/api/me');
  sessao.usuario = u;
  const erro = h('div');
  const comuns = [
    h('div', { class: 'form-grade' }, campo('Nome', entrada('nome', { value: u.nome, required: true })), campo('Telefone', entrada('telefone', { value: u.telefone || '', type: 'tel' }))),
    h('div', { class: 'form-grade' }, campo('E-mail', entrada('email', { value: u.email, type: 'email' })), campo('Endereço', entrada('endereco', { value: u.endereco || '' }))),
    h('div', { class: 'form-grade' }, campo('Latitude', entrada('latitude', { value: u.latitude ?? '', type: 'number', step: 'any' })), campo('Longitude', entrada('longitude', { value: u.longitude ?? '', type: 'number', step: 'any' }))),
  ];
  const espec = [];
  if (u.tipo === 'ESTABELECIMENTO') espec.push(h('div', { class: 'form-grade' }, campo('CNPJ', entrada('cnpj', { value: u.cnpj }), 'Alterar o CNPJ envia o cadastro para nova análise.'), campo('Ramo', entrada('ramo', { value: u.ramo || '' }))));
  if (u.tipo === 'OSC') espec.push(
    campo('CNPJ', entrada('cnpj', { value: u.cnpj }), 'Alterar o CNPJ envia o cadastro para nova análise.'),
    h('div', { class: 'form-grade' }, campo('Capacidade refrigerada (kg)', entrada('capacidadeRefrigeradaKg', { type: 'number', step: 'any', min: 0, value: u.capacidadeRefrigeradaKg })), campo('Capacidade seca (kg)', entrada('capacidadeSecaKg', { type: 'number', step: 'any', min: 0, value: u.capacidadeSecaKg }))),
    h('div', { class: 'alerta' }, `Documentação válida até ${fmtDia(u.validadeDocumentacao)}. Para renovar, envie o novo comprovante (o cadastro volta para análise).`),
    h('div', { class: 'form-grade' }, campo('Nova validade da documentação', entrada('validadeDocumentacao', { type: 'date' })), campo('Novo comprovante', entrada('comprovante', { type: 'file', accept: 'application/pdf,image/jpeg,image/png' }))));
  if (u.tipo === 'TRANSPORTADOR') espec.push(h('div', { class: 'form-grade' }, campo('Meio de transporte', selecao('tipoVeiculo', VEICULOS, u.tipoVeiculo)), campo('Disponibilidade', entrada('disponibilidade', { value: u.disponibilidade || '' }))),
    h('p', { class: 'suave' }, `${u.entregasConcluidas} entregas concluídas · ${u.faltasConsecutivas} falta(s) consecutiva(s)`), u.suspensoAte && new Date(u.suspensoAte) > new Date() ? h('div', { class: 'erro' }, `Suspenso até ${fmtDia(u.suspensoAte)} por faltas consecutivas.`) : null);
  const form = h('form', { class: 'cartao', novalidate: true }, ...comuns, ...espec, erro, h('button', { class: 'botao grande', type: 'submit' }, 'Salvar alterações'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); montar(erro);
    const d = lerForm(form);
    for (const k of ['latitude', 'longitude', 'capacidadeRefrigeradaKg', 'capacidadeSecaKg']) if (k in d) d[k] = d[k] === '' ? undefined : Number(d[k]);
    if (u.tipo === 'OSC') { const f = form.elements.comprovante.files[0]; if (f) d.comprovante = await lerArquivo(f); else { delete d.comprovante; delete d.validadeDocumentacao; } }
    try {
      const r = await PATCH('/api/perfil', d); sessao.usuario = r.usuario; window.dispatchEvent(new Event('cu:perfil'));
      aviso(r.usuario.statusCadastro === 'PENDENTE' && u.statusCadastro !== 'PENDENTE' ? 'Dados salvos. Seu cadastro voltou para análise.' : 'Dados atualizados.', 'ok'); ir('#/perfil');
    } catch (e) { montar(erro, erroBox(e)); }
  });
  return h('div', null, h('div', { class: 'linha entre' }, h('h1', null, 'Meu perfil'), selo(u.statusCadastro)),
    u.statusCadastro === 'PENDENTE' ? h('div', { class: 'alerta' }, 'Seu cadastro está em análise pela equipe. Você será avisado quando for aprovado.') : null,
    u.statusCadastro === 'REJEITADO' ? h('div', { class: 'erro' }, `Cadastro rejeitado: ${u.motivoStatus}. Corrija os dados abaixo para uma nova análise.`) : null,
    u.statusCadastro === 'SUSPENSO' ? h('div', { class: 'erro' }, `Cadastro suspenso: ${u.motivoStatus}`) : null,
    u.reconhecimentos?.length ? h('div', { class: 'ok' }, h('b', null, 'Reconhecimentos: '), u.reconhecimentos.map((r) => h('span', { class: 'selo APROVADO', style: 'margin-right:.4rem' }, `${r.tipo === 'SELO' ? '🏅' : '📜'} ${r.descricao}`))) : null,
    form);
}

// ---------- notificações ----------
export async function notificacoes() {
  const { notificacoes: lista } = await GET('/api/notificacoes');
  POST('/api/notificacoes/lidas').catch(() => {});
  return h('div', null, h('h1', null, 'Notificações'), lista.length ? h('div', { class: 'coluna' }, lista.map((n) => h('div', { class: `cartao ${n.lida ? '' : 'info'}` }, n.mensagem, h('br'), h('small', { class: 'suave' }, fmtData(n.dataEnvio))))) : h('div', { class: 'cartao vazio' }, 'Nada por aqui.'));
}

// ---------- ranking (UC31) ----------
export async function ranking() {
  let tipo = 'ESTABELECIMENTO';
  const corpo = h('div'); const abas = h('div', { class: 'abas' });
  async function carregar() {
    const r = await GET(`/api/ranking?tipo=${tipo}`);
    montar(abas, [['ESTABELECIMENTO', 'Estabelecimentos'], ['TRANSPORTADOR', 'Voluntários']].map(([k, t]) => h('button', { 'aria-pressed': String(tipo === k), onclick: () => { tipo = k; carregar(); } }, t)));
    montar(corpo, r.disponivel ? h('div', { class: 'rolavel' }, h('table', null, h('thead', null, h('tr', null, ['#', 'Nome', 'Pontos', 'Média', 'Doações', 'Pontualidade', 'Reconhecimentos'].map((c) => h('th', null, c)))),
      h('tbody', null, r.ranking.map((x) => h('tr', null, h('td', null, x.posicao), h('td', null, x.nome, x.penalizado ? h('span', { class: 'selo REJEITADO', style: 'margin-left:.4rem', title: 'Três ou mais avaliações baixas em 30 dias' }, 'penalizado') : null),
        h('td', null, h('b', null, fmtNum(x.pontuacao))), h('td', null, `${fmtNum(x.mediaNota)} ★`), h('td', null, x.doacoes), h('td', null, `${x.pontualidade}%`),
        h('td', null, x.reconhecimentos.map((rc) => h('span', { title: rc.descricao }, rc.tipo === 'SELO' ? '🏅 ' : '📜 '))))))),
    ) : h('div', { class: 'cartao vazio' }, 'Ainda não há avaliações suficientes para montar o ranking.'), h('p', { class: 'pequeno suave' }, r.criterios));
  }
  await carregar();
  return h('div', null, h('h1', null, 'Ranking de solidariedade'), abas, corpo);
}

// ---------- histórico (UC34–36) ----------
export async function historico() {
  const f = { ordenar: 'data', ordem: 'desc', categoria: '', nota: '', de: '', ate: '' };
  const tabela = h('div');
  async function carregar() {
    const r = await GET(`/api/historico${qs(f)}`);
    montar(tabela, r.historico.length ? h('div', { class: 'rolavel' }, h('table', null, h('thead', null, h('tr', null, ['Data', sessao.usuario.tipo === 'OSC' ? 'Doador' : 'OSC', 'Alimento', 'Categoria', 'Quantidade', 'Situação', 'Nota'].map((c) => h('th', null, c)))),
      h('tbody', null, r.historico.map((x) => h('tr', null, h('td', null, fmtData(x.dataConclusao)), h('td', null, sessao.usuario.tipo === 'OSC' ? x.estabelecimento : x.osc), h('td', null, x.tipoAlimento), h('td', null, x.categoria), h('td', null, fmtKg(x.quantidadeKg)), h('td', null, selo(x.situacao)), h('td', null, x.nota ? `${x.nota} ★` : '—')))))) 
      : h('div', { class: 'cartao vazio' }, 'Nenhum resultado.', h('br'), botao('Limpar filtros', () => { Object.assign(f, { categoria: '', nota: '', de: '', ate: '' }); ir('#/historico'); }, 'sec mini')));
  }
  await carregar();
  const mud = (k) => (e) => { f[k] = e.target.value; carregar(); };
  return h('div', null, h('h1', null, 'Histórico de doações'),
    h('div', { class: 'cartao' }, h('div', { class: 'form-grade' },
      campo('Ordenar por', selecao('o', [['data', 'Data'], ['quantidade', 'Quantidade'], ['estabelecimento', 'Estabelecimento']], f.ordenar, { onchange: mud('ordenar') })),
      campo('Ordem', selecao('d', [['desc', 'Decrescente'], ['asc', 'Crescente']], f.ordem, { onchange: mud('ordem') })),
      campo('Categoria', selecao('c', [['', 'Todas'], ...CATEGORIAS.map((c) => [c, c])], '', { onchange: mud('categoria') })),
      campo('Nota', selecao('n', [['', 'Todas'], ...[5, 4, 3, 2, 1].map((n) => [String(n), `${n} ★`])], '', { onchange: mud('nota') })),
      campo('De', entrada('de', { type: 'date', onchange: mud('de') })), campo('Até', entrada('ate', { type: 'date', onchange: mud('ate') })))), h('div', { style: 'height:12px' }), tabela);
}

// ---------- recibos (UC28) ----------
export async function recibos() {
  const { recibos: lista } = await GET('/api/recibos');
  return h('div', null, h('h1', null, 'Recibos de doação'), h('p', { class: 'suave' }, 'Comprovantes que atestam a destinação dos alimentos. Qualquer pessoa pode conferir a autenticidade pelo código.'),
    lista.length ? h('div', { class: 'grade' }, lista.map((r) => h('article', { class: 'cartao coluna' }, h('h3', { style: 'margin:0' }, r.numero),
      h('p', null, `${r.estabelecimento.nome} → ${r.osc.nome}`), h('p', { class: 'suave' }, `${fmtKg(r.quantidadeKg)} de ${r.tipoAlimento} · ${fmtData(r.dataEmissao)}`),
      h('p', { class: 'pequeno' }, 'Código: ', h('b', null, r.codigoVerificacao), ' · ', h('a', { href: `#/verificar/${r.codigoVerificacao}` }, 'verificar')),
      h('a', { class: 'botao mini', href: `/api/recibos/${r.id}/pdf` }, '⬇ Baixar PDF')))) : h('div', { class: 'cartao vazio' }, 'Os recibos aparecem aqui assim que a OSC confirma o recebimento.'));
}

// ---------- suporte (UC42/UC43) ----------
export async function suporte() {
  const ehGestor = sessao.usuario.tipo === 'GESTOR';
  const filtro = { status: '' };
  const lista = h('div');
  async function carregar() {
    const { chamados } = await GET(`/api/chamados${qs(filtro)}`);
    montar(lista, chamados.length ? h('div', { class: 'coluna' }, chamados.map((c) => h('a', { class: 'cartao', href: `#/suporte/${c.id}`, style: 'text-decoration:none;color:inherit' },
      h('div', { class: 'linha entre' }, h('b', null, `${c.protocolo} · ${c.assunto}`), selo(c.status)), h('span', { class: 'suave pequeno' }, `${ehGestor ? `${c.solicitante} · ` : ''}${rotulo(c.categoria) } · ${fmtData(c.abertoEm)}`)))) : h('div', { class: 'cartao vazio' }, 'Nenhum chamado.'));
  }
  await carregar();
  const erro = h('div');
  const form = h('form', { class: 'cartao', novalidate: true }, h('h2', { style: 'margin-top:0' }, 'Abrir chamado'),
    h('div', { class: 'form-grade' }, campo('Categoria', selecao('categoria', [['ACESSO', 'Acesso / login'], ['OFERTA', 'Ofertas e reservas'], ['ENTREGA', 'Entrega'], ['CADASTRO', 'Cadastro'], ['OUTRO', 'Outro']])), campo('Assunto', entrada('assunto', { required: true, maxlength: 150 }))),
    campo('Descreva o problema', h('textarea', { name: 'descricao', required: true, maxlength: 3000 })), campo('Imagem (opcional)', entrada('anexo', { type: 'file', accept: 'image/jpeg,image/png,image/webp' })), erro,
    h('button', { class: 'botao', type: 'submit' }, 'Enviar chamado'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); montar(erro);
    if (!form.reportValidity()) return;
    try {
      const d = lerForm(form); const f = form.elements.anexo.files[0]; d.anexo = f ? await lerArquivo(f) : undefined;
      const r = await POST('/api/chamados', d); aviso(`Chamado aberto! Protocolo ${r.protocolo}`, 'ok'); ir(`#/suporte/${r.id}`);
    } catch (e) { montar(erro, erroBox(e)); }
  });
  return h('div', null, h('h1', null, ehGestor ? 'Chamados de suporte' : 'Suporte'),
    ehGestor ? h('div', { class: 'abas' }, [['', 'Todos'], ['ABERTO', 'Abertos'], ['EM_ATENDIMENTO', 'Em atendimento'], ['RESOLVIDO', 'Resolvidos']].map(([k, t]) => h('button', { 'aria-pressed': String(filtro.status === k), onclick: (e) => { filtro.status = k; e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); carregar(); } }, t))) : null,
    lista, ehGestor ? null : h('div', { style: 'height:16px' }), ehGestor ? null : form);
}

export async function chamado({ params }) {
  const id = params.id; const ehGestor = sessao.usuario.tipo === 'GESTOR';
  const corpo = h('div');
  async function carregar() {
    const r = await GET(`/api/chamados/${id}`); const c = r.chamado;
    const txt = h('textarea', { required: true, maxlength: 3000, placeholder: ehGestor ? 'Responder ao usuário…' : 'Adicionar informação…' });
    montar(corpo, h('p', null, h('a', { href: '#/suporte' }, '← Chamados')), h('div', { class: 'linha entre' }, h('h1', { style: 'margin:0' }, `${c.protocolo}`), selo(c.status)),
      h('p', { class: 'suave' }, `${c.assunto} · ${rotulo(c.categoria)} · aberto em ${fmtData(c.abertoEm)}${ehGestor ? ` por ${c.solicitante}` : ''}`),
      h('div', { class: 'cartao' }, c.descricao, c.anexo ? h('p', null, h('a', { href: arquivo(c.anexo), target: '_blank', rel: 'noopener' }, 'Ver anexo')) : null),
      h('div', { class: 'coluna', style: 'margin:1rem 0' }, r.mensagens.map((m) => h('div', { class: `cartao ${m.autorTipo === 'GESTOR' ? 'ok' : ''}` }, h('b', null, `${m.autor}${m.autorTipo === 'GESTOR' ? ' (suporte)' : ''}`), h('small', { class: 'suave' }, ` · ${fmtData(m.data)}`), h('br'), m.texto))),
      c.status !== 'FECHADO' ? h('form', { class: 'cartao', onsubmit: async (ev) => { ev.preventDefault(); if (!txt.value.trim()) return; try { await POST(`/api/chamados/${id}/mensagens`, { texto: txt.value }); carregar(); } catch (e) { aviso(e.message, 'erro'); } } }, txt, h('div', { class: 'linha', style: 'margin-top:.6rem' }, h('button', { class: 'botao', type: 'submit' }, 'Enviar'),
        ehGestor ? [['EM_ATENDIMENTO', 'Em atendimento'], ['RESOLVIDO', 'Marcar resolvido'], ['FECHADO', 'Fechar']].map(([s, t]) => botao(t, async () => { await POST(`/api/chamados/${id}/status`, { status: s }); carregar(); }, 'sec')) : null)) : h('div', { class: 'info' }, 'Este chamado foi fechado.'));
  }
  await carregar();
  return corpo;
}

// ---------- pesquisas (UC44) ----------
export async function pesquisas() {
  const { pesquisas: lista } = await GET('/api/pesquisas');
  return h('div', null, h('h1', null, 'Pesquisas de satisfação'),
    lista.length ? h('div', { class: 'coluna' }, lista.map((p) => {
      if (p.respondida) return h('div', { class: 'cartao ok' }, h('b', null, p.titulo), ' — obrigado, você já respondeu!');
      const notas = p.perguntas.map(() => 0); const est = estrelas(0); const com = h('textarea', { maxlength: 1000, placeholder: 'Comentário (opcional)' });
      return h('div', { class: 'cartao coluna' }, h('h3', { style: 'margin:0' }, p.titulo), h('span', { class: 'suave pequeno' }, `Disponível até ${fmtDia(p.periodoFim)}`),
        p.perguntas.map((q, i) => h('div', null, h('b', null, q), estrelas(0, (v) => { notas[i] = v; }))), h('div', null, h('b', null, 'Nota geral'), est), com,
        botao('Enviar respostas', async () => {
          if (!est.valor()) throw new Error('Informe a nota geral.');
          await POST(`/api/pesquisas/${p.id}/responder`, { notaGeral: est.valor(), respostas: notas, comentario: com.value }); aviso('Resposta registrada. Obrigado!', 'ok'); ir('#/pesquisas');
        }));
    })) : h('div', { class: 'cartao vazio' }, 'Nenhuma pesquisa ativa no momento.'));
}

// ---------- feedback anônimo (UC45) ----------
export function feedback() {
  const erro = h('div');
  const form = h('form', { class: 'cartao', novalidate: true },
    h('div', { class: 'info' }, '🔒 Seu envio é anônimo. O sistema não guarda quem você é, nem registra seu acesso nos logs: apenas a data e o texto da mensagem.'),
    campo('Tipo', selecao('tipo', [['SUGESTAO', 'Sugestão'], ['DENUNCIA', 'Denúncia']])),
    campo('Mensagem', h('textarea', { name: 'texto', required: true, maxlength: 3000, placeholder: 'Descreva com o máximo de detalhes. Evite incluir dados que identifiquem você.' })),
    campo('Imagem (opcional)', entrada('anexo', { type: 'file', accept: 'image/jpeg,image/png,image/webp' }), 'Fotos podem conter informações que identificam você (metadados).'), erro,
    h('button', { class: 'botao grande', type: 'submit' }, 'Enviar anonimamente'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault(); montar(erro);
    if (!form.reportValidity()) return;
    try {
      const d = lerForm(form); const f = form.elements.anexo.files[0]; d.anexo = f ? await lerArquivo(f) : undefined;
      const r = await POST('/api/feedback', d); aviso(r.mensagem, 'ok'); form.reset();
    } catch (e) { montar(erro, erroBox(e)); }
  });
  return h('div', null, h('h1', null, 'Sugestão ou denúncia anônima'), form);
}
