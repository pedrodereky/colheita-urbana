// Dados fictícios para demonstração: ~4 semanas de histórico + entregas em andamento.
// Usa a própria API (em processo) com o relógio deslocado, então recibos, histórico, ranking,
// auditoria e notificações nascem exatamente como no uso real. Rode depois de `npm run seed`.
import { deflateSync, crc32 } from 'node:zlib';
import { config } from './config.js';
import { get, run, all } from './db.js';
import { criarServidor } from './app.js';
import { definirAgora } from './lib/clock.js';
import { salvarDataUrl } from './lib/files.js';
import { resetarLimitador } from './modules/auth.js';
import { devolverOfertasNaoRetiradas, expirarOfertasDisponiveis, alertarValidadeCritica } from './modules/jobs.js';
import { gerarCnpj, gerarCpf } from './seed.js';

if (config.producao) { console.error('Dados fictícios bloqueados em produção.'); process.exit(1); }
if (!get('SELECT 1 FROM usuarios LIMIT 1')) { console.error('Rode `npm run seed` antes.'); process.exit(1); }
if (get('SELECT 1 FROM historico_doacoes LIMIT 1')) { console.log('Já existem doações no histórico; nada foi feito.'); process.exit(0); }

const servidor = criarServidor();
await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${servidor.address().port}`;

class Cliente {
  constructor() { this.cookie = ''; }
  async req(m, c, b) {
    const r = await fetch(base + c, { method: m, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const d = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (!r.ok) throw new Error(`${m} ${c} → ${r.status} ${d?.erro || ''}`);
    return d;
  }
  get(c) { return this.req('GET', c); }
  post(c, b = {}) { return this.req('POST', c, b); }
}
async function entrar(email) { resetarLimitador(); const c = new Cliente(); const { usuario } = await c.post('/api/login', { email, senha: 'Senha@123' }); c.id = usuario.id; c.nome = usuario.nome; return c; }

// ---- PRNG determinístico (mesma demo sempre) ----
let semente = 20261101;
const rnd = () => { semente |= 0; semente = (semente + 0x6d2b79f5) | 0; let t = Math.imul(semente ^ (semente >>> 15), 1 | semente); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sorteia = (a) => a[Math.floor(rnd() * a.length)];
const embaralha = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---- imagens PNG geradas (degradê colorido) ----
function png(r, g, b) {
  const W = 240, H = 140; const linhas = [];
  for (let y = 0; y < H; y++) {
    const f = 0.55 + 0.45 * (y / H); const row = [0];
    for (let x = 0; x < W; x++) { const v = 1 - Math.abs(x - W / 2) / (W * 1.6); row.push(Math.min(255, r * f * v + 40), Math.min(255, g * f * v + 40), Math.min(255, b * f * v + 40)); }
    linhas.push(Buffer.from(row));
  }
  const chunk = (t, d) => { const tb = Buffer.from(t); const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([tb, d]))); return Buffer.concat([len, tb, d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const buf = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(linhas))), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${buf.toString('base64')}`;
}
const FOTO = { Panificação: png(190, 130, 60), Hortifruti: png(60, 160, 70), Prontos: png(200, 90, 60), Laticínios: png(150, 170, 210), 'Carnes e ovos': png(190, 80, 90), 'Não perecíveis': png(170, 150, 90), Outros: png(120, 130, 130) };

