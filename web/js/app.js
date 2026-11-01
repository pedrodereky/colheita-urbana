import { api, GET, POST, definirAoDeslogar } from './api.js';
import { h, montar, aviso, carregando, erroBox, fmtData } from './ui.js';
import { sessao, ouvir, limparOuvintes, despachar } from './ctx.js';
import * as publico from './views/publico.js';
import * as estab from './views/estab.js';
import * as osc from './views/osc.js';
import * as transp from './views/transp.js';
import * as entrega from './views/entrega.js';
import * as comum from './views/comum.js';
import * as gestor from './views/gestor.js';

const E = 'ESTABELECIMENTO', O = 'OSC', T = 'TRANSPORTADOR', G = 'GESTOR';

// padrão, perfis permitidos (null = qualquer logado, 'publico' = sem login), tela
const rotas = [
  ['/login', 'publico', publico.login], ['/cadastro', 'publico', publico.escolherCadastro], ['/cadastro/:tipo', 'publico', publico.cadastro],
  ['/esqueci', 'publico', publico.esqueci], ['/redefinir', 'publico', publico.redefinir], ['/verificar/:codigo', 'publico', publico.verificarRecibo],
  ['/', null, (c) => ({ [E]: estab.minhasOfertas, [O]: osc.ofertas, [T]: transp.coletas, [G]: gestor.painel })[sessao.usuario.tipo](c)],
  ['/ofertas/nova', [E], estab.novaOferta],
  ['/reservas', [O], osc.reservas],
  ['/entregas', [E, O, T], entrega.lista], ['/entrega/:id', [E, O, T, G], entrega.detalhe],
  ['/recibos', [E, O], comum.recibos], ['/historico', [E, O], comum.historico],
  ['/ranking', null, comum.ranking], ['/perfil', null, comum.perfil], ['/notificacoes', null, comum.notificacoes],
  ['/suporte', null, comum.suporte], ['/suporte/:id', null, comum.chamado], ['/pesquisas', [E, O, T], comum.pesquisas], ['/feedback', [E, O, T], comum.feedback],
  ['/cadastros', [G], gestor.cadastros], ['/feedbacks', [G], gestor.feedbacks], ['/pesquisas-gestor', [G], gestor.pesquisas], ['/auditoria', [G], gestor.auditoria],
].map(([padrao, perfis, tela]) => {
  const nomes = [];
  const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
  return { padrao, perfis, tela, re, nomes };
});

const MENU = {
  [E]: [['/', 'Minhas ofertas'], ['/ofertas/nova', 'Nova oferta'], ['/entregas', 'Entregas'], ['/recibos', 'Recibos'], ['/historico', 'Histórico'], ['/ranking', 'Ranking'], ['/suporte', 'Suporte']],
  [O]: [['/', 'Ofertas'], ['/reservas', 'Minhas reservas'], ['/entregas', 'Entregas'], ['/historico', 'Histórico'], ['/recibos', 'Recibos'], ['/ranking', 'Ranking'], ['/suporte', 'Suporte']],
  [T]: [['/', 'Coletas'], ['/entregas', 'Minhas entregas'], ['/ranking', 'Ranking'], ['/suporte', 'Suporte']],
  [G]: [['/', 'Painel'], ['/cadastros', 'Cadastros'], ['/suporte', 'Chamados'], ['/feedbacks', 'Feedbacks'], ['/pesquisas-gestor', 'Pesquisas'], ['/auditoria', 'Auditoria'], ['/ranking', 'Ranking']],
};

const raiz = document.getElementById('app');
let principal = null, navEl = null, sino = null, fonte = null;

// ---------- preferências de acessibilidade (RNF15) ----------
const prefs = (() => { try { return JSON.parse(localStorage.getItem('cu_prefs') || '{}'); } catch { return {}; } })();
function aplicarPrefs() {
  document.documentElement.dataset.fonte = prefs.fonte || '';
  document.documentElement.dataset.contraste = prefs.contraste || '';
  try { localStorage.setItem('cu_prefs', JSON.stringify(prefs)); } catch { /* modo privado */ }
}
aplicarPrefs();

// ---------- layout ----------
const logo = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 64 64'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<circle cx="32" cy="32" r="30" fill="#fff"/><path d="M32 12c11 6 15 17 9 27-3 5-9 9-9 9s-6-4-9-9c-6-10-2-21 9-27z" fill="#ffb300"/><path d="M32 22v26" stroke="#1b5e20" stroke-width="3" fill="none"/>'; return s; };

function desenharLayout() {
  const u = sessao.usuario;
  navEl = h('nav', { class: 'nav recolhido', 'aria-label': 'Menu principal' }, (MENU[u?.tipo] || []).map(([r, t]) => h('a', { href: `#${r}`, 'data-rota': r }, t)));
  const menuBtn = h('button', { class: 'icone-botao menu-botao', 'aria-expanded': 'false', 'aria-controls': 'menu', onclick: (e) => { navEl.classList.toggle('recolhido'); e.currentTarget.setAttribute('aria-expanded', String(!navEl.classList.contains('recolhido'))); } }, '☰ Menu');
  navEl.id = 'menu';
  const acess = h('div', { class: 'linha', style: 'gap:.3rem' },
    h('button', { class: 'icone-botao', title: 'Aumentar ou reduzir o texto', 'aria-label': 'Alternar tamanho do texto', onclick: () => { prefs.fonte = prefs.fonte === 'grande' ? '' : 'grande'; aplicarPrefs(); } }, 'A+'),
    h('button', { class: 'icone-botao', title: 'Alto contraste', 'aria-label': 'Alternar alto contraste', onclick: () => { prefs.contraste = prefs.contraste === 'alto' ? '' : 'alto'; aplicarPrefs(); } }, '◐'));
  const logado = u ? [
    sino = h('button', { class: 'icone-botao', 'aria-label': 'Notificações', onclick: alternarPainelNotif }, '🔔', h('span', { class: 'selo-contador', hidden: true }, '0')),
    h('a', { class: 'icone-botao', href: '#/perfil', style: 'text-decoration:none;display:inline-flex;align-items:center', title: 'Meu perfil' }, `👤 ${u.nome.split(' ')[0]}`),
    h('button', { class: 'icone-botao', onclick: sair }, 'Sair'),
  ] : [h('a', { class: 'icone-botao', href: '#/login', style: 'text-decoration:none;display:inline-flex;align-items:center' }, 'Entrar')];
  principal = h('main', { id: 'principal', tabindex: '-1' });
  montar(raiz,
    h('header', { class: 'topo' }, h('div', { class: 'barra' },
      h('a', { class: 'marca', href: '#/' }, logo(), 'Colheita Urbana'), acess, ...logado, u ? menuBtn : null, u ? navEl : null)),
    principal);
}

