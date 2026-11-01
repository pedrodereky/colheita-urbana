import { GET, POST } from '../api.js';
import { h, montar, limpar, aviso, botao, confirmar, modal, campo, selecao, entrada, lerArquivo, erroBox, selo, estrelas, fmtData, fmtKg, fmtNum, rotulo, carregando } from '../ui.js';
import { sessao, ouvir, aoSair, ir } from '../ctx.js';
import { criarMapa } from '../mapa.js';
import { arquivo, fotoOferta, rotuloConservacao } from './componentes.js';

const ETAPAS = [['RESERVADA', 'Reservada'], ['EM_COLETA', 'Em coleta'], ['EM_TRANSPORTE', 'Em transporte'], ['ENTREGUE', 'Entregue'], ['AVALIADA', 'Avaliada']];

export async function lista() {
  const { entregas } = await GET('/api/entregas');
  return h('div', null, h('h1', null, 'Entregas'),
    entregas.length ? h('div', { class: 'grade' }, entregas.map((e) => h('a', { class: 'cartao', href: `#/entrega/${e.id}`, style: 'text-decoration:none;color:inherit' },
      h('div', { class: 'linha entre' }, h('h3', { style: 'margin:0' }, e.tipoAlimento), selo(e.estado)),
      h('p', { class: 'suave' }, `${e.estabelecimento} → ${e.osc}`), h('p', { class: 'pequeno' }, `${fmtKg(e.quantidadeKg)} · ${e.modalidade === 'PROPRIO' ? 'transporte próprio' : 'voluntário'}`))))
      : h('div', { class: 'cartao vazio' }, 'Nenhuma entrega por aqui ainda.'));
}

