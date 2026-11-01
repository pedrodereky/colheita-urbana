import { route, HttpError, enviarBuffer, json } from '../lib/http.js';
import { run, get, all } from '../db.js';
import { agora, iso } from '../lib/clock.js';
import { gerarCsv } from '../lib/csv.js';
import { gerarPdf } from '../lib/pdf.js';
import { pseudonimo, verificarCadeia } from '../lib/audit.js';
import { R } from '../domain/regras.js';

const G = { perfis: ['GESTOR'] };

function periodo(query) {
  const fim = query.ate ? new Date(new Date(query.ate).getTime() + 86400e3 - 1) : agora();
  const ini = query.de ? new Date(query.de) : new Date(fim.getTime() - 30 * 86400e3);
  if (Number.isNaN(ini.getTime()) || Number.isNaN(fim.getTime())) throw new HttpError(400, 'Período inválido.', 'PERIODO_INVALIDO');
  return { de: iso(ini), ate: iso(fim), rotulo: `${ini.toISOString().slice(0, 10)} a ${fim.toISOString().slice(0, 10)}` };
}

// UC38 / RF19 - indicadores de negócio
export function calcularIndicadores(de, ate) {
  const kg = get("SELECT COALESCE(SUM(quantidade_kg),0) AS kg, COUNT(*) AS n FROM historico_doacoes WHERE situacao='ENTREGUE' AND data_conclusao BETWEEN ? AND ?", de, ate);
  const ofertas = get('SELECT COUNT(*) AS total, SUM(CASE WHEN estado=\'EXPIRADA\' THEN 1 ELSE 0 END) AS exp FROM ofertas WHERE criado_em BETWEEN ? AND ?', de, ate);
  const distribuicao = all(
    `SELECT u.nome AS osc, SUM(h.quantidade_kg) AS kg, COUNT(*) AS doacoes FROM historico_doacoes h JOIN usuarios u ON u.id=h.osc_id
     WHERE h.situacao='ENTREGUE' AND h.data_conclusao BETWEEN ? AND ? GROUP BY h.osc_id ORDER BY kg DESC`, de, ate);
  return {
    quilosResgatados: Math.round(kg.kg * 10) / 10,
    refeicoesEquivalentes: Math.round(kg.kg / R.kgPorRefeicao),
    doacoesConcluidas: kg.n,
    ofertasPublicadas: ofertas.total,
    ofertasExpiradas: ofertas.exp || 0,
    taxaOfertasExpiradas: ofertas.total ? Math.round(((ofertas.exp || 0) / ofertas.total) * 1000) / 10 : 0,
    distribuicaoPorOsc: distribuicao.map((d) => ({ osc: d.osc, kg: Math.round(d.kg * 10) / 10, doacoes: d.doacoes })),
  };
}

// UC39 / RF35
route('GET', '/api/gestor/painel', G, ({ query }) => {
  const p = periodo(query);
  const ind = calcularIndicadores(p.de, p.ate);
  run('INSERT INTO indicadores (periodo, dados, calculado_em) VALUES (?,?,?) ON CONFLICT(periodo) DO UPDATE SET dados=excluded.dados, calculado_em=excluded.calculado_em', `${p.de}|${p.ate}`, JSON.stringify(ind), iso());
  const porEstado = Object.fromEntries(all('SELECT estado, COUNT(*) AS n FROM ofertas GROUP BY estado').map((r) => [r.estado, r.n]));
  return {
    periodo: p, indicadores: ind,
    situacao: {
      ofertasPorEstado: porEstado,
      entregasEmAndamento: get("SELECT COUNT(*) AS n FROM ofertas WHERE estado IN ('EM_COLETA','EM_TRANSPORTE')").n,
      aguardandoTransportador: get("SELECT COUNT(*) AS n FROM coletas WHERE status='PENDENTE'").n,
      cadastrosPendentes: get("SELECT COUNT(*) AS n FROM usuarios WHERE status_cadastro='PENDENTE' AND tipo<>'GESTOR'").n,
      chamadosAbertos: get("SELECT COUNT(*) AS n FROM chamados WHERE status IN ('ABERTO','EM_ATENDIMENTO')").n,
      feedbacksNovos: get("SELECT COUNT(*) AS n FROM feedbacks_anonimos WHERE status='NOVO'").n,
      validadeCritica: get("SELECT COUNT(*) AS n FROM ofertas WHERE estado='DISPONIVEL' AND validade<=?", iso(new Date(agora().getTime() + R.validadeCriticaHoras * 3600e3))).n,
    },
  };
});

