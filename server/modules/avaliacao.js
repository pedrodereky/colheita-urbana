import { route, HttpError } from '../lib/http.js';
import { run, get, all, tx } from '../db.js';
import { exigir } from '../lib/validators.js';
import { agora, iso } from '../lib/clock.js';
import { registrar } from '../lib/audit.js';
import { notificar } from '../lib/notify.js';
import { mudarEstadoOferta, ESTADOS_RECEBIDOS } from '../domain/estados.js';
import { R } from '../domain/regras.js';

// UC32 / RF21 / RN11 / RN27
export function concederReconhecimentos({ estabelecimentoId, transportadorId }) {
  if (estabelecimentoId) {
    const e = get('SELECT avaliacoes_positivas_seguidas AS n FROM estabelecimentos WHERE usuario_id=?', estabelecimentoId);
    if (e.n > R.avaliacoesPositivasParaSelo) conceder(estabelecimentoId, 'SELO', 'Parceiro Solidário', 'RN11');
  }
  if (transportadorId) {
    const t = get('SELECT entregas_concluidas AS n FROM transportadores WHERE usuario_id=?', transportadorId);
    if (t.n > R.entregasParaCertificado) conceder(transportadorId, 'CERTIFICADO', 'Certificado digital de reconhecimento: mais de 50 entregas', 'RN27');
  }
}
function conceder(usuarioId, tipo, descricao, criterio) {
  const r = run('INSERT OR IGNORE INTO reconhecimentos (usuario_id, tipo, descricao, criterio, data_emissao) VALUES (?,?,?,?,?)', usuarioId, tipo, descricao, criterio, iso());
  if (r.changes) {
    registrar({ entidade: 'reconhecimento', entidadeId: usuarioId, acao: 'CONCEDER', para: criterio });
    notificar(usuarioId, 'GERAL', `Você recebeu: ${descricao}!`);
  }
}

function reservaAvaliavel(reservaId, user) {
  const r = get(
    `SELECT r.id, r.osc_id, r.status, o.id AS oferta_id, o.estado, o.estabelecimento_id, c.transportador_id
     FROM reservas r JOIN ofertas o ON o.id=r.oferta_id JOIN coletas c ON c.reserva_id=r.id WHERE r.id=?`, reservaId);
  if (!r || r.osc_id !== user.id) throw new HttpError(404, 'Doação não encontrada.', 'NAO_ENCONTRADO');
  // RN07 - só após confirmar recebimento; recusadas não são avaliadas
  if (r.estado === 'RECUSADA') throw new HttpError(409, 'Doações recusadas não podem ser avaliadas (RN07).', 'DOACAO_RECUSADA');
  if (!ESTADOS_RECEBIDOS.includes(r.estado)) throw new HttpError(409, 'Confirme o recebimento antes de avaliar (RN07).', 'RECEBIMENTO_NAO_CONFIRMADO');
  return r;
}
function lerNota(body) {
  const nota = exigir.numero(body, 'nota', 'Nota', { min: 1, max: 5 });
  if (!Number.isInteger(nota)) throw new HttpError(400, 'A nota deve ser um número inteiro de 1 a 5.', 'NOTA_INVALIDA');
  return { nota, comentario: exigir.opcional(body, 'comentario', 1000) };
}

// UC29 / RF16
route('POST', '/api/reservas/:id/avaliar-doacao', { perfis: ['OSC'] }, ({ user, params, body }) => {
  const r = reservaAvaliavel(Number(params.id), user);
  const { nota, comentario } = lerNota(body);
  if (get("SELECT 1 FROM avaliacoes WHERE reserva_id=? AND tipo='DOACAO'", r.id)) throw new HttpError(409, 'Esta doação já foi avaliada.', 'JA_AVALIADA');
  tx(() => {
    run("INSERT INTO avaliacoes (reserva_id, osc_id, estabelecimento_id, transportador_id, tipo, nota, comentario, data) VALUES (?,?,?,?, 'DOACAO', ?,?,?)", r.id, user.id, r.estabelecimento_id, null, nota, comentario, iso());
    // RN11 - sequência de avaliações positivas (nota 4 ou 5) do estabelecimento
    if (nota >= 4) run('UPDATE estabelecimentos SET avaliacoes_positivas_seguidas = avaliacoes_positivas_seguidas + 1 WHERE usuario_id=?', r.estabelecimento_id);
    else run('UPDATE estabelecimentos SET avaliacoes_positivas_seguidas = 0 WHERE usuario_id=?', r.estabelecimento_id);
    run('UPDATE historico_doacoes SET nota=? WHERE reserva_id=?', nota, r.id);
    if (r.estado === 'ENTREGUE') mudarEstadoOferta(r.oferta_id, 'AVALIADA', { autorId: user.id });
    registrar({ autorId: user.id, entidade: 'avaliacao', entidadeId: r.id, acao: 'AVALIAR_DOACAO', para: String(nota) });
  });
  concederReconhecimentos({ estabelecimentoId: r.estabelecimento_id });
  if (nota <= 2) notificar(r.estabelecimento_id, 'GERAL', 'Você recebeu uma avaliação baixa na condição de uma doação.', { referencia: `reserva:${r.id}` });
});