export async function detalhe({ params }) {
  const id = Number(params.id);
  const raiz = h('div');
  let compartilhando = null; // watchId | intervalo de simulação
  let tratadores = [];       // ouvintes de eventos da versão atual da tela (recriados a cada desenho)
  let limpezaChat = () => {};
  aoSair(() => { pararCompartilhamento(); limpezaChat(); });
  ouvir((ev, d) => tratadores.forEach((fn) => fn(ev, d)));

  function pararCompartilhamento() {
    if (compartilhando?.watch != null) navigator.geolocation.clearWatch(compartilhando.watch);
    if (compartilhando?.timer) clearInterval(compartilhando.timer);
    compartilhando = null;
  }

  async function carregar() {
    const { entrega: e } = await GET(`/api/coletas/${id}`);
    desenhar(e);
  }

  function desenhar(e) {
    tratadores = []; limpezaChat();
    const ouvirLocal = (fn) => tratadores.push(fn);
    const mapa = criarMapa();
    const marcadorTransp = { ref: null };
    mapa.marcar(e.estabelecimento.latitude, e.estabelecimento.longitude, `Retirada: ${e.estabelecimento.nome}`, '#1b5e20');
    mapa.marcar(e.osc.latitude, e.osc.longitude, `Entrega: ${e.osc.nome}`, '#0d47a1');
    if (e.localizacao) mapa.marcar(e.localizacao.latitude, e.localizacao.longitude, 'Transportador', '#ef6c00');
    mapa.ajustar();

    const restante = h('div');
    const atualizarRestante = (min) => montar(restante, min != null ? h('div', { class: 'info', role: 'status' }, `⏱️ Chegada em cerca de ${min} min`) : null);
    atualizarRestante(e.tempoRestanteMin);

    ouvirLocal((ev, d) => {
      if (ev === 'entrega' && d.coletaId === id) carregar();
      if (ev === 'localizacao' && d.coletaId === id) {
        mapa.limpar(); mapa.marcar(e.estabelecimento.latitude, e.estabelecimento.longitude, `Retirada: ${e.estabelecimento.nome}`); mapa.marcar(e.osc.latitude, e.osc.longitude, `Entrega: ${e.osc.nome}`, '#0d47a1');
        mapa.marcar(d.latitude, d.longitude, 'Transportador', '#ef6c00'); mapa.ajustar();
        atualizarRestante(d.tempoRestanteMin); ultimaPosicao.textContent = `Última atualização: ${fmtData(d.atualizadoEm)}`;
      }
    });
    const ultimaPosicao = h('p', { class: 'pequeno suave' }, e.localizacao ? `Última atualização: ${fmtData(e.localizacao.atualizadoEm)}` : (e.chatAtivo && e.papel !== 'TRANSPORTADOR' ? 'Posição do transportador indisponível por enquanto.' : ''));

    // linha do tempo
    const idx = ETAPAS.findIndex(([k]) => k === e.estado);
    const terminal = ['RECUSADA', 'EXPIRADA', 'CANCELADA'].includes(e.estado);
    const etapas = terminal ? [...ETAPAS.slice(0, 3).map(([k, t]) => [k, t, 'feita']), [e.estado, rotulo(e.estado), 'ruim']]
      : ETAPAS.map(([k, t], i) => [k, t, i < idx ? 'feita' : i === idx ? 'atual feita' : '']);
    const tempo = h('div', { class: 'linha-tempo', role: 'list', 'aria-label': 'Etapas da entrega' }, etapas.map(([, t, c]) => h('div', { class: `etapa ${c}`, role: 'listitem' }, t)));

    const acoes = [];
    if (e.acoes.includes('REGISTRAR_COLETA')) acoes.push(botao('📦 Registrar coleta', async () => { await POST(`/api/coletas/${id}/registrar-coleta`); aviso('Coleta registrada. Boa viagem!', 'ok'); carregar(); }, 'grande'));
    if (e.acoes.includes('CONFIRMAR_RECEBIMENTO')) acoes.push(botao('✅ Confirmar recebimento', async () => {
      if (!(await confirmar('Confirmar recebimento?', 'Confira os alimentos antes. Após confirmar, o recibo será emitido.', 'Confirmar recebimento'))) return;
      await POST(`/api/coletas/${id}/confirmar-recebimento`); aviso('Recebimento confirmado. Recibo emitido!', 'ok'); carregar();
    }, 'grande'));
    if (e.acoes.includes('RECUSAR_ENTREGA')) acoes.push(botao('Recusar entrega', () => formRecusa(id, carregar), 'perigo'));
    if (e.acoes.includes('CANCELAR_RESERVA')) acoes.push(botao('Cancelar reserva', async () => {
      if (!(await confirmar('Cancelar a reserva?', 'A doação volta para a fila e sua OSC não poderá reservá-la novamente.', 'Cancelar reserva', true))) return;
      await POST(`/api/reservas/${e.reservaId}/cancelar`, { justificativa: 'Cancelada pela OSC' }); aviso('Reserva cancelada.'); ir('#/reservas');
    }, 'sec'));
    if (e.acoes.includes('REPORTAR_PROBLEMA')) acoes.push(botao('⚠️ Reportar problema', () => formProblema(id, carregar), 'aviso'));
    if (e.acoes.includes('DESISTIR')) acoes.push(botao('Desistir da coleta', async () => { if (await confirmar('Desistir da coleta?', 'Ela voltará a ser oferecida a outros voluntários.', 'Desistir', true)) { await POST(`/api/coletas/${id}/desistir`); aviso('Você desistiu da coleta.'); ir('#/'); } }, 'sec'));

    const rotaBox = h('div');
    if (e.acoes.includes('VER_ROTA')) acoes.push(botao('🧭 Ver melhor rota', async () => mostrarRota(id, e, mapa, rotaBox), 'sec'));

    const gps = h('div');
    if (e.acoes.includes('COMPARTILHAR_LOCALIZACAO')) {
      const alvo = e.statusColeta === 'ACEITA' ? e.estabelecimento : e.osc;
      const desenharGps = () => {
        montar(gps, h('div', { class: 'cartao coluna' }, h('h3', null, 'Compartilhar localização'),
          h('p', { class: 'suave pequeno' }, 'Só o estabelecimento e a OSC desta entrega veem sua posição, e apenas até o fim da entrega.'),
          compartilhando
            ? botao('⏹ Parar de compartilhar', () => { pararCompartilhamento(); desenharGps(); }, 'sec')
            : botao('📡 Começar a compartilhar', async () => {
              if (!navigator.geolocation) throw new Error('Seu aparelho não oferece localização.');
              await new Promise((ok, no) => navigator.geolocation.getCurrentPosition(ok, () => no(new Error('Permissão negada: o acompanhamento ficará indisponível.')), { enableHighAccuracy: true }));
              let ultimo = 0;
              compartilhando = { watch: navigator.geolocation.watchPosition(async (p) => {
                if (Date.now() - ultimo < 8000) return; ultimo = Date.now();
                try { await POST(`/api/coletas/${id}/localizacao`, { latitude: p.coords.latitude, longitude: p.coords.longitude, precisao: p.coords.accuracy }); } catch (err) { if (err.codigo === 'FORA_DE_ENTREGA') pararCompartilhamento(); }
              }, () => {}, { enableHighAccuracy: true }) };
              desenharGps();
            }),
          location.hostname === 'localhost' ? botao('🧪 Simular deslocamento (demonstração)', async () => {
            const pos = e.localizacao || { latitude: sessao.usuario.latitude, longitude: sessao.usuario.longitude };
            simulado.lat = simulado.lat ?? pos.latitude; simulado.lon = simulado.lon ?? pos.longitude;
            simulado.lat += (alvo.latitude - simulado.lat) * 0.25; simulado.lon += (alvo.longitude - simulado.lon) * 0.25;
            await POST(`/api/coletas/${id}/localizacao`, { latitude: simulado.lat, longitude: simulado.lon });
          }, 'sec mini') : null));
      };
      const simulado = {};
      desenharGps();
    }

    const proprio = e.modalidade === 'PROPRIO';
    const partes = h('div', { class: 'grade' },
      h('div', { class: 'cartao' }, h('h3', null, '🏪 Retirada'), h('b', null, e.estabelecimento.nome), e.estabelecimento.endereco ? h('p', { class: 'pequeno' }, e.estabelecimento.endereco) : h('p', { class: 'pequeno suave' }, 'Endereço liberado após aceitar a coleta.'), h('p', { class: 'pequeno' }, `Janela: ${fmtData(e.janelaInicio)} → ${fmtData(e.janelaFim)}`), e.horaColeta ? h('p', { class: 'pequeno' }, `Coletado em ${fmtData(e.horaColeta)}`) : null),
      h('div', { class: 'cartao' }, h('h3', null, '🤝 Entrega'), h('b', null, e.osc.nome), e.osc.endereco ? h('p', { class: 'pequeno' }, e.osc.endereco) : null, e.horaEntrega ? h('p', { class: 'pequeno' }, `Entregue em ${fmtData(e.horaEntrega)}`) : null),
      h('div', { class: 'cartao' }, h('h3', null, '🚚 Transporte'), proprio ? h('p', null, `Transporte próprio da OSC (${e.responsavelRetirada})`) : e.transportador ? h('p', null, h('b', null, e.transportador.nome), h('br'), e.transportador.veiculo) : h('p', { class: 'suave' }, 'Aguardando um voluntário aceitar.')));

    const ocorrencias = e.ocorrencias.length ? h('div', { class: 'cartao' }, h('h3', null, 'Problemas registrados'), e.ocorrencias.map((o) => h('div', { class: 'alerta' }, h('b', null, rotulo2(o.tipo)), ` · ${fmtData(o.dataHora)}`, h('br'), o.descricao, h('br'), h('a', { href: arquivo(o.evidencia), target: '_blank', rel: 'noopener' }, 'Ver evidência')))) : null;

    const recibo = e.recibo ? h('div', { class: 'ok' }, `Recibo ${e.recibo.numero} emitido. `, h('a', { class: 'botao mini', href: `/api/recibos/${e.recibo.id}/pdf` }, '⬇ Baixar PDF')) : null;
    const avaliar = e.acoes.includes('AVALIAR') ? blocoAvaliacao(e, carregar) : null;
    const chatCtl = e.papel !== 'GESTOR' ? blocoChat(id, e.chatAtivo, ouvirLocal) : null;
    const chat = chatCtl?.el; limpezaChat = chatCtl?.limpar || (() => {});

    montar(raiz,
      h('p', null, h('a', { href: '#/entregas' }, '← Entregas')),
      h('div', { class: 'linha entre' }, h('h1', { style: 'margin:0' }, e.tipoAlimento), selo(e.estado)),
      h('p', { class: 'suave' }, `${fmtKg(e.quantidadeKg)} · ${rotuloConservacao(e.conservacao)}`),
      tempo, restante, e.modalidade === 'PROPRIO' && e.papel === 'OSC' ? h('div', { class: 'info' }, 'Você escolheu transporte próprio: sua equipe registra a coleta e a entrega.') : null,
      mapa.el, ultimaPosicao, rotaBox,
      acoes.length ? h('div', { class: 'linha', style: 'margin:1rem 0' }, acoes) : null,
      gps, recibo, h('div', { style: 'height:8px' }), partes, ocorrencias, avaliar,
      chat ? h('div', null, h('h2', null, '💬 Chat da entrega'), chat) : null);
  }
  await carregar();
  return raiz;
}

