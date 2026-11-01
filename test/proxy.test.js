import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cu-proxy-'));
Object.assign(process.env, { DATA_DIR: dir, NODE_ENV: 'test', PROXY_SECRET: 's3gredo-de-teste', TRUST_PROXY: '1' });
const { criarServidor } = await import('../server/app.js');
const { onRequest } = await import('../functions/api/[[path]].js');
const { onRequest: health } = await import('../functions/healthz.js');
const { run } = await import('../server/db.js');
const { cifrar, indice, hashSenha } = await import('../server/lib/crypto.js');

const servidor = criarServidor();
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
const backend = `http://127.0.0.1:${servidor.address().port}`;
after(() => { servidor.close(); servidor.closeAllConnections?.(); rmSync(dir, { recursive: true, force: true }); });

run(`INSERT INTO usuarios (tipo,nome,email_enc,email_idx,senha_hash,status_cadastro,termos_aceitos,criado_em) VALUES ('GESTOR','G',?,?,?,'APROVADO',1,?)`, cifrar('g@t.local'), indice('g@t.local'), hashSenha('Senha@123'), new Date().toISOString());
run("INSERT INTO gestores (usuario_id) VALUES (1)");

// simula o navegador falando com o domínio do Pages
const pages = (caminho, init = {}, env = { BACKEND_URL: backend, PROXY_SECRET: 's3gredo-de-teste' }, fn = onRequest) =>
  fn({ request: new Request(`https://colheita.pages.dev${caminho}`, init), env });

test('acesso direto à API sem o segredo do proxy é negado; healthz continua aberto', async () => {
  assert.equal((await fetch(`${backend}/api/me`)).status, 403);
  assert.equal((await fetch(`${backend}/healthz`)).status, 200);
});

test('login, cookie de sessão e rotas autenticadas passam pelo proxy', async () => {
  const login = await pages('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'g@t.local', senha: 'Senha@123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const me = await pages('/api/me', { headers: { cookie } });
  assert.equal((await me.json()).usuario.tipo, 'GESTOR');
  assert.equal((await pages('/api/me')).status, 401);
  assert.equal((await pages('/healthz', {}, undefined, health)).status, 200);
});

test('SSE atravessa o proxy em streaming', async () => {
  const login = await pages('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'g@t.local', senha: 'Senha@123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const r = await pages('/api/stream', { headers: { cookie } });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const leitor = r.body.getReader();
  const { value } = await leitor.read();
  assert.match(new TextDecoder().decode(value), /retry: 3000/);
  await leitor.cancel();
});

test('sem BACKEND_URL ou com backend fora do ar o proxy responde com erro claro', async () => {
  assert.equal((await pages('/api/me', {}, {})).status, 503);
  const r = await pages('/api/me', {}, { BACKEND_URL: 'http://127.0.0.1:1' });
  assert.equal(r.status, 502);
  assert.equal((await r.json()).codigo, 'BACKEND_INDISPONIVEL');
});
