// Rotas só de desenvolvimento: caixa de saída de e-mails (links de recuperação de senha etc.)
import { route } from './lib/http.js';
import { all } from './db.js';
import { decifrar } from './lib/crypto.js';

export function listarOutbox() {
  route('GET', '/api/dev/emails', { publica: true }, () => ({
    emails: all('SELECT id, para_enc, assunto, corpo, criado_em FROM outbox_email ORDER BY id DESC LIMIT 20').map((e) => ({ id: e.id, para: decifrar(e.para_enc), assunto: e.assunto, corpo: e.corpo, criadoEm: e.criado_em })),
  }));
}
