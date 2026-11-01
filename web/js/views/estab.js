import { GET, POST } from '../api.js';
import { h, montar, campo, entrada, selecao, lerArquivo, aviso, botao, confirmar, erroBox, paraInputLocal, deInputLocal, selo, fmtKg, carregando } from '../ui.js';
import { ouvir, ir } from '../ctx.js';
import { cartaoOferta, CATEGORIAS, CONSERVACOES, arquivo } from './componentes.js';

export async function minhasOfertas() {
  const lista = h('div', { class: 'grade' });
  const resumo = h('div');
  async function carregar() {
    const { ofertas } = await GET('/api/ofertas/minhas');
    montar(lista, ofertas.length ? ofertas.map((o) => cartaoOferta(o, {
      extra: o.reserva ? [h('div', { class: 'info' }, `Reservada por ${o.reserva.osc} (${o.reserva.modalidade === 'PROPRIO' ? 'transporte próprio' : 'transportador voluntário'})`)] : [],
      acoes: [
        o.estado === 'DISPONIVEL' ? botao('Cancelar oferta', async () => { if (await confirmar('Cancelar oferta?', 'A oferta sai da lista das OSCs. Isso não pode ser desfeito.', 'Cancelar oferta', true)) { await POST(`/api/ofertas/${o.id}/cancelar`); aviso('Oferta cancelada.', 'ok'); carregar(); } }, 'sec mini') : null,
        o.reserva?.coletaId ? h('a', { class: 'botao mini', href: `#/entrega/${o.reserva.coletaId}` }, 'Acompanhar entrega') : null,
        h('a', { class: 'botao sec mini', href: `#/ofertas/nova?repetir=${o.id}` }, '↻ Repetir'),
      ],
    })) : h('div', { class: 'cartao vazio' }, h('p', null, 'Você ainda não publicou ofertas.'), h('a', { class: 'botao', href: '#/ofertas/nova' }, 'Publicar primeira oferta')));
    const cont = (e) => ofertas.filter((o) => e.includes(o.estado)).length;
    montar(resumo, h('div', { class: 'metricas' },
      h('div', { class: 'metrica' }, h('b', null, cont(['DISPONIVEL'])), 'disponíveis'), h('div', { class: 'metrica' }, h('b', null, cont(['RESERVADA', 'EM_COLETA', 'EM_TRANSPORTE'])), 'em andamento'),
      h('div', { class: 'metrica' }, h('b', null, cont(['ENTREGUE', 'AVALIADA'])), 'entregues'), h('div', { class: 'metrica' }, h('b', null, cont(['EXPIRADA', 'CANCELADA', 'RECUSADA'])), 'encerradas sem entrega')));
  }
  await carregar();
  ouvir((ev) => { if (ev === 'entrega' || ev === 'notificacao') carregar(); });
  return h('div', null, h('div', { class: 'linha entre' }, h('h1', null, 'Minhas ofertas'), h('a', { class: 'botao', href: '#/ofertas/nova' }, '+ Nova oferta')), resumo, h('div', { style: 'height:12px' }), lista);
}