// ---------- notificações ----------
let painelNotif = null;
async function atualizarContador() {
  if (!sessao.usuario || !sino) return;
  try {
    const { naoLidas } = await GET('/api/notificacoes');
    const c = sino.querySelector('.selo-contador');
    c.textContent = String(naoLidas); c.hidden = naoLidas === 0;
    sino.setAttribute('aria-label', `Notificações: ${naoLidas} não lidas`);
  } catch { /* ignora */ }
}
async function alternarPainelNotif() {
  if (painelNotif) { painelNotif.remove(); painelNotif = null; return; }
  const { notificacoes } = await GET('/api/notificacoes');
  painelNotif = h('div', { class: 'painel-notif', role: 'dialog', 'aria-label': 'Notificações' },
    h('header', null, 'Notificações', h('a', { href: '#/notificacoes', onclick: () => { painelNotif?.remove(); painelNotif = null; } }, 'Ver todas')),
    notificacoes.length ? notificacoes.slice(0, 8).map((n) => h('div', { class: `notif-item ${n.lida ? '' : 'nova'}` }, n.mensagem, h('br'), h('small', null, fmtData(n.dataEnvio)))) : h('p', { class: 'vazio' }, 'Nenhuma notificação.'));
  document.body.append(painelNotif);
  await POST('/api/notificacoes/lidas'); atualizarContador();
}

// ---------- tempo real (SSE) ----------
let fonteEventos = null;
function conectarEventos() {
  fonteEventos?.close();
  if (!sessao.usuario || typeof EventSource === 'undefined') return;
  fonteEventos = new EventSource('/api/stream');
  fonteEventos.addEventListener('notificacao', (e) => { const d = JSON.parse(e.data); aviso(`🔔 ${d.mensagem}`); atualizarContador(); despachar('notificacao', d); });
  for (const ev of ['entrega', 'localizacao', 'chat']) fonteEventos.addEventListener(ev, (e) => despachar(ev, JSON.parse(e.data)));
}

// ---------- sessão ----------
async function sair() {
  try { await POST('/api/logout'); } catch { /* já deslogado */ }
  fonteEventos?.close(); sessao.usuario = null; location.hash = '#/login'; rotear();
}
definirAoDeslogar(() => { if (sessao.usuario) { sessao.usuario = null; fonteEventos?.close(); aviso('Sua sessão expirou. Entre novamente.', 'erro'); location.hash = '#/login'; rotear(); } });

// ---------- roteador ----------
async function rotear() {
  limparOuvintes();
  painelNotif?.remove(); painelNotif = null;
  const bruto = location.hash.replace(/^#/, '') || '/';
  const [caminho, consulta = ''] = bruto.split('?');
  const query = Object.fromEntries(new URLSearchParams(consulta));
  const alvo = rotas.map((r) => ({ r, m: caminho.match(r.re) })).find((x) => x.m);
  if (!alvo) { location.hash = '#/'; return; }
  const { r, m } = alvo;
  const params = Object.fromEntries(r.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])]));

  if (r.perfis === 'publico') { if (sessao.usuario) { location.hash = '#/'; return; } }
  else if (!sessao.usuario) { location.hash = '#/login'; return; }
  else if (r.perfis && !r.perfis.includes(sessao.usuario.tipo)) { location.hash = '#/'; return; }

  desenharLayoutSeNecessario();
  navEl?.querySelectorAll('a').forEach((a) => (a.getAttribute('data-rota') === (caminho.startsWith('/entrega/') ? '/entregas' : caminho) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  navEl?.classList.add('recolhido');
  montar(principal, carregando());
  try {
    const conteudo = await r.tela({ params, query });
    montar(principal, conteudo);
    document.title = caminho === '/login' ? 'Entrar · Colheita Urbana' : `${principal.querySelector('h1')?.textContent || 'Início'} · Colheita Urbana`;
    principal.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) { montar(principal, erroBox(e)); }
}

let layoutDe = undefined;
function desenharLayoutSeNecessario() {
  const chave = sessao.usuario ? `${sessao.usuario.id}:${sessao.usuario.nome}` : 'anon';
  if (layoutDe !== chave || !principal?.isConnected) { desenharLayout(); layoutDe = chave; atualizarContador(); }
}
window.addEventListener('hashchange', rotear);

(async () => {
  try { sessao.usuario = (await api('GET', '/api/me')).usuario; conectarEventos(); } catch { sessao.usuario = null; }
  window.addEventListener('cu:login', () => { layoutDe = undefined; conectarEventos(); });
  window.addEventListener('cu:perfil', () => { layoutDe = undefined; });
  rotear();
})();
