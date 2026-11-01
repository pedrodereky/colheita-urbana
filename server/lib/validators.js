import { HttpError } from './http.js';

export const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

// RN17 - CNPJ válido (dígitos verificadores)
export function cnpjValido(valor) {
  const c = soDigitos(valor);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const dv = (base) => {
    let soma = 0, peso = base.length - 7;
    for (const d of base) { soma += Number(d) * peso--; if (peso < 2) peso = 9; }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  const d2 = dv(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

export function cpfValido(valor) {
  const c = soDigitos(valor);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e ?? ''));
export const senhaForte = (s) => typeof s === 'string' && s.length >= 8 && /[A-Za-z]/.test(s) && /\d/.test(s);

// RN06 - "1 kg ou equivalente"
const FATORES_KG = { kg: 1, g: 0.001, t: 1000, l: 1, ml: 0.001 };
export const UNIDADES = Object.keys(FATORES_KG);
export function paraKg(quantidade, unidade = 'kg') {
  const f = FATORES_KG[String(unidade).toLowerCase()];
  const q = Number(quantidade);
  if (!f || !Number.isFinite(q) || q <= 0) throw new HttpError(400, 'Quantidade ou unidade inválida.', 'QUANTIDADE_INVALIDA');
  return Math.round(q * f * 1000) / 1000;
}

// Helpers de leitura de corpo: lançam 400 com mensagem amigável
export const exigir = {
  texto(obj, campo, rotulo, { min = 1, max = 500 } = {}) {
    const v = typeof obj?.[campo] === 'string' ? obj[campo].trim() : '';
    if (v.length < min) throw new HttpError(400, `Informe ${rotulo}.`, 'CAMPO_OBRIGATORIO', { campo });
    if (v.length > max) throw new HttpError(400, `${rotulo} excede ${max} caracteres.`, 'CAMPO_LONGO', { campo });
    return v;
  },
  opcional(obj, campo, max = 500) {
    const v = typeof obj?.[campo] === 'string' ? obj[campo].trim() : '';
    if (v.length > max) throw new HttpError(400, `Campo ${campo} muito longo.`, 'CAMPO_LONGO', { campo });
    return v || null;
  },
  numero(obj, campo, rotulo, { min = -Infinity, max = Infinity } = {}) {
    const v = Number(obj?.[campo]);
    if (obj?.[campo] === '' || obj?.[campo] == null || !Number.isFinite(v) || v < min || v > max) {
      throw new HttpError(400, `${rotulo} inválido(a).`, 'NUMERO_INVALIDO', { campo });
    }
    return v;
  },
  data(obj, campo, rotulo) {
    const d = new Date(obj?.[campo]);
    if (!obj?.[campo] || Number.isNaN(d.getTime())) throw new HttpError(400, `${rotulo} inválida.`, 'DATA_INVALIDA', { campo });
    return d;
  },
  enum(obj, campo, rotulo, valores) {
    const v = obj?.[campo];
    if (!valores.includes(v)) throw new HttpError(400, `${rotulo} inválido(a).`, 'VALOR_INVALIDO', { campo });
    return v;
  },
  coordenadas(obj) {
    const latitude = exigir.numero(obj, 'latitude', 'Latitude', { min: -90, max: 90 });
    const longitude = exigir.numero(obj, 'longitude', 'Longitude', { min: -180, max: 180 });
    return { latitude, longitude };
  },
};
