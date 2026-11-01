import { GET, POST, qs } from '../api.js';
import { h, montar, campo, entrada, selecao, aviso, botao, erroBox, selo, fmtKg, fmtData, fmtRestante, fmtNum, modal } from '../ui.js';
import { ouvir, ir } from '../ctx.js';
import { cartaoOferta, CATEGORIAS, CONSERVACOES, rotuloConservacao } from './componentes.js';

export async function ofertas() {
  const filtros = { categoria: '', conservacao: '' };
  const lista = h('div', { class: 'grade' });
  const topo = h('div');
  async function carregar() {
    const r = await GET(`/api/ofertas${qs(filtros)}`);
    montar(topo, r.aviso ? h('div', { class: 'alerta', role: 'alert' }, r.aviso) : null);
    montar(lista, r.ofertas.length ? r.ofertas.map((o) => cartaoOferta(o, {
      extra: [
        h('div', { class: 'linha pequeno' }, h('span', null, `📍 ${o.distanciaKm != null ? `${fmtNum(o.distanciaKm)} km · ~${o.tempoEstimadoMin} min` : 'distância indisponível'}`), h('span', null, `🏪 ${o.estabelecimento}`)),
        !o.cabeNaCapacidade ? h('div', { class: 'alerta pequeno' }, `Acima da sua capacidade livre (${fmtKg(o.capacidadeLivreKg)}).`) : null,
      ],
      acoes: [h('button', { class: 'botao grande', type: 'button', disabled: !o.cabeNaCapacidade, onclick: () => assistenteReserva(o, carregar) }, 'Quero esta doação')],
    })) : h('div', { class: 'cartao vazio', style: 'grid-column:1/-1' }, 'Nenhuma oferta disponível no momento. Avisaremos você quando surgir uma nova.'));
  }
  await carregar();
  ouvir((ev) => { if (ev === 'notificacao') carregar(); });
  const filtro = h('div', { class: 'linha' },
    h('div', { style: 'min-width:200px' }, campo('Categoria', selecao('categoria', [['', 'Todas'], ...CATEGORIAS.map((c) => [c, c])], '', { onchange: (e) => { filtros.categoria = e.target.value; carregar(); } }))),
    h('div', { style: 'min-width:200px' }, campo('Conservação', selecao('conservacao', [['', 'Todas'], ...CONSERVACOES], '', { onchange: (e) => { filtros.conservacao = e.target.value; carregar(); } }))));
  return h('div', null, h('h1', null, 'Doações disponíveis perto de você'),
    h('p', { class: 'suave' }, 'Ordenadas por proximidade, urgência de validade e equilíbrio na distribuição entre as OSCs.'), filtro, topo, lista);
}