// UC30 / RF17
route('POST', '/api/reservas/:id/avaliar-entrega', { perfis: ['OSC'] }, ({ user, params, body }) => {
  const r = reservaAvaliavel(Number(params.id), user);
  const { nota, comentario } = lerNota(body);
  if (get("SELECT 1 FROM avaliacoes WHERE reserva_id=? AND tipo='ENTREGA'", r.id)) throw new HttpError(409, 'A entrega já foi avaliada.', 'JA_AVALIADA');
  run("INSERT INTO avaliacoes (reserva_id, osc_id, estabelecimento_id, transportador_id, tipo, nota, comentario, data) VALUES (?,?,?,?, 'ENTREGA', ?,?,?)", r.id, user.id, r.estabelecimento_id, r.transportador_id, nota, comentario, iso());
  registrar({ autorId: user.id, entidade: 'avaliacao', entidadeId: r.id, acao: 'AVALIAR_ENTREGA', para: String(nota) });
});

// ---- Ranking (UC31 / RF20 / RN04 / RN21) ----
const media = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);

export function calcularRanking(tipo) {
  const desde = iso(new Date(agora().getTime() - R.janelaPenalidadeDias * 86400e3));
  const base = all("SELECT id, nome FROM usuarios WHERE tipo=? AND status_cadastro='APROVADO'", tipo);
  const linhas = [];
  for (const u of base) {
    let notasPrincipais, notasEntrega, doacoes, pontualidade = null, negativas;
    if (tipo === 'ESTABELECIMENTO') {
      notasPrincipais = all("SELECT nota FROM avaliacoes WHERE estabelecimento_id=? AND tipo='DOACAO'", u.id).map((x) => x.nota);
      notasEntrega = all("SELECT nota FROM avaliacoes WHERE estabelecimento_id=? AND tipo='ENTREGA'", u.id).map((x) => x.nota);
      doacoes = get("SELECT COUNT(*) AS n FROM historico_doacoes WHERE estabelecimento_id=? AND situacao='ENTREGUE'", u.id).n;
      negativas = get('SELECT COUNT(*) AS n FROM avaliacoes WHERE estabelecimento_id=? AND nota<=2 AND data>=?', u.id, desde).n;
    } else {
      notasEntrega = all("SELECT nota FROM avaliacoes WHERE transportador_id=? AND tipo='ENTREGA'", u.id).map((x) => x.nota);
      notasPrincipais = notasEntrega;
      doacoes = get("SELECT entregas_concluidas AS n FROM transportadores WHERE usuario_id=?", u.id).n;
      const pontos = all("SELECT hora_entrega, previsao_chegada FROM coletas WHERE transportador_id=? AND status='CONCLUIDA' AND previsao_chegada IS NOT NULL", u.id);
      if (pontos.length) pontualidade = (pontos.filter((c) => new Date(c.hora_entrega) <= new Date(new Date(c.previsao_chegada).getTime() + 15 * 60e3)).length / pontos.length) * 100;
      negativas = get('SELECT COUNT(*) AS n FROM avaliacoes WHERE transportador_id=? AND nota<=2 AND data>=?', u.id, desde).n;
    }
    if (!notasPrincipais.length && !notasEntrega.length) continue;
    const mediaPrincipal = media(notasPrincipais) ?? media(notasEntrega);
    const mediaEntrega = media(notasEntrega);
    const pontPct = pontualidade ?? (mediaEntrega != null ? (mediaEntrega / 5) * 100 : 0);
    const penalizado = negativas >= R.avaliacoesNegativasParaPenalidade; // RN04
    const pontuacao = 40 * (mediaPrincipal / 5) + 30 * (Math.min(doacoes, 50) / 50) + 30 * (pontPct / 100) - (penalizado ? 20 : 0);
    linhas.push({
      id: u.id, nome: u.nome, doacoes, mediaNota: Math.round(mediaPrincipal * 100) / 100, pontualidade: Math.round(pontPct), penalizado,
      pontuacao: Math.round(Math.max(0, pontuacao) * 10) / 10,
      reconhecimentos: all('SELECT tipo, descricao FROM reconhecimentos WHERE usuario_id=?', u.id),
    });
  }
  linhas.sort((a, b) => b.pontuacao - a.pontuacao || b.doacoes - a.doacoes);
  return linhas.map((l, i) => ({ posicao: i + 1, ...l }));
}

route('GET', '/api/ranking', ({ query }) => {
  const tipo = query.tipo === 'TRANSPORTADOR' ? 'TRANSPORTADOR' : 'ESTABELECIMENTO';
  const ranking = calcularRanking(tipo);
  return {
    tipo, disponivel: ranking.length > 0, ranking,
    criterios: 'Pontuação (0–100) = 40% média das notas + 30% quantidade de doações (até 50) + 30% pontualidade. Três ou mais avaliações 1–2 em 30 dias reduzem 20 pontos.',
  };
});
