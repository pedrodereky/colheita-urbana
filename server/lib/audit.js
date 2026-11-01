import { createHash } from 'node:crypto';
import { run, get, all } from '../db.js';
import { iso } from './clock.js';

// RF18 / RNF07 / UC37 - log imutável com encadeamento de hash (detecta adulteração)
export function registrar({ autorId = null, entidade, entidadeId = null, acao, de = null, para = null, justificativa = null }) {
  const ultimo = get('SELECT hash FROM logs_auditoria ORDER BY id DESC LIMIT 1');
  const ts = iso();
  entidadeId = entidadeId === null ? null : String(entidadeId);
  const base = JSON.stringify([ts, autorId, entidade, entidadeId, acao, de, para, justificativa, ultimo?.hash ?? '']);
  const hash = createHash('sha256').update(base).digest('hex');
  run(
    `INSERT INTO logs_auditoria (timestamp, autor_id, entidade, entidade_id, acao, estado_anterior, estado_novo, justificativa, hash_anterior, hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ts, autorId, entidade, entidadeId, acao, de, para, justificativa, ultimo?.hash ?? null, hash,
  );
}

export function verificarCadeia() {
  let anterior = null;
  for (const l of all('SELECT * FROM logs_auditoria ORDER BY id')) {
    const base = JSON.stringify([l.timestamp, l.autor_id, l.entidade, l.entidade_id, l.acao, l.estado_anterior, l.estado_novo, l.justificativa, anterior ?? '']);
    if (createHash('sha256').update(base).digest('hex') !== l.hash || (l.hash_anterior ?? null) !== anterior) return { integra: false, falhaEm: l.id };
    anterior = l.hash;
  }
  return { integra: true };
}

// Autor pseudonimizado: auditores veem o fluxo sem dados pessoais (RNF20)
export const pseudonimo = (autorId) => (autorId == null ? 'sistema' : 'U-' + createHash('sha256').update('aud' + autorId).digest('hex').slice(0, 8));