// Reserva em até 4 passos (RNF06): 1 escolher (lista) → 2 revisar → 3 modalidade → 4 confirmar
function assistenteReserva(o, aoConcluir) {
  let passo = 2; let modalidade = 'VOLUNTARIO'; let responsavel = '';
  const corpo = h('div');
  const m = modal('Reservar doação', corpo);
  const barra = () => h('div', { class: 'passos', 'aria-label': `Passo ${passo} de 4` }, [1, 2, 3, 4].map((i) => h('span', { class: i <= passo ? 'feito' : '' })));
  function desenhar() {
    const erro = h('div');
    if (passo === 2) {
      montar(corpo, barra(), h('p', { class: 'suave' }, 'Passo 2 de 4 · Revise a doação'),
        h('h3', null, o.tipoAlimento), h('ul', null,
          h('li', null, `Quantidade: ${fmtKg(o.quantidadeKg)}`), h('li', null, `Conservação: ${rotuloConservacao(o.conservacao)}`), h('li', null, `Vence em ${fmtRestante(o.validade)}`),
          h('li', null, `Doador: ${o.estabelecimento}`), h('li', null, `Retirada: ${fmtData(o.janelaInicio)} → ${fmtData(o.janelaFim)}`)),
        h('button', { class: 'botao grande', onclick: () => { passo = 3; desenhar(); } }, 'Continuar'));
    } else if (passo === 3) {
      const resp = entrada('resp', { value: responsavel, placeholder: 'Nome de quem vai retirar', maxlength: 120, oninput: (e) => { responsavel = e.target.value; } });
      const bloco = h('div', { hidden: modalidade !== 'PROPRIO' }, campo('Responsável pela retirada', resp));
      const opcao = (valor, titulo, txt) => h('label', null, h('input', { type: 'radio', name: 'mod', value: valor, checked: modalidade === valor, onchange: () => { modalidade = valor; bloco.hidden = valor !== 'PROPRIO'; } }), h('span', null, h('b', null, titulo), h('br'), txt));
      montar(corpo, barra(), h('p', { class: 'suave' }, 'Passo 3 de 4 · Como será a retirada?'),
        h('div', { class: 'escolha' }, opcao('VOLUNTARIO', 'Transportador voluntário', 'Um voluntário parceiro busca e entrega para você.'), opcao('PROPRIO', 'Transporte próprio da OSC', 'Sua equipe retira no doador. Você assume o papel do transportador.')),
        bloco, h('div', { class: 'linha', style: 'margin-top:1rem' }, h('button', { class: 'botao sec', onclick: () => { passo = 2; desenhar(); } }, 'Voltar'),
          h('button', { class: 'botao', style: 'flex:1', onclick: () => { if (modalidade === 'PROPRIO' && !responsavel.trim()) { aviso('Informe quem fará a retirada.', 'erro'); return; } passo = 4; desenhar(); } }, 'Continuar')));
    } else {
      montar(corpo, barra(), h('p', { class: 'suave' }, 'Passo 4 de 4 · Confirmar'),
        h('div', { class: 'ok' }, `${fmtKg(o.quantidadeKg)} de ${o.tipoAlimento}`, h('br'), modalidade === 'PROPRIO' ? `Retirada por ${responsavel}` : 'Retirada por transportador voluntário'),
        erro, h('div', { class: 'linha', style: 'margin-top:1rem' }, h('button', { class: 'botao sec', onclick: () => { passo = 3; desenhar(); } }, 'Voltar'),
          botao('Confirmar reserva', async () => {
            try {
              const r = await POST(`/api/ofertas/${o.id}/reservar`, { modalidade, responsavelRetirada: responsavel });
              m.fechar(); aviso('Reserva confirmada!', 'ok'); ir(`#/entrega/${r.coletaId}`);
            } catch (e) { montar(erro, erroBox(e)); aoConcluir?.(); }
          }, 'grande')));
    }
  }
  desenhar();
}

export async function reservas() {
  const { reservas: lista } = await GET('/api/reservas');
  return h('div', null, h('h1', null, 'Minhas reservas'),
    lista.length ? h('div', { class: 'grade' }, lista.map((r) => h('article', { class: 'cartao coluna' },
      h('div', { class: 'linha entre' }, h('h3', { style: 'margin:0' }, r.tipoAlimento), selo(r.estadoOferta)),
      h('p', { class: 'suave' }, `${r.estabelecimento} · ${fmtKg(r.quantidadeKg)}`),
      h('p', { class: 'pequeno' }, r.modalidade === 'PROPRIO' ? `Transporte próprio (${r.responsavelRetirada})` : 'Transportador voluntário', ` · reservada em ${fmtData(r.dataReserva)}`),
      h('div', { class: 'linha' }, h('a', { class: 'botao mini', href: `#/entrega/${r.coletaId}` }, 'Abrir entrega'),
        ['ENTREGUE', 'AVALIADA'].includes(r.estadoOferta) && !(r.avaliadaDoacao && r.avaliadaEntrega) ? h('a', { class: 'botao aviso mini', href: `#/entrega/${r.coletaId}` }, '★ Avaliar') : null)))) 
      : h('div', { class: 'cartao vazio' }, 'Você ainda não reservou doações.', h('br'), h('a', { class: 'botao', href: '#/' }, 'Ver ofertas')));
}