// UC40 / RNF11 - exportação sem dados pessoais
route('GET', '/api/gestor/relatorio', G, ({ query, res }) => {
  const p = periodo(query);
  const ind = calcularIndicadores(p.de, p.ate);
  const formato = query.formato === 'pdf' ? 'pdf' : 'csv';
  try {
    if (formato === 'csv') {
      const linhas = [
        ['Período', p.rotulo], ['Quilos resgatados', ind.quilosResgatados], ['Refeições equivalentes', ind.refeicoesEquivalentes],
        ['Doações concluídas', ind.doacoesConcluidas], ['Ofertas publicadas', ind.ofertasPublicadas], ['Ofertas expiradas', ind.ofertasExpiradas],
        ['Taxa de ofertas expiradas (%)', ind.taxaOfertasExpiradas], [], ['OSC', 'Kg recebidos', 'Doações'],
        ...ind.distribuicaoPorOsc.map((d) => [d.osc, d.kg, d.doacoes]),
      ];
      return enviarBuffer(res, Buffer.from(gerarCsv(['Indicador', 'Valor'], linhas), 'utf8'), 'text/csv; charset=utf-8', 'relatorio-colheita-urbana.csv');
    }
    const pdf = gerarPdf({
      titulo: 'Colheita Urbana - Relatorio de indicadores',
      linhas: [
        `Periodo: ${p.rotulo}`, '', `Quilos resgatados: ${ind.quilosResgatados} kg`, `Refeicoes equivalentes: ${ind.refeicoesEquivalentes}`,
        `Doacoes concluidas: ${ind.doacoesConcluidas}`, `Ofertas publicadas: ${ind.ofertasPublicadas}`,
        `Ofertas expiradas sem retirada: ${ind.ofertasExpiradas} (${ind.taxaOfertasExpiradas}%)`, '', 'Distribuicao por OSC:',
        ...ind.distribuicaoPorOsc.map((d) => `  ${d.osc}: ${d.kg} kg em ${d.doacoes} doacao(oes)`),
      ].map((l) => l.normalize('NFC')),
    });
    return enviarBuffer(res, pdf, 'application/pdf', 'relatorio-colheita-urbana.pdf');
  } catch {
    json(res, 500, { erro: 'Falha ao gerar o relatório. Tente novamente.', codigo: 'FALHA_RELATORIO' }); // UC40 3a
  }
});

// UC37 / RNF20 - consulta da trilha de auditoria com autores pseudonimizados
route('GET', '/api/gestor/auditoria', G, ({ query }) => {
  const cond = ['1=1'], p = [];
  if (query.entidade) { cond.push('entidade=?'); p.push(query.entidade); }
  if (query.entidadeId) { cond.push('entidade_id=?'); p.push(String(query.entidadeId)); }
  if (query.acao) { cond.push('acao=?'); p.push(query.acao); }
  const limite = Math.min(Number(query.limite) || 100, 500);
  const logs = all(`SELECT * FROM logs_auditoria WHERE ${cond.join(' AND ')} ORDER BY id DESC LIMIT ${limite}`, ...p);
  return {
    logs: logs.map((l) => ({ id: l.id, timestamp: l.timestamp, autor: pseudonimo(l.autor_id), entidade: l.entidade, entidadeId: l.entidade_id, acao: l.acao, de: l.estado_anterior, para: l.estado_novo, justificativa: l.justificativa })),
    integridade: query.verificar ? verificarCadeia() : undefined,
  };
});
