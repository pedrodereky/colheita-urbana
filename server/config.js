import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Carrega .env simples (sem dependências)
const envFile = resolve(raiz, '.env');
if (existsSync(envFile)) {
  for (const linha of readFileSync(envFile, 'utf8').split('\n')) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const dataDir = resolve(raiz, process.env.DATA_DIR || '.data');
for (const sub of ['', 'uploads', 'backups']) mkdirSync(resolve(dataDir, sub), { recursive: true });

function chave() {
  if (process.env.APP_ENC_KEY && /^[0-9a-f]{64}$/i.test(process.env.APP_ENC_KEY)) {
    return Buffer.from(process.env.APP_ENC_KEY, 'hex');
  }
  const arquivo = resolve(dataDir, 'enc.key');
  if (!existsSync(arquivo)) writeFileSync(arquivo, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(arquivo, 'utf8').trim(), 'hex');
}

export const config = {
  raiz,
  porta: Number(process.env.PORT || 3000),
  producao: process.env.NODE_ENV === 'production',
  dataDir,
  uploadsDir: resolve(dataDir, 'uploads'),
  backupsDir: resolve(dataDir, 'backups'),
  dbFile: process.env.DB_FILE || resolve(dataDir, 'colheita.db'),
  webDir: resolve(raiz, 'web'),
  chave: chave(),
  // Atrás do proxy do Cloudflare Pages: confia no IP repassado e exige o segredo compartilhado
  confiarProxy: process.env.TRUST_PROXY === '1',
  proxySecret: process.env.PROXY_SECRET || '',
  mapas: { provedor: process.env.MAPS_PROVIDER || 'local', osrmUrl: process.env.OSRM_URL || 'https://router.project-osrm.org' },
  // Parâmetros de negócio (documentação: RN06, RN10, RN16, RN20, RN26 ...)
  regras: {
    quantidadeMinimaKg: 1,                 // RN06
    validadeMinimaHoras: 36,               // RN16
    validadeCurtaHoras: 72,                // RN26
    validadeCriticaHoras: 12,              // RN26
    maxColetasAtivas: 3,                   // RN10
    faltasParaSuspensao: 3,                // RN20
    diasSuspensaoTransportador: 30,        // RN20
    avaliacoesNegativasParaPenalidade: 3,  // RN04
    janelaPenalidadeDias: 30,              // RN04 / RN12
    avaliacoesPositivasParaSelo: 15,       // RN11 (mais de 15)
    entregasParaCertificado: 50,           // RN27 (mais de 50)
    inconsistenciasParaBloqueio: 3,        // RN12
    kgPorRefeicao: 0.5,                    // RF19 (refeição equivalente)
    velocidadeMediaKmh: 30,                // estimativa de deslocamento urbano
    fatorRota: 1.3,                        // linha reta -> distância viária aproximada
    raioNotificacaoKm: 30,                 // RF11
    chatRetencaoDias: 7,                   // RN34 / LGPD
    sessaoHoras: 12,
    tokenSenhaMinutos: 30,
  },
};

export const veiculos = {
  BICICLETA: { rotulo: 'Bicicleta', capacidadeKg: 15 },
  MOTO: { rotulo: 'Moto', capacidadeKg: 30 },
  CARRO: { rotulo: 'Carro', capacidadeKg: 200 },
  VAN: { rotulo: 'Van / utilitário', capacidadeKg: 800 },
  CAMINHAO: { rotulo: 'Caminhão', capacidadeKg: 5000 },
};
