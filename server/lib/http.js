import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, extname, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, code = 'ERRO', detalhes) {
    super(message);
    this.status = status;
    this.code = code;
    this.detalhes = detalhes;
  }
}

const rotas = [];
export function route(metodo, caminho, opcoes, handler) {
  if (typeof opcoes === 'function') { handler = opcoes; opcoes = {}; }
  const nomes = [];
  const re = new RegExp('^' + caminho.replace(/:([a-zA-Z]+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
  rotas.push({ metodo, re, nomes, opcoes, handler });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};
export const mimeDe = (arquivo) => MIME[extname(arquivo).toLowerCase()] || 'application/octet-stream';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "media-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function cabecalhosSeguranca(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

// IP do cliente; só confia em X-Forwarded-For quando o servidor está atrás do proxy configurado
export function ipDe(req) {
  if (config.confiarProxy) { const xff = req.headers['x-forwarded-for']; if (xff) return String(xff).split(',')[0].trim(); }
  return req.socket.remoteAddress;
}

export function json(res, status, corpo) {
  const dados = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(dados);
}

export function enviarBuffer(res, buffer, tipo, nome) {
  const h = { 'Content-Type': tipo, 'Content-Length': buffer.length, 'Cache-Control': 'no-store' };
  if (nome) h['Content-Disposition'] = `attachment; filename="${nome}"`;
  res.writeHead(200, h);
  res.end(buffer);
}

export function cookies(req) {
  const out = {};
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return out;
}

export function definirCookie(res, nome, valor, { maxAgeSeg } = {}) {
  const partes = [`${nome}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (maxAgeSeg !== undefined) partes.push(`Max-Age=${maxAgeSeg}`);
  if (config.producao) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

const LIMITE_CORPO = 14 * 1024 * 1024; // uploads em base64
async function lerCorpo(req) {
  if (['GET', 'HEAD', 'DELETE'].includes(req.method)) return {};
  const partes = [];
  let total = 0;
  for await (const p of req) {
    total += p.length;
    if (total > LIMITE_CORPO) throw new HttpError(413, 'Requisição grande demais.', 'CORPO_GRANDE');
    partes.push(p);
  }
  if (!total) return {};
  // defesa contra CSRF: só aceitamos JSON (formulários cross-site não conseguem enviar este tipo)
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Use Content-Type: application/json.', 'TIPO_INVALIDO');
  }
  try { return JSON.parse(Buffer.concat(partes).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON inválido.', 'JSON_INVALIDO'); }
}

function segredoConfere(valor) {
  const a = Buffer.from(String(valor || '')), b = Buffer.from(config.proxySecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

let resolverUsuario = () => null;
export const definirResolverUsuario = (fn) => { resolverUsuario = fn; };

export async function tratar(req, res) {
  const url = new URL(req.url, 'http://x');
  cabecalhosSeguranca(res);
  try {
    if (config.proxySecret && url.pathname.startsWith('/api/') && !segredoConfere(req.headers['x-proxy-secret'])) {
      throw new HttpError(403, 'Acesso direto à API não permitido.', 'SEM_PROXY');
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const r = rotas.find((x) => x.metodo === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'Rota não encontrada.', 'NAO_ENCONTRADO');
      const m = url.pathname.match(r.re);
      const params = {};
      r.nomes.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body: await lerCorpo(req), user: null };
      if (r.opcoes.publica !== true) {
        ctx.user = resolverUsuario(req);
        if (!ctx.user) throw new HttpError(401, 'Faça login para continuar.', 'NAO_AUTENTICADO');
        if (r.opcoes.perfis && !r.opcoes.perfis.includes(ctx.user.tipo)) {
          throw new HttpError(403, 'Seu perfil não tem acesso a esta função.', 'SEM_PERMISSAO');
        }
      } else {
        ctx.user = resolverUsuario(req);
      }
      const resultado = await r.handler(ctx);
      if (!res.writableEnded && !res.headersSent) json(res, 200, resultado ?? { ok: true });
      return;
    }
    return servirEstatico(url.pathname, res);
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    if (e instanceof HttpError) return json(res, e.status, { erro: e.message, codigo: e.code, detalhes: e.detalhes });
    console.error('[erro]', req.method, url.pathname, e);
    return json(res, 500, { erro: 'Erro interno. Tente novamente.', codigo: 'ERRO_INTERNO' });
  }
}

function servirEstatico(caminho, res) {
  let rel = normalize(decodeURIComponent(caminho)).replace(/^([/\\])+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  let arquivo = resolve(config.webDir, rel);
  if (!arquivo.startsWith(config.webDir)) throw new HttpError(403, 'Acesso negado.', 'PROIBIDO');
  if (!existsSync(arquivo) || !statSync(arquivo).isFile()) arquivo = resolve(config.webDir, 'index.html'); // SPA
  res.writeHead(200, { 'Content-Type': mimeDe(arquivo), 'Cache-Control': 'no-cache' });
  createReadStream(arquivo).pipe(res);
}