// ---- catálogo ----
const CAT = {
  padaria: { email: 'padaria@colheita.local', itens: [['Pão francês', 'Panificação', 'AMBIENTE'], ['Bolos e roscas', 'Panificação', 'AMBIENTE'], ['Pães de forma e hambúrguer', 'Panificação', 'AMBIENTE']], kg: [8, 25] },
  mercado: { email: 'mercado@colheita.local', itens: [['Frutas e verduras variadas', 'Hortifruti', 'REFRIGERADO'], ['Arroz e feijão (embalagens avariadas)', 'Não perecíveis', 'AMBIENTE'], ['Iogurtes e leites', 'Laticínios', 'REFRIGERADO'], ['Frango congelado', 'Carnes e ovos', 'CONGELADO']], kg: [20, 70] },
  restaurante: { email: 'restaurante@colheita.local', itens: [['Marmitas prontas', 'Prontos', 'REFRIGERADO'], ['Saladas e legumes cozidos', 'Prontos', 'REFRIGERADO']], kg: [10, 35] },
};
const OSCS = ['osc1@colheita.local', 'osc2@colheita.local', 'osc3@colheita.local'];
const VOLUNTARIOS = ['voluntario1@colheita.local', 'voluntario2@colheita.local'];

// ---- 1) planejar 40 doações concluídas ----
const ordem = embaralha([...Array(18).fill('padaria'), ...Array(14).fill('mercado'), ...Array(8).fill('restaurante')]);
const idxRest = ordem.map((e, i) => (e === 'restaurante' ? i : -1)).filter((i) => i >= 0);
const idxMerc = ordem.map((e, i) => (e === 'mercado' ? i : -1)).filter((i) => i >= 0);
const notasRuins = new Map(idxRest.slice(-3).map((i, k) => [i, [2, 1, 2][k]]));   // RN04: ranking penalizado
const recusas = new Set([idxMerc[3], idxMerc[8]]);                                   // duas recusas por qualidade
const plano = ordem.map((chave, i) => {
  const c = CAT[chave]; const [nome, cat, cons] = recusas.has(i) ? c.itens.find((x) => x[2] === 'REFRIGERADO') : sorteia(c.itens);
  const maxKg = cons === 'AMBIENTE' ? c.kg[1] : Math.min(c.kg[1], 70);
  const notaD = chave === 'padaria' ? sorteia([5, 5, 4, 5, 4]) : notasRuins.get(i) ?? sorteia([5, 5, 4, 4, 3]);
  return {
    chave, nome, cat, cons, kg: Math.round(c.kg[0] + rnd() * (maxKg - c.kg[0])), osc: OSCS[i % 3], modalidade: rnd() < 0.7 ? 'VOLUNTARIO' : 'PROPRIO',
    volunt: VOLUNTARIOS[i % 2], recusa: recusas.has(i), notaD, notaE: sorteia([5, 5, 4, 4, 3]),
    quando: (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - (28 - Math.floor((i * 27) / 39))); d.setUTCHours(11 + (i % 6) * 2, 0, 0, 0); return d; })(),
  };
}).sort((a, b) => a.quando - b.quando);

const min = (d, m) => new Date(d.getTime() + m * 60000);
const h = (d, x) => new Date(d.getTime() + x * 3600e3).toISOString();

console.log('Gerando histórico (40 doações)…');
for (const p of plano) {
  const T = p.quando; definirAgora(T);
  const [estab, osc] = await Promise.all([entrar(CAT[p.chave].email), entrar(p.osc)]);
  const transp = p.modalidade === 'VOLUNTARIO' ? await entrar(p.volunt) : null;
  const of = await estab.post('/api/ofertas', { tipoAlimento: p.nome, categoria: p.cat, quantidade: p.kg, unidade: 'kg', conservacao: p.cons, validade: h(T, 80), janelaInicio: h(T, 0), janelaFim: h(T, 8) });
  const oId = of.oferta.id;
  definirAgora(min(T, 10));
  const r = await osc.post(`/api/ofertas/${oId}/reservar`, p.modalidade === 'PROPRIO' ? { modalidade: 'PROPRIO', responsavelRetirada: 'Equipe da OSC' } : { modalidade: 'VOLUNTARIO' });
  const executor = transp || osc;
  if (transp) { definirAgora(min(T, 25)); await transp.post(`/api/coletas/${r.coletaId}/aceitar`); }
  definirAgora(min(T, 55)); await executor.post(`/api/coletas/${r.coletaId}/registrar-coleta`);
  definirAgora(min(T, 55 + 20 + Math.floor(rnd() * 50)));
  if (p.recusa) { await osc.post(`/api/coletas/${r.coletaId}/recusar`, { justificativa: sorteia(['Produtos fora da temperatura adequada.', 'Embalagens danificadas e com odor.', 'Alimentos com sinais de deterioração.']) }); continue; }
  await osc.post(`/api/coletas/${r.coletaId}/confirmar-recebimento`);
  definirAgora(min(T, 55 + 20 + 120));
  await osc.post(`/api/reservas/${r.reservaId}/avaliar-doacao`, { nota: p.notaD, comentario: p.notaD >= 4 ? sorteia(['Tudo em ótimo estado, obrigado!', 'Alimentos frescos e bem embalados.', 'Excelente parceria.', '']) : p.notaD === 3 ? 'Alguns itens próximos do vencimento.' : 'Parte dos alimentos chegou em mau estado.' });
  await osc.post(`/api/reservas/${r.reservaId}/avaliar-entrega`, { nota: p.notaE, comentario: '' });
}