const rotulo2 = (t) => ({ EMBALAGEM_VIOLADA: 'Embalagem violada', ENDERECO_INCORRETO: 'Endereço incorreto', AUSENCIA_DOADOR: 'Ausência do doador' })[t] || t;

async function mostrarRota(id, e, mapa, destino) {
  montar(destino, carregando());
  const pos = e.localizacao || { latitude: sessao.usuario.latitude, longitude: sessao.usuario.longitude };
  const r = await GET(`/api/coletas/${id}/rota?latitude=${pos.latitude}&longitude=${pos.longitude}`);
  if (r.rotaIndisponivel) {
    montar(destino, h('div', { class: 'alerta', role: 'alert' }, r.aviso, h('br'), `Retirada: ${r.enderecos.retirada}`, h('br'), `Entrega: ${r.enderecos.entrega}`)); return;
  }
  mapa.limpar();
  r.pontos.forEach((p, i) => mapa.marcar(p.latitude, p.longitude, p.rotulo, i === 0 ? '#ef6c00' : i === r.pontos.length - 1 ? '#0d47a1' : '#1b5e20'));
  r.trechos.forEach((t) => mapa.linha(t.caminho));
  mapa.ajustar();
  montar(destino, h('div', { class: 'info' }, `🧭 Rota sugerida: ${fmtNum(r.distanciaKm)} km · cerca de ${r.minutos} min`, h('br'), h('small', null, r.provedor === 'osrm' ? 'Rota calculada pelo serviço de mapas.' : 'Estimativa em linha reta (ative o provedor de mapas para rotas reais).'), h('br'), `Retirada: ${r.enderecos.retirada}`, h('br'), `Entrega: ${r.enderecos.entrega}`));
}

