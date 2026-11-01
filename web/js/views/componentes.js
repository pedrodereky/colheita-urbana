import { h, selo, fmtData, fmtKg, fmtRestante } from '../ui.js';

export const CATEGORIAS = ['Hortifruti', 'Panificação', 'Prontos', 'Laticínios', 'Carnes e ovos', 'Não perecíveis', 'Bebidas', 'Outros'];
export const CONSERVACOES = [['AMBIENTE', 'Ambiente (seco)'], ['REFRIGERADO', 'Refrigerado'], ['CONGELADO', 'Congelado']];
export const rotuloConservacao = (c) => (CONSERVACOES.find(([k]) => k === c) || [, c])[1];
export const arquivo = (nome) => `/api/arquivos/${nome}`;

export function fotoOferta(o) {
  return o.imagens?.length
    ? h('img', { class: 'foto', src: arquivo(o.imagens[0]), alt: `Foto de ${o.tipoAlimento}`, loading: 'lazy' })
    : h('div', { class: 'sem-foto', 'aria-hidden': 'true' }, { Hortifruti: '🥬', Panificação: '🥖', Prontos: '🍱', Laticínios: '🥛', 'Carnes e ovos': '🍗', Bebidas: '🥤' }[o.categoria] || '📦');
}

export function cartaoOferta(o, { acoes = [], extra = [] } = {}) {
  return h('article', { class: 'cartao oferta' },
    fotoOferta(o),
    h('div', { class: 'linha entre' }, h('h3', { style: 'margin:0' }, o.tipoAlimento), selo(o.estado)),
    h('div', { class: 'linha' }, selo(o.urgencia), h('span', { class: 'suave pequeno' }, o.categoria)),
    h('div', { class: 'metricas' },
      h('div', { class: 'metrica' }, h('b', null, fmtKg(o.quantidadeKg)), 'quantidade'),
      h('div', { class: 'metrica' }, h('b', null, fmtRestante(o.validade)), 'para vencer'),
      h('div', { class: 'metrica' }, h('b', null, rotuloConservacao(o.conservacao)), 'conservação')),
    h('p', { class: 'pequeno suave' }, `Retirada: ${fmtData(o.janelaInicio)} → ${fmtData(o.janelaFim)}`),
    ...extra,
    acoes.length ? h('div', { class: 'linha' }, acoes) : null);
}
