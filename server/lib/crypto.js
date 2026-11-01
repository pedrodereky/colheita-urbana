import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// RNF01 - criptografia AES-256-GCM de dados sensíveis (CPF, CNPJ, endereço, telefone, e-mail)
export function cifrar(texto) {
  if (texto === null || texto === undefined || texto === '') return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.chave, iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decifrar(valor) {
  if (!valor) return null;
  const [, iv, tag, ct] = valor.split(':');
  const d = createDecipheriv('aes-256-gcm', config.chave, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// Índice cego: permite buscar/garantir unicidade sem guardar o dado em claro
export const indice = (texto) => createHmac('sha256', config.chave).update(String(texto).trim().toLowerCase()).digest('hex');

export function hashSenha(senha) {
  const sal = randomBytes(16);
  const h = scryptSync(senha, sal, 64);
  return `scrypt:${sal.toString('hex')}:${h.toString('hex')}`;
}

export function conferirSenha(senha, armazenado) {
  const [, sal, h] = armazenado.split(':');
  const calc = scryptSync(senha, Buffer.from(sal, 'hex'), 64);
  return timingSafeEqual(calc, Buffer.from(h, 'hex'));
}

export const tokenAleatorio = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (t) => createHash('sha256').update(t).digest('hex');
