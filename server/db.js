import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const limpar = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

export const run = (sql, ...p) => stmt(sql).run(...limpar(p));
export const get = (sql, ...p) => stmt(sql).get(...limpar(p));
export const all = (sql, ...p) => stmt(sql).all(...limpar(p));

// Transação síncrona (o acesso ao SQLite é síncrono; não há intercalação dentro de fn)
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('ESTABELECIMENTO','OSC','TRANSPORTADOR','GESTOR')),
  nome TEXT NOT NULL,
  email_enc TEXT NOT NULL,
  email_idx TEXT NOT NULL UNIQUE,
  telefone_enc TEXT,
  endereco_enc TEXT,
  latitude REAL, longitude REAL,
  senha_hash TEXT NOT NULL,
  status_cadastro TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status_cadastro IN ('PENDENTE','APROVADO','REJEITADO','SUSPENSO')),
  motivo_status TEXT,
  termos_aceitos INTEGER NOT NULL DEFAULT 0,
  termos_em TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_usuarios_tipo_status ON usuarios(tipo, status_cadastro);

CREATE TABLE IF NOT EXISTS estabelecimentos (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
  cnpj_enc TEXT NOT NULL, cnpj_idx TEXT NOT NULL UNIQUE,
  ramo TEXT,
  avaliacoes_positivas_seguidas INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inconsistencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estabelecimento_id INTEGER NOT NULL REFERENCES estabelecimentos(usuario_id),
  reserva_id INTEGER, motivo TEXT, criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oscs (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
  cnpj_enc TEXT NOT NULL, cnpj_idx TEXT NOT NULL UNIQUE,
  capacidade_refrigerada_kg REAL NOT NULL DEFAULT 0,
  capacidade_seca_kg REAL NOT NULL DEFAULT 0,
  validade_documentacao TEXT NOT NULL,
  comprovante TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transportadores (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
  cpf_enc TEXT NOT NULL, cpf_idx TEXT NOT NULL UNIQUE,
  tipo_veiculo TEXT NOT NULL,
  disponibilidade TEXT,
  faltas_consecutivas INTEGER NOT NULL DEFAULT 0,
  entregas_concluidas INTEGER NOT NULL DEFAULT 0,
  suspenso_ate TEXT
);
CREATE TABLE IF NOT EXISTS gestores (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),
  matricula TEXT
);
CREATE TABLE IF NOT EXISTS cnpjs_irregulares (cnpj_idx TEXT PRIMARY KEY, motivo TEXT);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  expira_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens_recuperacao (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  token_hash TEXT NOT NULL UNIQUE,
  expira_em TEXT NOT NULL,
  utilizado INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ofertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  estabelecimento_id INTEGER NOT NULL REFERENCES estabelecimentos(usuario_id),
  tipo_alimento TEXT NOT NULL,
  categoria TEXT NOT NULL,
  quantidade_kg REAL NOT NULL,
  validade TEXT NOT NULL,
  conservacao TEXT NOT NULL CHECK (conservacao IN ('AMBIENTE','REFRIGERADO','CONGELADO')),
  janela_inicio TEXT NOT NULL,
  janela_fim TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'DISPONIVEL',
  origem_oferta_id INTEGER,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ofertas_estado ON ofertas(estado, validade);
CREATE INDEX IF NOT EXISTS ix_ofertas_estab ON ofertas(estabelecimento_id, criado_em);
CREATE TABLE IF NOT EXISTS imagens_oferta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oferta_id INTEGER NOT NULL REFERENCES ofertas(id),
  arquivo TEXT NOT NULL, enviado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oferta_id INTEGER NOT NULL REFERENCES ofertas(id),
  osc_id INTEGER NOT NULL REFERENCES oscs(usuario_id),
  modalidade TEXT NOT NULL CHECK (modalidade IN ('VOLUNTARIO','PROPRIO')),
  responsavel_retirada TEXT,
  status TEXT NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA','CONCLUIDA','RECUSADA','CANCELADA','EXPIRADA')),
  quantidade_kg REAL NOT NULL,
  data_reserva TEXT NOT NULL,
  UNIQUE (oferta_id, osc_id)               -- RN19
);
CREATE INDEX IF NOT EXISTS ix_reservas_osc ON reservas(osc_id, status);
CREATE TABLE IF NOT EXISTS coletas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id INTEGER NOT NULL UNIQUE REFERENCES reservas(id),
  transportador_id INTEGER REFERENCES transportadores(usuario_id),
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE','ACEITA','EM_TRANSPORTE','CONCLUIDA','RECUSADA','CANCELADA')),
  aceita_em TEXT, hora_coleta TEXT, hora_entrega TEXT,
  rota_sugerida TEXT, distancia_km REAL, previsao_chegada TEXT
);
CREATE INDEX IF NOT EXISTS ix_coletas_transp ON coletas(transportador_id, status);
CREATE TABLE IF NOT EXISTS ocorrencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coleta_id INTEGER NOT NULL REFERENCES coletas(id),
  autor_id INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('EMBALAGEM_VIOLADA','ENDERECO_INCORRETO','AUSENCIA_DOADOR')),
  descricao TEXT NOT NULL, evidencia TEXT NOT NULL, data_hora TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS localizacoes (
  coleta_id INTEGER PRIMARY KEY REFERENCES coletas(id),
  latitude REAL NOT NULL, longitude REAL NOT NULL, precisao_metros REAL, atualizado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mensagens_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coleta_id INTEGER NOT NULL REFERENCES coletas(id),
  autor_id INTEGER NOT NULL REFERENCES usuarios(id),
  texto TEXT NOT NULL, data_envio TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_chat ON mensagens_chat(coleta_id, id);

CREATE TABLE IF NOT EXISTS avaliacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id INTEGER NOT NULL REFERENCES reservas(id),
  osc_id INTEGER NOT NULL,
  estabelecimento_id INTEGER NOT NULL,
  transportador_id INTEGER,
  tipo TEXT NOT NULL CHECK (tipo IN ('DOACAO','ENTREGA')),
  nota INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
  comentario TEXT, data TEXT NOT NULL,
  UNIQUE (reserva_id, tipo)
);
CREATE INDEX IF NOT EXISTS ix_aval_estab ON avaliacoes(estabelecimento_id, data);
CREATE INDEX IF NOT EXISTS ix_aval_transp ON avaliacoes(transportador_id, data);
CREATE TABLE IF NOT EXISTS recibos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id INTEGER NOT NULL UNIQUE REFERENCES reservas(id),
  numero TEXT NOT NULL UNIQUE, codigo_verificacao TEXT NOT NULL UNIQUE,
  data_emissao TEXT NOT NULL, quantidade_kg REAL NOT NULL, tipo_alimento TEXT NOT NULL,
  estabelecimento_id INTEGER NOT NULL, osc_id INTEGER NOT NULL, dados TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS historico_doacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reserva_id INTEGER NOT NULL UNIQUE REFERENCES reservas(id),
  osc_id INTEGER NOT NULL, estabelecimento_id INTEGER NOT NULL,
  data_conclusao TEXT NOT NULL, categoria TEXT NOT NULL, tipo_alimento TEXT NOT NULL,
  quantidade_kg REAL NOT NULL, situacao TEXT NOT NULL, nota INTEGER
);
CREATE INDEX IF NOT EXISTS ix_hist_osc ON historico_doacoes(osc_id, data_conclusao);
CREATE TABLE IF NOT EXISTS reconhecimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('SELO','CERTIFICADO')),
  descricao TEXT NOT NULL, criterio TEXT NOT NULL, data_emissao TEXT NOT NULL,
  UNIQUE (usuario_id, criterio)
);

