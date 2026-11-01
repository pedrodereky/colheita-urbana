// Pequenos utilitários de DOM (sem innerHTML com dados do usuário: evita XSS)
export function h(tag, props, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'multiple' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  anexar(el, filhos);
  return el;
}
function anexar(el, filhos) {
  for (const f of filhos.flat(Infinity)) {
    if (f == null || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
}
export const limpar = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const montar = (el, ...filhos) => { limpar(el); anexar(el, filhos); return el; };

export function aviso(texto, tipo = '') {
  const alvo = document.getElementById('avisos');
  const el = h('div', { class: `aviso-item ${tipo}` }, texto);
  alvo.append(el);
  setTimeout(() => el.remove(), tipo === 'erro' ? 7000 : 4000);
}

export function modal(titulo, conteudo, { largo = false, aoFechar } = {}) {
  const anterior = document.activeElement;
  const fechar = () => { fundo.remove(); document.removeEventListener('keydown', esc); anterior?.focus?.(); aoFechar?.(); };
  const esc = (e) => { if (e.key === 'Escape') fechar(); };
  const caixa = h('div', { class: `modal${largo ? ' largo' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo },
    h('div', { class: 'linha entre' }, h('h2', { style: 'margin:0' }, titulo), h('button', { class: 'botao sec mini', type: 'button', onclick: fechar, 'aria-label': 'Fechar' }, '✕')),
    conteudo);
  const fundo = h('div', { class: 'fundo-modal', onclick: (e) => { if (e.target === fundo) fechar(); } }, caixa);
  document.body.append(fundo);
  document.addEventListener('keydown', esc);
  (caixa.querySelector('input,select,textarea,button.botao:not(.sec)') || caixa).focus?.();
  return { fechar, caixa };
}

export function confirmar(titulo, texto, rotulo = 'Confirmar', perigo = false) {
  return new Promise((ok) => {
    const m = modal(titulo, h('div', null,
      h('p', null, texto),
      h('div', { class: 'linha', style: 'margin-top:1rem' },
        h('button', { class: `botao ${perigo ? 'perigo' : ''}`, onclick: () => { ok(true); m.fechar(); } }, rotulo),
        h('button', { class: 'botao sec', onclick: () => { ok(false); m.fechar(); } }, 'Voltar'))),
    { aoFechar: () => ok(false) });
  });
}

// ---- formatação ----
const ROT_ESTADO = { DISPONIVEL: 'Disponível', RESERVADA: 'Reservada', EM_COLETA: 'Em coleta', EM_TRANSPORTE: 'Em transporte', ENTREGUE: 'Entregue', RECUSADA: 'Recusada', EXPIRADA: 'Expirada', CANCELADA: 'Cancelada', AVALIADA: 'Avaliada',
  PENDENTE: 'Pendente', APROVADO: 'Aprovado', REJEITADO: 'Rejeitado', SUSPENSO: 'Suspenso', ABERTO: 'Aberto', EM_ATENDIMENTO: 'Em atendimento', RESOLVIDO: 'Resolvido', FECHADO: 'Fechado', NOVO: 'Novo', EM_ANALISE: 'Em análise',
  CRITICA: 'Validade crítica', CURTA: 'Validade curta', NORMAL: 'Validade normal', SUGESTAO: 'Sugestão', DENUNCIA: 'Denúncia', CONCLUIDA: 'Concluída' };
export const rotulo = (k) => ROT_ESTADO[k] || k;
export const selo = (k, texto) => h('span', { class: `selo ${k}` }, texto || rotulo(k));
export const fmtData = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtDia = (iso) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');
export const fmtKg = (n) => `${Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg`;
export const fmtNum = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
export function fmtRestante(iso) {
  const min = Math.round((new Date(iso) - Date.now()) / 60000);
  if (min <= 0) return 'vencido';
  const d = Math.floor(min / 1440), hh = Math.floor((min % 1440) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${min % 60}min` : `${min}min`;
}
export const paraInputLocal = (d) => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return x.toISOString().slice(0, 16); };
export const deInputLocal = (v) => (v ? new Date(v).toISOString() : '');

export function lerArquivo(arquivo) {
  return new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => falha(new Error('Não foi possível ler o arquivo.'));
    r.readAsDataURL(arquivo);
  });
}

// Campo de formulário rotulado
export function campo(rotuloTxt, input, dica) {
  const id = input.id || `c${Math.random().toString(36).slice(2, 8)}`;
  input.id = id;
  return h('div', { class: 'campo' }, h('label', { for: id }, rotuloTxt), input, dica ? h('div', { class: 'dica' }, dica) : null);
}
export const entrada = (nome, props = {}) => h('input', { name: nome, ...props });
export const selecao = (nome, opcoes, valor, props = {}) => h('select', { name: nome, ...props },
  opcoes.map(([v, t]) => h('option', { value: v, selected: v === valor }, t)));

export function estrelas(valorInicial = 0, aoMudar) {
  let valor = valorInicial;
  const caixa = h('div', { class: 'estrelas', role: 'radiogroup', 'aria-label': 'Nota de 1 a 5' });
  const desenhar = () => {
    limpar(caixa);
    for (let i = 1; i <= 5; i++) {
      caixa.append(h('button', { type: 'button', class: i <= valor ? 'on' : '', role: 'radio', 'aria-checked': String(i === valor), 'aria-label': `${i} estrela${i > 1 ? 's' : ''}`, onclick: () => { valor = i; aoMudar?.(i); desenhar(); } }, '★'));
    }
  };
  desenhar();
  caixa.valor = () => valor;
  return caixa;
}

export function carregando() { return h('p', { class: 'vazio', role: 'status' }, 'Carregando…'); }
export function erroBox(e) { return h('div', { class: 'erro', role: 'alert' }, e.message || String(e)); }

// Executa uma ação de botão com bloqueio de duplo clique e tratamento de erro
export function acao(btn, fn) {
  return async (ev) => {
    ev?.preventDefault?.();
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } catch (e) { aviso(e.message, 'erro'); } finally { btn.disabled = false; }
  };
}
export function botao(texto, fn, classe = '') {
  const b = h('button', { class: `botao ${classe}`, type: 'button' }, texto);
  b.addEventListener('click', acao(b, fn));
  return b;
}