export async function novaOferta({ query }) {
  const agora = new Date();
  let modelo = null;
  if (query.repetir) { try { modelo = (await GET(`/api/ofertas/${query.repetir}/modelo`)).modelo; } catch (e) { aviso(e.message, 'erro'); } }
  const fotos = []; // data URLs novas
  const previa = h('div', { class: 'preview-fotos' });
  if (modelo?.imagens?.length) modelo.imagens.forEach((n) => previa.append(h('img', { src: arquivo(n), alt: 'Foto da oferta anterior' })));
  const erro = h('div');
  const aviso36 = h('div', { class: 'dica' });

  const f = {
    tipo: entrada('tipoAlimento', { required: true, value: modelo?.tipoAlimento || '', placeholder: 'Ex.: Pão francês, frutas variadas…', maxlength: 120 }),
    cat: selecao('categoria', CATEGORIAS.map((c) => [c, c]), modelo?.categoria),
    qtd: entrada('quantidade', { type: 'number', min: 0, step: 'any', required: true, value: modelo?.quantidade ?? '' }),
    un: selecao('unidade', [['kg', 'quilos (kg)'], ['g', 'gramas (g)'], ['t', 'toneladas (t)'], ['l', 'litros (l)'], ['ml', 'mililitros (ml)']]),
    cons: selecao('conservacao', CONSERVACOES, modelo?.conservacao),
    val: entrada('validade', { type: 'datetime-local', required: true, value: paraInputLocal(new Date(agora.getTime() + 60 * 3600e3)) }),
    ini: entrada('janelaInicio', { type: 'datetime-local', required: true, value: paraInputLocal(agora) }),
    fim: entrada('janelaFim', { type: 'datetime-local', required: true, value: paraInputLocal(new Date(agora.getTime() + 8 * 3600e3)) }),
    fotos: entrada('fotos', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true }),
  };
  const checar = () => {
    const horas = (new Date(f.val.value) - Date.now()) / 3600e3;
    aviso36.textContent = Number.isFinite(horas) ? (horas < 36 ? '⚠️ A validade restante precisa ser de pelo menos 36 horas.' : `Faltam ${Math.round(horas)} h para vencer.`) : '';
  };
  f.val.addEventListener('input', checar); checar();
  f.fotos.addEventListener('change', async () => {
    for (const a of f.fotos.files) {
      if (a.size > 4 * 1024 * 1024) { aviso(`"${a.name}" passa de 4 MB e foi ignorada.`, 'erro'); continue; }
      const url = await lerArquivo(a); fotos.push(url); previa.append(h('img', { src: url, alt: `Foto nova: ${a.name}` }));
    }
    f.fotos.value = '';
  });

  const form = h('form', { class: 'cartao', novalidate: true },
    modelo ? h('div', { class: 'info' }, 'Dados copiados da oferta anterior. Informe a nova validade e a nova janela de retirada.') : null,
    h('div', { class: 'form-grade' }, campo('O que será doado', f.tipo), campo('Categoria', f.cat)),
    h('div', { class: 'form-grade' }, campo('Quantidade', f.qtd, 'Mínimo de 1 kg (ou equivalente).'), campo('Unidade', f.un)),
    h('div', { class: 'form-grade' }, campo('Condição de conservação', f.cons), campo('Data e hora de validade', f.val, 'Mínimo de 36 horas até o vencimento.')),
    aviso36,
    h('h2', null, 'Janela de retirada'), h('p', { class: 'suave' }, 'Período em que o transportador pode retirar a doação no seu estabelecimento. Deve terminar antes do vencimento.'),
    h('div', { class: 'form-grade' }, campo('Início', f.ini), campo('Fim', f.fim)),
    campo('Fotos (opcional)', f.fotos, 'Até 5 imagens de até 4 MB.'), previa, erro,
    h('div', { class: 'linha' }, h('button', { class: 'botao grande', type: 'submit', style: 'flex:1' }, 'Publicar oferta')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true; montar(erro);
    try {
      const r = await POST('/api/ofertas', {
        tipoAlimento: f.tipo.value, categoria: f.cat.value, quantidade: Number(f.qtd.value), unidade: f.un.value, conservacao: f.cons.value,
        validade: deInputLocal(f.val.value), janelaInicio: deInputLocal(f.ini.value), janelaFim: deInputLocal(f.fim.value),
        imagens: fotos, reutilizarImagensDe: modelo?.origemOfertaId, origemOfertaId: modelo?.origemOfertaId,
      });
      aviso(r.oscsNotificadas ? `Oferta publicada! ${r.oscsNotificadas} OSC(s) próxima(s) foram avisadas.` : 'Oferta publicada!', 'ok');
      ir('#/');
    } catch (e) { montar(erro, erroBox(e)); } finally { btn.disabled = false; }
  });
  return h('div', null, h('h1', null, modelo ? 'Repetir oferta' : 'Nova oferta'), form);
}