CREATE TABLE IF NOT EXISTS notificacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  tipo TEXT NOT NULL, mensagem TEXT NOT NULL, canal TEXT NOT NULL DEFAULT 'PUSH',
  referencia TEXT, data_envio TEXT NOT NULL, lida INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_notif ON notificacoes(usuario_id, lida, id);
CREATE TABLE IF NOT EXISTS outbox_email (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  para_idx TEXT, para_enc TEXT, assunto TEXT NOT NULL, corpo TEXT NOT NULL, criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alertas_validade (oferta_id INTEGER PRIMARY KEY, enviado_em TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS chamados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocolo TEXT NOT NULL UNIQUE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  categoria TEXT NOT NULL, assunto TEXT NOT NULL, descricao TEXT NOT NULL, anexo TEXT,
  status TEXT NOT NULL DEFAULT 'ABERTO' CHECK (status IN ('ABERTO','EM_ATENDIMENTO','RESOLVIDO','FECHADO')),
  aberto_em TEXT NOT NULL, atualizado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chamado_mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id INTEGER NOT NULL REFERENCES chamados(id),
  autor_id INTEGER NOT NULL, texto TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pesquisas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL, periodo_inicio TEXT NOT NULL, periodo_fim TEXT NOT NULL,
  perguntas TEXT NOT NULL, ativa INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS respostas_pesquisa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pesquisa_id INTEGER NOT NULL REFERENCES pesquisas(id),
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  nota_geral INTEGER NOT NULL, respostas TEXT, comentario TEXT, data_resposta TEXT NOT NULL,
  UNIQUE (pesquisa_id, usuario_id)
);
-- RN31: sem usuario_id, sem IP, só a data (não o horário) para evitar correlação
CREATE TABLE IF NOT EXISTS feedbacks_anonimos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL CHECK (tipo IN ('SUGESTAO','DENUNCIA')),
  texto TEXT NOT NULL, anexo TEXT, data_envio TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOVO' CHECK (status IN ('NOVO','EM_ANALISE','RESOLVIDO')),
  providencia TEXT
);

CREATE TABLE IF NOT EXISTS logs_auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  autor_id INTEGER,
  entidade TEXT NOT NULL, entidade_id TEXT,
  acao TEXT NOT NULL,
  estado_anterior TEXT, estado_novo TEXT, justificativa TEXT,
  hash_anterior TEXT, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_log_ent ON logs_auditoria(entidade, entidade_id);
-- RF18 / RNF07: logs imutáveis
CREATE TRIGGER IF NOT EXISTS logs_sem_update BEFORE UPDATE ON logs_auditoria
BEGIN SELECT RAISE(ABORT, 'logs de auditoria são imutáveis'); END;
CREATE TRIGGER IF NOT EXISTS logs_sem_delete BEFORE DELETE ON logs_auditoria
BEGIN SELECT RAISE(ABORT, 'logs de auditoria são imutáveis'); END;

CREATE TABLE IF NOT EXISTS indicadores (
  periodo TEXT PRIMARY KEY, dados TEXT NOT NULL, calculado_em TEXT NOT NULL, relatorio_enviado INTEGER NOT NULL DEFAULT 0
);
`);
