import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'cu-test-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const { criarServidor } = await import('../server/app.js');
const { gerarCnpj, gerarCpf } = await import('../server/seed.js');
export const clock = await import('../server/lib/clock.js');
export const dbm = await import('../server/db.js');
export const maps = await import('../server/lib/maps.js');
export const jobs = await import('../server/modules/jobs.js');
export const auth = await import('../server/modules/auth.js');

const servidor = criarServidor();
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
export const base = `http://127.0.0.1:${servidor.address().port}`;
export const fechar = () => { servidor.close(); servidor.closeAllConnections?.(); try { rmSync(dir, { recursive: true, force: true }); } catch {} };

export class Cliente {
  constructor() { this.cookie = ''; }
  async req(metodo, caminho, corpo) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const tipo = r.headers.get('content-type') || '';
    const dados = tipo.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, dados, headers: r.headers };
  }
  get(c) { return this.req('GET', c); }
  post(c, b = {}) { return this.req('POST', c, b); }
  patch(c, b = {}) { return this.req('PATCH', c, b); }
  async login(email, senha = 'Senha@123') { const r = await this.post('/api/login', { email, senha }); if (r.status !== 200) throw new Error('login falhou: ' + JSON.stringify(r.dados)); return r.dados.usuario; }
}

let seq = 100;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
export { PNG, PDF };

export const gestor = new Cliente();
export async function prepararGestor() {
  const { run } = dbm; const { cifrar, indice, hashSenha } = await import('../server/lib/crypto.js');
  const r = run(`INSERT INTO usuarios (tipo,nome,email_enc,email_idx,senha_hash,status_cadastro,termos_aceitos,criado_em) VALUES ('GESTOR','Gestora',?,?,?, 'APROVADO',1,?)`,
    cifrar('gestora@t.local'), indice('gestora@t.local'), hashSenha('Senha@123'), new Date().toISOString());
  run('INSERT INTO gestores (usuario_id, matricula) VALUES (?,?)', Number(r.lastInsertRowid), 'T1');
  await gestor.login('gestora@t.local');
}

// Cria usuário via API pública e aprova pelo gestor
export async function criar(tipo, extra = {}) {
  const n = ++seq;
  const c = new Cliente();
  const comum = { nome: `${tipo} ${n}`, email: `u${n}@t.local`, senha: 'Senha@123', telefone: '61999990000', endereco: 'Rua X', latitude: -15.79 + (extra.dLat ?? 0), longitude: -47.88 + (extra.dLon ?? 0), termos: true };
  let r;
  if (tipo === 'ESTABELECIMENTO') r = await c.post('/api/cadastro/estabelecimento', { ...comum, cnpj: gerarCnpj(String(n).padStart(8, '0') + '0001'), ramo: 'Padaria', ...extra.campos });
  if (tipo === 'OSC') r = await c.post('/api/cadastro/osc', { ...comum, cnpj: gerarCnpj(String(n).padStart(8, '0') + '0001'), capacidadeRefrigeradaKg: 100, capacidadeSecaKg: 200, validadeDocumentacao: new Date(Date.now() + 200 * 86400e3).toISOString(), comprovante: PDF, ...extra.campos });
  if (tipo === 'TRANSPORTADOR') r = await c.post('/api/cadastro/transportador', { ...comum, cpf: gerarCpf(String(n).padStart(9, '1')), tipoVeiculo: 'CARRO', disponibilidade: 'Sempre', ...extra.campos });
  if (r.status !== 200) throw new Error(`cadastro ${tipo}: ${JSON.stringify(r.dados)}`);
  if (extra.aprovar !== false) { const a = await gestor.post(`/api/gestor/cadastros/${r.dados.id}/aprovar`); if (a.status !== 200) throw new Error(JSON.stringify(a.dados)); }
  await c.login(comum.email);
  c.id = r.dados.id;
  return c;
}

export const horas = (h) => new Date(clock.agora().getTime() + h * 3600e3).toISOString();
export function dadosOferta(extra = {}) {
  return { tipoAlimento: 'Pão francês', categoria: 'Panificação', quantidade: 10, unidade: 'kg', conservacao: 'AMBIENTE', validade: horas(60), janelaInicio: horas(-1), janelaFim: horas(8), ...extra };
}
