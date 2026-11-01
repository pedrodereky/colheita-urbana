// Cria um gestor (uso em produção, onde o seed de demonstração não deve rodar).
//   GESTOR_SENHA='...' node server/criar-gestor.js "Nome Completo" email@dominio.com
import { run, get } from './db.js';
import { cifrar, indice, hashSenha } from './lib/crypto.js';
import { senhaForte, emailValido } from './lib/validators.js';
import { iso } from './lib/clock.js';

const [nome, email] = process.argv.slice(2);
const senha = process.env.GESTOR_SENHA;
if (!nome || !emailValido(email) || !senhaForte(senha)) {
  console.error('Uso: GESTOR_SENHA=<mín. 8, letras e números> node server/criar-gestor.js "Nome" email@dominio.com');
  process.exit(1);
}
if (get('SELECT 1 FROM usuarios WHERE email_idx=?', indice(email))) { console.error('Já existe um usuário com este e-mail.'); process.exit(1); }
const r = run(
  `INSERT INTO usuarios (tipo, nome, email_enc, email_idx, senha_hash, status_cadastro, termos_aceitos, termos_em, criado_em) VALUES ('GESTOR',?,?,?,?, 'APROVADO',1,?,?)`,
  nome, cifrar(email.toLowerCase()), indice(email), hashSenha(senha), iso(), iso());
run('INSERT INTO gestores (usuario_id) VALUES (?)', Number(r.lastInsertRowid));
console.log(`Gestor criado: ${email}`);