function formRecusa(id, aoConcluir) {
  const txt = h('textarea', { name: 'j', required: true, maxlength: 500, placeholder: 'Ex.: alimentos fora da temperatura, embalagens danificadas…' });
  const erro = h('div');
  const m = modal('Recusar entrega', h('div', null, h('p', { class: 'suave' }, 'A justificativa será enviada ao estabelecimento e ficará registrada. Doações recusadas não podem ser avaliadas.'), campo('Justificativa', txt), erro,
    h('div', { class: 'linha' }, botao('Recusar entrega', async () => {
      if (!txt.value.trim()) { montar(erro, erroBox(new Error('Informe a justificativa.'))); return; }
      try { await POST(`/api/coletas/${id}/recusar`, { justificativa: txt.value }); m.fechar(); aviso('Entrega recusada.'); aoConcluir(); } catch (e) { montar(erro, erroBox(e)); }
    }, 'perigo'))));
}

function formProblema(id, aoConcluir) {
  const tipo = selecao('tipo', [['EMBALAGEM_VIOLADA', 'Embalagem violada'], ['ENDERECO_INCORRETO', 'Endereço incorreto'], ['AUSENCIA_DOADOR', 'Ausência do doador']]);
  const desc = h('textarea', { required: true, maxlength: 1000, placeholder: 'Descreva o que aconteceu' });
  const arq = entrada('evidencia', { type: 'file', accept: 'image/*,video/mp4,video/webm', required: true });
  const erro = h('div');
  const m = modal('Reportar problema', h('div', null, campo('Tipo de problema', tipo), campo('Comentário', desc), campo('Foto ou vídeo (obrigatório)', arq, 'Evidência para a equipe de gestão. Até 10 MB.'), erro,
    botao('Enviar relato', async () => {
      try {
        if (!arq.files[0]) throw new Error('Anexe uma foto ou vídeo como evidência.');
        await POST(`/api/coletas/${id}/ocorrencias`, { tipo: tipo.value, descricao: desc.value, evidencia: await lerArquivo(arq.files[0]) });
        m.fechar(); aviso('Problema registrado. A equipe foi avisada.', 'ok'); aoConcluir();
      } catch (e) { montar(erro, erroBox(e)); }
    }, 'grande')));
}

