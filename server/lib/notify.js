import { run, all, get } from '../db.js';
import { iso } from './clock.js';
import { publicar } from './events.js';
import { cifrar, indice } from './crypto.js';
import { config } from '../config.js';

// Serviço "Push / E-mail" (externo no diagrama de componentes). Em desenvolvimento a entrega
// é in-app (SSE) e e-mails ficam na tabela outbox_email; troque `entregarEmail` pelo provedor real.
function entregarEmail(emailIdx, emailEnc, assunto, corpo) {
  run('INSERT INTO outbox_email (para_idx, para_enc, assunto, corpo, criado_em) VALUES (?,?,?,?,?)', emailIdx, emailEnc, assunto, corpo, iso());
  if (!config.producao) console.log(`[email] ${assunto}`);
}

export function notificar(usuarioId, tipo, mensagem, { referencia = null, canal = 'PUSH' } = {}) {
  const r = run('INSERT INTO notificacoes (usuario_id, tipo, mensagem, canal, referencia, data_envio) VALUES (?,?,?,?,?,?)',
    usuarioId, tipo, mensagem, canal, referencia, iso());
  publicar(usuarioId, 'notificacao', { id: Number(r.lastInsertRowid), tipo, mensagem, referencia });
  return Number(r.lastInsertRowid);
}

export function notificarVarios(ids, tipo, mensagem, opcoes) {
  for (const id of new Set(ids)) notificar(id, tipo, mensagem, opcoes);
}

export function notificarGestores(tipo, mensagem, opcoes) {
  notificarVarios(all("SELECT id FROM usuarios WHERE tipo='GESTOR' AND status_cadastro='APROVADO'").map((u) => u.id), tipo, mensagem, opcoes);
}

export function enviarEmailPara(usuarioId, assunto, corpo) {
  const u = get('SELECT email_enc, email_idx FROM usuarios WHERE id=?', usuarioId);
  if (u) entregarEmail(u.email_idx, u.email_enc, assunto, corpo);
}

export function enviarEmailParaEndereco(email, assunto, corpo) {
  entregarEmail(indice(email), cifrar(email), assunto, corpo);
}
