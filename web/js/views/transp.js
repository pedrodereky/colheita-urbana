import { GET, POST } from '../api.js';
import { h, montar, aviso, botao, confirmar, selo, fmtKg, fmtData, fmtRestante, fmtNum } from '../ui.js';
import { ouvir, ir } from '../ctx.js';
import { rotuloConservacao } from './componentes.js';

export async function coletas() {
  const lista = h('div', { class: 'grade' });
  const cab = h('div');
  async function carregar() {
    const r = await GET('/api/coletas/disponiveis');
    montar(cab, h('div', { class: r.ativas >= r.limite ? 'alerta' : 'info' }, `Você tem ${r.ativas} de ${r.limite} coletas ativas.`, r.ativas >= r.limite ? ' Conclua uma para aceitar outra.' : ''));
    montar(lista, r.coletas.length ? r.coletas.map((c) => h('article', { class: 'cartao coluna' },
      h('div', { class: 'linha entre' }, h('h3', { style: 'margin:0' }, c.tipoAlimento), selo('RESERVADA', 'Aguardando voluntário')),
      h('div', { class: 'metricas' },
        h('div', { class: 'metrica' }, h('b', null, fmtKg(c.quantidadeKg)), 'carga'), h('div', { class: 'metrica' }, h('b', null, `${fmtNum(c.distanciaAteRetiradaKm)} km`), 'até a retirada'), h('div', { class: 'metrica' }, h('b', null, `${fmtNum(c.distanciaTrajetoKm)} km`), 'retirada → entrega')),
      h('p', null, `🏪 ${c.estabelecimento}`, h('br'), `🤝 ${c.osc}`),
      h('p', { class: 'pequeno suave' }, `${rotuloConservacao(c.conservacao)} · vence em ${fmtRestante(c.validade)} · retirar até ${fmtData(c.janelaFim)}`),
      botao('Aceitar coleta', async () => {
        const r2 = await POST(`/api/coletas/${c.id}/aceitar`); aviso('Coleta aceita!', 'ok'); ir(`#/entrega/${r2.coletaId}`);
      }, 'grande'))) : h('div', { class: 'cartao vazio', style: 'grid-column:1/-1' }, 'Nenhuma coleta disponível para o seu veículo agora. Avisaremos quando houver.'));
  }
  await carregar();
  ouvir((ev) => { if (ev === 'notificacao' || ev === 'entrega') carregar(); });
  return h('div', null, h('h1', null, 'Coletas disponíveis'), cab, lista);
}