function blocoAvaliacao(e, aoConcluir) {
  const caixa = h('div', { class: 'cartao' }, h('h2', { style: 'margin-top:0' }, '★ Avalie esta doação'));
  const bloco = (tipo, titulo, ajuda, feita) => {
    if (feita) return h('p', { class: 'ok' }, `${titulo}: avaliação enviada. Obrigado!`);
    const est = estrelas(0); const com = h('textarea', { maxlength: 1000, placeholder: 'Comentário (opcional)' });
    return h('div', { class: 'coluna', style: 'margin-bottom:1rem' }, h('b', null, titulo), h('span', { class: 'suave pequeno' }, ajuda), est, com,
      botao('Enviar avaliação', async () => {
        if (!est.valor()) throw new Error('Escolha de 1 a 5 estrelas.');
        await POST(`/api/reservas/${e.reservaId}/avaliar-${tipo}`, { nota: est.valor(), comentario: com.value }); aviso('Avaliação enviada. Obrigado!', 'ok'); aoConcluir();
      }, 'mini'));
  };
  caixa.append(bloco('doacao', 'Condição dos alimentos', 'Como estavam qualidade, validade e embalagem?', e.avaliacoes.doacao), bloco('entrega', 'Processo de entrega', 'Pontualidade e atendimento durante a retirada e entrega.', e.avaliacoes.entrega));
  return caixa;
}

function blocoChat(id, ativo, ouvirLocal) {
  const msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite', 'aria-label': 'Mensagens' });
  const pendentes = [];
  const desenharMsg = (m, pendente = false) => h('div', { class: `msg ${m.minha ? 'minha' : ''}`, style: pendente ? 'opacity:.6' : '' }, !m.minha ? h('small', null, m.autor) : null, m.texto, h('small', null, pendente ? 'enviando… (sem conexão)' : fmtData(m.dataEnvio)));
  const rolar = () => { msgs.scrollTop = msgs.scrollHeight; };
  const entradaMsg = h('input', { name: 'texto', maxlength: 1000, placeholder: ativo ? 'Escreva uma mensagem…' : 'Chat encerrado', disabled: !ativo, 'aria-label': 'Mensagem', autocomplete: 'off' });
  const enviarBtn = h('button', { class: 'botao', type: 'submit', disabled: !ativo }, 'Enviar');
  const form = h('form', null, entradaMsg, enviarBtn);

  async function enviar(texto) {
    try { const r = await POST(`/api/coletas/${id}/chat`, { texto }); msgs.append(desenharMsg(r.mensagem)); rolar(); return true; }
    catch (e) { if (e.codigo === 'OFFLINE') return false; aviso(e.message, 'erro'); return true; }
  }
  async function reenviar() {
    while (pendentes.length) { const p = pendentes[0]; if (!(await enviar(p.texto))) return; p.el.remove(); pendentes.shift(); }
  }
  window.addEventListener('online', reenviar);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const texto = entradaMsg.value.trim(); if (!texto) return;
    entradaMsg.value = '';
    if (!(await enviar(texto))) { const el = desenharMsg({ minha: true, texto }, true); msgs.append(el); pendentes.push({ texto, el }); rolar(); } // UC25 3a
  });
  ouvirLocal((ev, d) => { if (ev === 'chat' && d.coletaId === id) { msgs.append(desenharMsg({ ...d, minha: false })); rolar(); } });
  GET(`/api/coletas/${id}/chat`).then((r) => { r.mensagens.forEach((m) => msgs.append(desenharMsg(m))); if (!r.ativo) msgs.append(h('p', { class: 'vazio pequeno' }, 'O chat foi encerrado junto com a entrega.')); rolar(); }).catch((e) => msgs.append(erroBox(e)));
  return { el: h('div', { class: 'chat' }, msgs, form), limpar: () => window.removeEventListener('online', reenviar) };
}
