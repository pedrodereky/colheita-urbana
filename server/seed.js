import { run, get } from './db.js';
import { config } from './config.js';
import { cifrar, indice, hashSenha } from './lib/crypto.js';
import { iso, somarHoras, agora } from './lib/clock.js';
import { registrar } from './lib/audit.js';

export const SENHA_DEMO = 'Senha@123';

// Gera CNPJ válido a partir de 12 dígitos-base (apenas para dados de demonstração)
export function gerarCnpj(base12) {
  const dv = (b) => { let s = 0, p = b.length - 7; for (const d of b) { s += Number(d) * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base12); const d2 = dv(base12 + d1);
  return `${base12}${d1}${d2}`;
}
export function gerarCpf(base9) {
  const dv = (b, n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(b[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(base9, 9); const d2 = dv(base9 + d1, 10);
  return `${base9}${d1}${d2}`;
}

function usuario({ tipo, nome, email, telefone, endereco, lat, lon, status = 'APROVADO' }) {
  const r = run(
    `INSERT INTO usuarios (tipo, nome, email_enc, email_idx, telefone_enc, endereco_enc, latitude, longitude, senha_hash, status_cadastro, termos_aceitos, termos_em, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    tipo, nome, cifrar(email), indice(email), cifrar(telefone), cifrar(endereco), lat, lon, hashSenha(SENHA_DEMO), status, iso(), iso());
  return Number(r.lastInsertRowid);
}

export function popularDemo() {
  if (get('SELECT 1 FROM usuarios LIMIT 1')) return false;

  const g = usuario({ tipo: 'GESTOR', nome: 'Gestão Colheita Urbana', email: 'gestor@colheita.local', telefone: '(61) 3000-0000', endereco: 'Brasília - DF', lat: -15.7942, lon: -47.8822 });
  run('INSERT INTO gestores (usuario_id, matricula) VALUES (?,?)', g, 'G-0001');

  const estabs = [
    ['Supermercado Bom Preço', 'mercado@colheita.local', 'Supermercado', '000000010001', 'CLN 405, Asa Norte, Brasília - DF', -15.7595, -47.8788],
    ['Padaria Pão Quente', 'padaria@colheita.local', 'Padaria', '000000020001', 'CLS 308, Asa Sul, Brasília - DF', -15.8245, -47.9072],
    ['Restaurante Sabor do Cerrado', 'restaurante@colheita.local', 'Restaurante', '000000030001', 'SCS Quadra 6, Brasília - DF', -15.7969, -47.8918],
  ].map(([nome, email, ramo, base, end, lat, lon]) => {
    const id = usuario({ tipo: 'ESTABELECIMENTO', nome, email, telefone: '(61) 99999-0001', endereco: end, lat, lon });
    const cnpj = gerarCnpj(base);
    run('INSERT INTO estabelecimentos (usuario_id, cnpj_enc, cnpj_idx, ramo) VALUES (?,?,?,?)', id, cifrar(cnpj), indice(cnpj), ramo);
    return id;
  });

  const validadeDoc = iso(somarHoras(agora(), 24 * 200)).slice(0, 10);
  const oscs = [
    ['Casa da Esperança', 'osc1@colheita.local', '000000040001', 150, 400, 'Quadra 12, Ceilândia - DF', -15.8197, -48.1067],
    ['Associação Mãos Solidárias', 'osc2@colheita.local', '000000050001', 80, 250, 'Setor Norte, Planaltina - DF', -15.6208, -47.6528],
    ['Instituto Prato Cheio', 'osc3@colheita.local', '000000060001', 300, 600, 'QNN 10, Ceilândia Norte - DF', -15.8084, -48.1156],
  ].map(([nome, email, base, refr, seca, end, lat, lon]) => {
    const id = usuario({ tipo: 'OSC', nome, email, telefone: '(61) 98888-0002', endereco: end, lat, lon });
    const cnpj = gerarCnpj(base);
    run('INSERT INTO oscs (usuario_id, cnpj_enc, cnpj_idx, capacidade_refrigerada_kg, capacidade_seca_kg, validade_documentacao, comprovante) VALUES (?,?,?,?,?,?,?)',
      id, cifrar(cnpj), indice(cnpj), refr, seca, validadeDoc, 'demo-comprovante.pdf');
    return id;
  });

  const transp = [
    ['João Voluntário', 'voluntario1@colheita.local', '123456789', 'CARRO', 'Seg a sex, 14h às 20h', -15.8, -47.95],
    ['Maria Entregas', 'voluntario2@colheita.local', '987654321', 'VAN', 'Fins de semana', -15.78, -47.9],
  ].map(([nome, email, base, veiculo, disp, lat, lon]) => {
    const id = usuario({ tipo: 'TRANSPORTADOR', nome, email, telefone: '(61) 97777-0003', endereco: 'Brasília - DF', lat, lon });
    const cpf = gerarCpf(base);
    run('INSERT INTO transportadores (usuario_id, cpf_enc, cpf_idx, tipo_veiculo, disponibilidade) VALUES (?,?,?,?,?)', id, cifrar(cpf), indice(cpf), veiculo, disp);
    return id;
  });

  // Cadastro pendente para a fila do gestor
  const pend = usuario({ tipo: 'ESTABELECIMENTO', nome: 'Hortifruti Verde Vida', email: 'hortifruti@colheita.local', telefone: '(61) 99999-0009', endereco: 'CRS 503, Brasília - DF', lat: -15.8, lon: -47.9, status: 'PENDENTE' });
  const cp = gerarCnpj('000000070001');
  run('INSERT INTO estabelecimentos (usuario_id, cnpj_enc, cnpj_idx, ramo) VALUES (?,?,?,?)', pend, cifrar(cp), indice(cp), 'Hortifruti');

  // CNPJ em lista de irregulares (RN17) para demonstrar a recusa
  const irregular = gerarCnpj('000000990001');
  run('INSERT INTO cnpjs_irregulares (cnpj_idx, motivo) VALUES (?,?)', indice(irregular), 'Demonstração');

  // Ofertas de exemplo
  const agoraD = agora();
  const oferta = (estab, tipo, cat, kg, horasValidade, conserv) => {
    const r = run(
      `INSERT INTO ofertas (estabelecimento_id, tipo_alimento, categoria, quantidade_kg, validade, conservacao, janela_inicio, janela_fim, estado, criado_em) VALUES (?,?,?,?,?,?,?,?, 'DISPONIVEL', ?)`,
      estab, tipo, cat, kg, iso(somarHoras(agoraD, horasValidade)), conserv, iso(somarHoras(agoraD, -1)), iso(somarHoras(agoraD, Math.min(10, horasValidade - 2))), iso());
    registrar({ entidade: 'oferta', entidadeId: Number(r.lastInsertRowid), acao: 'PUBLICAR', para: 'DISPONIVEL' });
  };
  oferta(estabs[0], 'Frutas e verduras variadas', 'Hortifruti', 45, 60, 'REFRIGERADO');
  oferta(estabs[0], 'Arroz e feijão (pacotes avariados)', 'Não perecíveis', 120, 24 * 40, 'AMBIENTE');
  oferta(estabs[1], 'Pães do dia', 'Panificação', 18, 40, 'AMBIENTE');
  oferta(estabs[2], 'Refeições prontas (marmitas)', 'Prontos', 30, 38, 'REFRIGERADO');

  run('INSERT INTO pesquisas (titulo, periodo_inicio, periodo_fim, perguntas, ativa) VALUES (?,?,?,?,1)',
    'Como está sendo sua experiência?', iso(somarHoras(agoraD, -24)), iso(somarHoras(agoraD, 24 * 30)), JSON.stringify(['Facilidade de uso da plataforma', 'Qualidade do suporte', 'Clareza das informações']));
  return { gestor: g, estabs, oscs, transp };
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  if (config.producao && process.env.FORCE_SEED !== '1') { console.error('Seed bloqueado em produção (use FORCE_SEED=1).'); process.exit(1); }
  console.log(popularDemo() ? `Dados de demonstração criados. Senha de todos os usuários: ${SENHA_DEMO}\n  gestor@colheita.local · mercado@colheita.local · osc1@colheita.local · voluntario1@colheita.local` : 'Banco já possui dados; nada foi feito.');
}