// Entregas recentes e ofertas expiradas sem reserva (taxa de expiração no painel)
for (const dias of [6, 5, 4]) {
  const T = new Date(); T.setUTCDate(T.getUTCDate() - dias); T.setUTCHours(13, 0, 0, 0); definirAgora(T);
  const e = await entrar(CAT.mercado.email);
  await e.post('/api/ofertas', { tipoAlimento: 'Pães e bolos do dia anterior', categoria: 'Panificação', quantidade: 12, unidade: 'kg', conservacao: 'AMBIENTE', validade: h(T, 80), janelaInicio: h(T, 0), janelaFim: h(T, 6) });
}

// Voluntária que aceitou e não apareceu (RN20: 1 falta) — oferta volta à fila com janela renovada
{
  const T = new Date(Date.now() - 50 * 3600e3); definirAgora(T);
  const [e, o, v] = await Promise.all([entrar(CAT.padaria.email), entrar('osc3@colheita.local'), entrar('voluntario2@colheita.local')]);
  const of = await e.post('/api/ofertas', { tipoAlimento: 'Salgados e esfihas', categoria: 'Panificação', quantidade: 15, unidade: 'kg', conservacao: 'AMBIENTE', validade: h(T, 200), janelaInicio: h(T, 0), janelaFim: h(T, 8) });
  const r = await o.post(`/api/ofertas/${of.oferta.id}/reservar`, { modalidade: 'VOLUNTARIO' });
  await v.post(`/api/coletas/${r.coletaId}/aceitar`);
}

definirAgora(null);
console.log('Rodando rotinas (expiração e devolução à fila)…');
console.log(' ', devolverOfertasNaoRetiradas(), 'devolvida(s) à fila;', expirarOfertasDisponiveis(), 'expirada(s)');
run('UPDATE notificacoes SET lida=1'); // o histórico antigo não deve aparecer como "novo"

// ---- 2) situação "ao vivo" (hoje) ----
console.log('Criando entregas em andamento…');
const [padaria, mercado, restaurante, osc1, osc2, osc3, joao, maria, gestor] = await Promise.all(
  [CAT.padaria.email, CAT.mercado.email, CAT.restaurante.email, ...OSCS, ...VOLUNTARIOS, 'gestor@colheita.local'].map(entrar));
const agoraD = Date.now(); const hh = (x) => new Date(agoraD + x * 3600e3).toISOString();
const publicar = (c, nome, cat, kg, cons, validadeH, janelaH = 10) => c.post('/api/ofertas', { tipoAlimento: nome, categoria: cat, quantidade: kg, unidade: 'kg', conservacao: cons, validade: hh(validadeH), janelaInicio: hh(-1), janelaFim: hh(janelaH), imagens: [FOTO[cat] || FOTO.Outros] });

