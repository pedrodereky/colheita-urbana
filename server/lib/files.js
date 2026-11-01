import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from './http.js';

const TIPOS = {
  imagem: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  evidencia: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' },
  documento: { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' },
};
const LIMITES = { imagem: 4 * 1024 * 1024, evidencia: 10 * 1024 * 1024, documento: 5 * 1024 * 1024 };

// Recebe um data URL (base64), valida formato/tamanho e grava com nome aleatório.
export function salvarDataUrl(dataUrl, categoria) {
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  const ext = m && TIPOS[categoria][m[1]];
  if (!ext) throw new HttpError(400, 'Formato de arquivo não suportado.', 'ARQUIVO_FORMATO');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > LIMITES[categoria]) throw new HttpError(400, `Arquivo maior que ${LIMITES[categoria] / 1024 / 1024} MB.`, 'ARQUIVO_TAMANHO');
  if (!assinaturaConfere(buf, m[1])) throw new HttpError(400, 'O conteúdo do arquivo não corresponde ao formato.', 'ARQUIVO_FORMATO');
  const nome = `${randomUUID()}.${ext}`;
  writeFileSync(resolve(config.uploadsDir, nome), buf);
  return nome;
}

function assinaturaConfere(b, mime) {
  const h = (n) => b.subarray(0, n).toString('hex');
  switch (mime) {
    case 'image/jpeg': return h(3) === 'ffd8ff';
    case 'image/png': return h(4) === '89504e47';
    case 'image/webp': return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
    case 'application/pdf': return b.subarray(0, 4).toString() === '%PDF';
    case 'video/mp4': return b.subarray(4, 8).toString() === 'ftyp';
    case 'video/webm': return h(4) === '1a45dfa3';
    default: return false;
  }
}

export function caminhoUpload(nome) {
  if (!/^[\w-]+\.\w+$/.test(nome)) throw new HttpError(400, 'Nome inválido.', 'ARQUIVO_NOME');
  const p = resolve(config.uploadsDir, nome);
  if (!existsSync(p)) throw new HttpError(404, 'Arquivo não encontrado.', 'ARQUIVO_NAO_ENCONTRADO');
  return p;
}