// A) Em coleta, com voluntário a caminho
const a = await publicar(padaria, 'Salgados e sanduíches', 'Panificação', 14, 'AMBIENTE', 90);
const ra = await osc1.post(`/api/ofertas/${a.oferta.id}/reservar`, { modalidade: 'VOLUNTARIO' });
await joao.post(`/api/coletas/${ra.coletaId}/aceitar`);
await joao.post(`/api/coletas/${ra.coletaId}/localizacao`, { latitude: -15.8105, longitude: -47.9600, precisao: 12 });
await osc1.post(`/api/coletas/${ra.coletaId}/chat`, { texto: 'Bom dia! Podem retirar a partir das 14h?' });
await joao.post(`/api/coletas/${ra.coletaId}/chat`, { texto: 'Combinado, estou saindo agora.' });

// B) Em transporte, a caminho da OSC
const b = await publicar(restaurante, 'Sopas e refeições do dia', 'Prontos', 20, 'REFRIGERADO', 85);
const rb = await osc3.post(`/api/ofertas/${b.oferta.id}/reservar`, { modalidade: 'VOLUNTARIO' });
await maria.post(`/api/coletas/${rb.coletaId}/aceitar`);
await restaurante.post(`/api/coletas/${rb.coletaId}/chat`, { texto: 'Está tudo embalado na recepção.' });
await maria.post(`/api/coletas/${rb.coletaId}/registrar-coleta`);
await maria.post(`/api/coletas/${rb.coletaId}/localizacao`, { latitude: -15.8060, longitude: -48.0450, precisao: 8 });
await osc3.post(`/api/coletas/${rb.coletaId}/chat`, { texto: 'Aguardamos na entrada lateral, obrigada!' });

// C) Reservada, aguardando algum voluntário aceitar
const c = await publicar(mercado, 'Iogurtes e leites', 'Laticínios', 25, 'REFRIGERADO', 80);
await osc2.post(`/api/ofertas/${c.oferta.id}/reservar`, { modalidade: 'VOLUNTARIO' });

// D) Ofertas disponíveis (com foto)
await publicar(padaria, 'Bolos e roscas', 'Panificação', 9, 'AMBIENTE', 75);
await publicar(mercado, 'Legumes e tubérculos', 'Hortifruti', 32, 'REFRIGERADO', 100);
await publicar(restaurante, 'Marmitas fit', 'Prontos', 18, 'REFRIGERADO', 62);
await publicar(mercado, 'Macarrão e molho de tomate', 'Não perecíveis', 60, 'AMBIENTE', 24 * 60);
// fotos para as ofertas do seed básico
for (const o of all("SELECT id, categoria FROM ofertas WHERE estado='DISPONIVEL' AND id NOT IN (SELECT oferta_id FROM imagens_oferta)")) {
  run("INSERT INTO imagens_oferta (oferta_id, arquivo, enviado_em) VALUES (?,?,datetime('now'))", o.id, salvarDataUrl(FOTO[o.categoria] || FOTO.Outros, 'imagem'));
}

// ---- 3) cadastros pendentes, suporte, feedback e pesquisa ----
console.log('Criando cadastros pendentes, chamados, feedbacks e pesquisas…');
const novo = (rota, dados) => new Cliente().post(rota, { senha: 'Senha@123', termos: true, ...dados });
const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
await novo('/api/cadastro/osc', { nome: 'Lar Esperança Viva', email: 'lar@colheita.local', telefone: '(61) 3333-1000', endereco: 'QNM 28, Ceilândia - DF', latitude: -15.8140, longitude: -48.1010, cnpj: gerarCnpj('000000080001'), capacidadeRefrigeradaKg: 60, capacidadeSecaKg: 180, validadeDocumentacao: new Date(Date.now() + 250 * 86400e3).toISOString(), comprovante: pdf });
await novo('/api/cadastro/transportador', { nome: 'Carlos Motoboy', email: 'carlos@colheita.local', telefone: '(61) 97777-9999', endereco: 'Taguatinga - DF', latitude: -15.8330, longitude: -48.0560, cpf: gerarCpf('555666777'), tipoVeiculo: 'MOTO', disponibilidade: 'Noites e fins de semana' });

const ch1 = await joao.post('/api/chamados', { categoria: 'ACESSO', assunto: 'Localização não atualiza no celular', descricao: 'Ao iniciar o compartilhamento o mapa fica parado. Uso Android e já liberei a permissão do navegador.' });
await gestor.post(`/api/chamados/${ch1.id}/mensagens`, { texto: 'Olá, João! Pode manter a aba aberta durante o trajeto e desativar a economia de bateria do navegador? Se continuar, nos avise.' });
const ch2 = await osc2.post('/api/chamados', { categoria: 'CADASTRO', assunto: 'Atualização da capacidade de armazenamento', descricao: 'Compramos uma câmara fria nova. Como atualizo a capacidade refrigerada?' });
await gestor.post(`/api/chamados/${ch2.id}/mensagens`, { texto: 'Basta editar em Perfil → Capacidade refrigerada. A mudança vale imediatamente.' });
await gestor.post(`/api/chamados/${ch2.id}/status`, { status: 'RESOLVIDO' });
await mercado.post('/api/chamados', { categoria: 'OFERTA', assunto: 'Erro ao anexar foto grande', descricao: 'Ao enviar fotos de 6 MB a oferta não é publicada. Qual o limite?' });

await osc1.post('/api/feedback', { tipo: 'SUGESTAO', texto: 'Seria ótimo receber um aviso por WhatsApp quando surgirem ofertas de laticínios perto da gente.' });
await joao.post('/api/feedback', { tipo: 'SUGESTAO', texto: 'Mostrar no mapa a opção de abrir a rota no aplicativo de navegação do celular.' });
await osc3.post('/api/feedback', { tipo: 'DENUNCIA', texto: 'Um estabelecimento da região tem informado como "refrigerado" produtos que chegam à temperatura ambiente.' });
await maria.post('/api/feedback', { tipo: 'DENUNCIA', texto: 'Presenciei alimentos doados sendo revendidos em feira por uma pessoa que se apresentou como representante de uma OSC.' });

const pes = get('SELECT id FROM pesquisas ORDER BY id DESC LIMIT 1');
for (const [cl, notas, g, txt] of [[osc1, [5, 4, 5], 5, 'Plataforma muito simples de usar.'], [osc2, [4, 4, 4], 4, ''], [osc3, [5, 5, 4], 5, 'O chat da entrega ajuda muito.'], [padaria, [5, 5, 5], 5, 'Recibo digital facilitou nossa contabilidade.'], [mercado, [4, 3, 4], 4, 'Gostaria de relatórios por mês.'], [joao, [4, 4, 3], 4, '']]) {
  await cl.post(`/api/pesquisas/${pes.id}/responder`, { notaGeral: g, respostas: notas, comentario: txt });
}

alertarValidadeCritica();
console.log('\nPronto! Resumo:');
for (const [rot, sql] of [['usuários', 'SELECT COUNT(*) n FROM usuarios'], ['ofertas', 'SELECT COUNT(*) n FROM ofertas'], ['doações entregues', "SELECT COUNT(*) n FROM historico_doacoes WHERE situacao='ENTREGUE'"], ['recusadas', "SELECT COUNT(*) n FROM historico_doacoes WHERE situacao='RECUSADA'"], ['recibos', 'SELECT COUNT(*) n FROM recibos'], ['avaliações', 'SELECT COUNT(*) n FROM avaliacoes'], ['selos/certificados', 'SELECT COUNT(*) n FROM reconhecimentos'], ['registros de auditoria', 'SELECT COUNT(*) n FROM logs_auditoria']]) console.log(`  ${rot}: ${get(sql).n}`);
servidor.close(); servidor.closeAllConnections?.(); process.exit(0);
