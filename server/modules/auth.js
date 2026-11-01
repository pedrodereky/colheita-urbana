import { route, HttpError, definirResolverUsuario, cookies, definirCookie, ipDe } from '../lib/http.js';
import { run, get, all, tx } from '../db.js';
import { cifrar, decifrar, indice, hashSenha, conferirSenha, tokenAleatorio, sha256 } from '../lib/crypto.js';
import { exigir, cnpjValido, cpfValido, emailValido, senhaForte, soDigitos } from '../lib/validators.js';
import { agora, iso, somarHoras } from '../lib/clock.js';
import { config, veiculos } from '../config.js';
import { registrar } from '../lib/audit.js';
import { notificar, notificarGestores, enviarEmailParaEndereco } from '../lib/notify.js';
import { salvarDataUrl } from '../lib/files.js';
import { perfilCompleto, carregarUsuario } from '../lib/usuarios.js';

const COOKIE = 'cu_sid';

// ---------- sessão ----------
definirResolverUsuario((req) => {
  const tk = cookies(req)[COOKIE];
  if (!tk) return null;
  const s = get('SELECT usuario_id, expira_em FROM sessoes WHERE token_hash=?', sha256(tk));
  if (!s || s.expira_em < iso()) return null;
  const u = carregarUsuario(s.usuario_id);
  return u && { ...u, _token: tk };
});

const tentativas = new Map(); // limitador simples de força bruta (em memória)
function limitar(chave) {
  const t = agora().getTime();
  const lista = (tentativas.get(chave) || []).filter((x) => t - x < 15 * 60e3);
  if (lista.length >= 8) throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos.', 'MUITAS_TENTATIVAS');
  lista.push(t);
  tentativas.set(chave, lista);
}
export const resetarLimitador = () => tentativas.clear();

route('POST', '/api/login', { publica: true }, ({ body, res, req }) => {
  const email = exigir.texto(body, 'email', 'o e-mail', { max: 200 });
  const senha = exigir.texto(body, 'senha', 'a senha', { max: 200 });
  limitar(`${ipDe(req)}|${email.toLowerCase()}`);
  const u = get('SELECT * FROM usuarios WHERE email_idx=?', indice(email));
  if (!u || !conferirSenha(senha, u.senha_hash)) throw new HttpError(401, 'E-mail ou senha incorretos.', 'CREDENCIAIS');
  const token = tokenAleatorio();
  run('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?,?,?)', sha256(token), u.id, iso(somarHoras(agora(), config.regras.sessaoHoras)));
  definirCookie(res, COOKIE, token, { maxAgeSeg: config.regras.sessaoHoras * 3600 });
  return { usuario: perfilCompleto(u.id) };
});

route('POST', '/api/logout', ({ user, res }) => {
  run('DELETE FROM sessoes WHERE token_hash=?', sha256(user._token));
  definirCookie(res, COOKIE, '', { maxAgeSeg: 0 });
});

route('GET', '/api/me', ({ user }) => ({ usuario: perfilCompleto(user.id), veiculos }));

// ---------- cadastro (UC01, UC02, UC03) ----------
function dadosComuns(body, tipo) {
  const nome = exigir.texto(body, 'nome', 'o nome', { max: 200 });
  const email = exigir.texto(body, 'email', 'o e-mail', { max: 200 }).toLowerCase();
  if (!emailValido(email)) throw new HttpError(400, 'E-mail inválido.', 'EMAIL_INVALIDO');
  const senha = exigir.texto(body, 'senha', 'a senha', { max: 200 });
  if (!senhaForte(senha)) throw new HttpError(400, 'A senha deve ter ao menos 8 caracteres, com letras e números.', 'SENHA_FRACA');
  const telefone = exigir.texto(body, 'telefone', 'o telefone', { max: 30 });
  const endereco = exigir.texto(body, 'endereco', 'o endereço', { max: 300 });
  const { latitude, longitude } = exigir.coordenadas(body);
  // RN22 - termos de uso e política de privacidade
  if (body.termos !== true) throw new HttpError(400, 'É necessário aceitar os termos de uso e a política de privacidade.', 'TERMOS_NAO_ACEITOS');
  if (get('SELECT 1 FROM usuarios WHERE email_idx=?', indice(email))) throw new HttpError(409, 'Já existe um cadastro com este e-mail.', 'EMAIL_DUPLICADO');
  return { tipo, nome, email, senha, telefone, endereco, latitude, longitude };
}

function inserirUsuario(d) {
  const r = run(
    `INSERT INTO usuarios (tipo, nome, email_enc, email_idx, telefone_enc, endereco_enc, latitude, longitude, senha_hash, status_cadastro, termos_aceitos, termos_em, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?, 'PENDENTE', 1, ?, ?)`,
    d.tipo, d.nome, cifrar(d.email), indice(d.email), cifrar(d.telefone), cifrar(d.endereco), d.latitude, d.longitude, hashSenha(d.senha), iso(), iso(),
  );
  return Number(r.lastInsertRowid);
}

function validarCnpjCadastro(body) {
  const cnpj = soDigitos(exigir.texto(body, 'cnpj', 'o CNPJ', { max: 30 }));
  // RN17 - CNPJ válido e fora da lista de empresas irregulares
  if (!cnpjValido(cnpj)) throw new HttpError(400, 'CNPJ inválido.', 'CNPJ_INVALIDO');
  if (get('SELECT 1 FROM cnpjs_irregulares WHERE cnpj_idx=?', indice(cnpj))) {
    throw new HttpError(422, 'Este CNPJ consta na lista de empresas irregulares e não pode ser cadastrado.', 'CNPJ_IRREGULAR');
  }
  if (get('SELECT 1 FROM estabelecimentos WHERE cnpj_idx=?', indice(cnpj)) || get('SELECT 1 FROM oscs WHERE cnpj_idx=?', indice(cnpj))) {
    throw new HttpError(409, 'Já existe um cadastro com este CNPJ.', 'CNPJ_DUPLICADO');
  }
  return cnpj;
}

function finalizarCadastro(id, tipo) {
  registrar({ autorId: id, entidade: 'usuario', entidadeId: id, acao: 'CADASTRO', de: null, para: 'PENDENTE' });
  notificarGestores('CADASTRO', `Novo cadastro pendente de análise (${tipo.toLowerCase()}).`, { referencia: `usuario:${id}` });
}

route('POST', '/api/cadastro/estabelecimento', { publica: true }, ({ body }) => {
  const d = dadosComuns(body, 'ESTABELECIMENTO');
  const cnpj = validarCnpjCadastro(body);
  const id = tx(() => {
    const uid = inserirUsuario(d);
    run('INSERT INTO estabelecimentos (usuario_id, cnpj_enc, cnpj_idx, ramo) VALUES (?,?,?,?)', uid, cifrar(cnpj), indice(cnpj), exigir.opcional(body, 'ramo', 80));
    return uid;
  });
  finalizarCadastro(id, 'ESTABELECIMENTO');
  return { id, statusCadastro: 'PENDENTE', mensagem: 'Cadastro recebido e aguardando análise do gestor.' };
});

route('POST', '/api/cadastro/osc', { publica: true }, ({ body }) => {
  const d = dadosComuns(body, 'OSC');
  const cnpj = validarCnpjCadastro(body);
  const refrig = exigir.numero(body, 'capacidadeRefrigeradaKg', 'Capacidade refrigerada', { min: 0, max: 1e6 });
  const seca = exigir.numero(body, 'capacidadeSecaKg', 'Capacidade seca', { min: 0, max: 1e6 });
  if (refrig + seca <= 0) throw new HttpError(400, 'Informe a capacidade de armazenamento (RN13).', 'CAPACIDADE_OBRIGATORIA');
  const validade = exigir.data(body, 'validadeDocumentacao', 'Validade da documentação');
  if (validade < agora()) throw new HttpError(400, 'A documentação anual está vencida (RN15).', 'DOCUMENTACAO_VENCIDA');
  if (!body.comprovante) throw new HttpError(400, 'Anexe o comprovante de regularidade.', 'COMPROVANTE_OBRIGATORIO');
  const arquivo = salvarDataUrl(body.comprovante, 'documento');
  const id = tx(() => {
    const uid = inserirUsuario(d);
    run('INSERT INTO oscs (usuario_id, cnpj_enc, cnpj_idx, capacidade_refrigerada_kg, capacidade_seca_kg, validade_documentacao, comprovante) VALUES (?,?,?,?,?,?,?)',
      uid, cifrar(cnpj), indice(cnpj), refrig, seca, validade.toISOString().slice(0, 10), arquivo);
    return uid;
  });
  finalizarCadastro(id, 'OSC');
  return { id, statusCadastro: 'PENDENTE', mensagem: 'Cadastro recebido e aguardando análise do gestor.' };
});

route('POST', '/api/cadastro/transportador', { publica: true }, ({ body }) => {
  const d = dadosComuns(body, 'TRANSPORTADOR');
  const cpf = soDigitos(exigir.texto(body, 'cpf', 'o CPF', { max: 20 }));
  if (!cpfValido(cpf)) throw new HttpError(400, 'CPF inválido.', 'CPF_INVALIDO');
  if (get('SELECT 1 FROM transportadores WHERE cpf_idx=?', indice(cpf))) throw new HttpError(409, 'Já existe um cadastro com este CPF.', 'CPF_DUPLICADO');
  const veiculo = exigir.enum(body, 'tipoVeiculo', 'Meio de transporte', Object.keys(veiculos));
  const disponibilidade = exigir.texto(body, 'disponibilidade', 'a disponibilidade de horário', { max: 200 });
  const id = tx(() => {
    const uid = inserirUsuario(d);
    run('INSERT INTO transportadores (usuario_id, cpf_enc, cpf_idx, tipo_veiculo, disponibilidade) VALUES (?,?,?,?,?)', uid, cifrar(cpf), indice(cpf), veiculo, disponibilidade);
    return uid;
  });
  finalizarCadastro(id, 'TRANSPORTADOR');
  return { id, statusCadastro: 'PENDENTE', mensagem: 'Cadastro recebido e aguardando validação.' };
});

// ---------- análise de cadastros (UC04, UC05) - RN23: apenas gestores ----------
const G = { perfis: ['GESTOR'] };

route('GET', '/api/gestor/cadastros', G, ({ query }) => {
  const status = query.status || 'PENDENTE';
  const linhas = all("SELECT id FROM usuarios WHERE tipo<>'GESTOR' AND (?='TODOS' OR status_cadastro=?) ORDER BY criado_em DESC LIMIT 200", status, status);
  return { cadastros: linhas.map((l) => perfilCompleto(l.id)) };
});

route('GET', '/api/gestor/cadastros/:id', G, ({ params }) => {
  const p = perfilCompleto(Number(params.id));
  if (!p || p.tipo === 'GESTOR') throw new HttpError(404, 'Cadastro não encontrado.', 'NAO_ENCONTRADO');
  return { cadastro: p };
});

function alterarStatus(id, novo, autorId, justificativa) {
  const u = get('SELECT status_cadastro, tipo FROM usuarios WHERE id=?', id);
  if (!u || u.tipo === 'GESTOR') throw new HttpError(404, 'Cadastro não encontrado.', 'NAO_ENCONTRADO');
  run('UPDATE usuarios SET status_cadastro=?, motivo_status=? WHERE id=?', novo, justificativa, id);
  registrar({ autorId, entidade: 'usuario', entidadeId: id, acao: 'STATUS_CADASTRO', de: u.status_cadastro, para: novo, justificativa });
  return u;
}

route('POST', '/api/gestor/cadastros/:id/aprovar', G, ({ params, user }) => {
  const id = Number(params.id);
  const u = get('SELECT status_cadastro FROM usuarios WHERE id=?', id);
  if (!u || u.status_cadastro !== 'PENDENTE') throw new HttpError(409, 'Só é possível aprovar cadastros pendentes.', 'STATUS_INVALIDO');
  alterarStatus(id, 'APROVADO', user.id, null);
  notificar(id, 'CADASTRO', 'Seu cadastro foi aprovado. Você já pode usar a plataforma.');
});

route('POST', '/api/gestor/cadastros/:id/rejeitar', G, ({ params, body, user }) => {
  const id = Number(params.id);
  const motivo = exigir.texto(body, 'motivo', 'o motivo da rejeição', { max: 500 });
  const u = get('SELECT status_cadastro FROM usuarios WHERE id=?', id);
  if (!u || u.status_cadastro !== 'PENDENTE') throw new HttpError(409, 'Só é possível rejeitar cadastros pendentes.', 'STATUS_INVALIDO');
  alterarStatus(id, 'REJEITADO', user.id, motivo);
  notificar(id, 'CADASTRO', `Seu cadastro foi rejeitado: ${motivo}. Corrija os dados no perfil para uma nova análise.`);
});

// Importado de reservas/ofertas via injeção para evitar ciclos: cancela reservas em aberto
let aoSuspender = () => {};
export const definirAoSuspender = (fn) => { aoSuspender = fn; };

route('POST', '/api/gestor/cadastros/:id/suspender', G, ({ params, body, user }) => {
  const id = Number(params.id);
  const justificativa = exigir.texto(body, 'justificativa', 'a justificativa da suspensão', { max: 500 }); // UC05 2a
  tx(() => {
    const u = alterarStatus(id, 'SUSPENSO', user.id, justificativa);
    if (u.status_cadastro === 'SUSPENSO') throw new HttpError(409, 'Cadastro já está suspenso.', 'STATUS_INVALIDO');
    aoSuspender(id, u.tipo, user.id);
  });
  notificar(id, 'CADASTRO', `Seu cadastro foi suspenso: ${justificativa}`);
});

route('POST', '/api/gestor/cadastros/:id/reativar', G, ({ params, body, user }) => {
  const id = Number(params.id);
  const justificativa = exigir.texto(body, 'justificativa', 'a justificativa', { max: 500 });
  const u = get('SELECT status_cadastro FROM usuarios WHERE id=?', id);
  if (!u || u.status_cadastro !== 'SUSPENSO') throw new HttpError(409, 'Só é possível reativar cadastros suspensos.', 'STATUS_INVALIDO');
  alterarStatus(id, 'APROVADO', user.id, justificativa);
  notificar(id, 'CADASTRO', 'Seu cadastro foi reativado.');
});

// ---------- perfil (UC06) ----------
route('PATCH', '/api/perfil', ({ user, body }) => {
  const atual = perfilCompleto(user.id);
  const campos = {};
  let institucional = false;
  if (body.nome !== undefined) campos.nome = exigir.texto(body, 'nome', 'o nome', { max: 200 });
  if (body.telefone !== undefined) campos.telefone_enc = cifrar(exigir.texto(body, 'telefone', 'o telefone', { max: 30 }));
  if (body.endereco !== undefined) campos.endereco_enc = cifrar(exigir.texto(body, 'endereco', 'o endereço', { max: 300 }));
  if (body.latitude !== undefined || body.longitude !== undefined) {
    const c = exigir.coordenadas({ latitude: body.latitude ?? atual.latitude, longitude: body.longitude ?? atual.longitude });
    campos.latitude = c.latitude; campos.longitude = c.longitude;
  }
  if (body.email !== undefined) {
    const email = exigir.texto(body, 'email', 'o e-mail', { max: 200 }).toLowerCase();
    if (!emailValido(email)) throw new HttpError(400, 'E-mail inválido.', 'EMAIL_INVALIDO');
    const outro = get('SELECT id FROM usuarios WHERE email_idx=?', indice(email));
    if (outro && outro.id !== user.id) throw new HttpError(409, 'Já existe um cadastro com este e-mail.', 'EMAIL_DUPLICADO');
    campos.email_enc = cifrar(email); campos.email_idx = indice(email);
  }

  const especificos = [];
  if (user.tipo === 'ESTABELECIMENTO') {
    if (body.ramo !== undefined) especificos.push(['UPDATE estabelecimentos SET ramo=? WHERE usuario_id=?', exigir.opcional(body, 'ramo', 80)]);
    if (body.cnpj !== undefined && soDigitos(body.cnpj) !== soDigitos(atual.cnpj)) {
      const cnpj = validarCnpjCadastro(body);
      especificos.push(['UPDATE estabelecimentos SET cnpj_enc=?, cnpj_idx=? WHERE usuario_id=?', cifrar(cnpj), indice(cnpj)]);
      institucional = true; // RN17 (UC06 3b)
    }
  } else if (user.tipo === 'OSC') {
    if (body.capacidadeRefrigeradaKg !== undefined) especificos.push(['UPDATE oscs SET capacidade_refrigerada_kg=? WHERE usuario_id=?', exigir.numero(body, 'capacidadeRefrigeradaKg', 'Capacidade refrigerada', { min: 0, max: 1e6 })]);
    if (body.capacidadeSecaKg !== undefined) especificos.push(['UPDATE oscs SET capacidade_seca_kg=? WHERE usuario_id=?', exigir.numero(body, 'capacidadeSecaKg', 'Capacidade seca', { min: 0, max: 1e6 })]);
    if (body.cnpj !== undefined && soDigitos(body.cnpj) !== soDigitos(atual.cnpj)) {
      const cnpj = validarCnpjCadastro(body);
      especificos.push(['UPDATE oscs SET cnpj_enc=?, cnpj_idx=? WHERE usuario_id=?', cifrar(cnpj), indice(cnpj)]);
      institucional = true;
    }
    if (body.comprovante) {
      const validade = exigir.data(body, 'validadeDocumentacao', 'Validade da documentação');
      if (validade < agora()) throw new HttpError(400, 'A documentação enviada está vencida.', 'DOCUMENTACAO_VENCIDA');
      especificos.push(['UPDATE oscs SET comprovante=?, validade_documentacao=? WHERE usuario_id=?', salvarDataUrl(body.comprovante, 'documento'), validade.toISOString().slice(0, 10)]);
      institucional = true;
    }
  } else if (user.tipo === 'TRANSPORTADOR') {
    if (body.disponibilidade !== undefined) especificos.push(['UPDATE transportadores SET disponibilidade=? WHERE usuario_id=?', exigir.texto(body, 'disponibilidade', 'a disponibilidade', { max: 200 })]);
    if (body.tipoVeiculo !== undefined) especificos.push(['UPDATE transportadores SET tipo_veiculo=? WHERE usuario_id=?', exigir.enum(body, 'tipoVeiculo', 'Meio de transporte', Object.keys(veiculos))]);
  }

  tx(() => {
    const chaves = Object.keys(campos);
    if (chaves.length) run(`UPDATE usuarios SET ${chaves.map((c) => `${c}=?`).join(', ')} WHERE id=?`, ...chaves.map((c) => campos[c]), user.id);
    for (const [sql, ...p] of especificos) run(sql, ...p, user.id);
    // Rejeitados que corrigem dados, e mudanças institucionais, voltam para análise
    const reanalisar = (institucional && user.statusCadastro === 'APROVADO') || user.statusCadastro === 'REJEITADO';
    if (reanalisar && user.tipo !== 'GESTOR') {
      run("UPDATE usuarios SET status_cadastro='PENDENTE', motivo_status=NULL WHERE id=?", user.id);
      notificarGestores('CADASTRO', `${user.nome} atualizou dados institucionais e aguarda nova análise.`, { referencia: `usuario:${user.id}` });
    }
    registrar({ autorId: user.id, entidade: 'usuario', entidadeId: user.id, acao: 'ATUALIZAR_DADOS', justificativa: Object.keys(body).join(',') });
  });
  return { usuario: perfilCompleto(user.id) };
});

// ---------- recuperação de senha (UC07) ----------
route('POST', '/api/senha/esqueci', { publica: true }, ({ body, req }) => {
  const email = exigir.texto(body, 'email', 'o e-mail', { max: 200 }).toLowerCase();
  limitar(`senha|${ipDe(req)}`);
  const u = get('SELECT id FROM usuarios WHERE email_idx=?', indice(email));
  if (u) {
    const token = tokenAleatorio();
    run('INSERT INTO tokens_recuperacao (usuario_id, token_hash, expira_em) VALUES (?,?,?)', u.id, sha256(token), iso(new Date(agora().getTime() + config.regras.tokenSenhaMinutos * 60e3)));
    const link = `/#/redefinir?token=${token}`;
    enviarEmailParaEndereco(email, 'Colheita Urbana - redefinição de senha', `Use o link para criar uma nova senha (válido por ${config.regras.tokenSenhaMinutos} minutos): ${link}`);
  }
  // Mesma resposta exista ou não o e-mail (UC07 2a)
  return { mensagem: 'Se o e-mail estiver cadastrado, enviamos um link para redefinir a senha.' };
});

route('POST', '/api/senha/redefinir', { publica: true }, ({ body }) => {
  const token = exigir.texto(body, 'token', 'o token', { max: 200 });
  const senha = exigir.texto(body, 'senha', 'a nova senha', { max: 200 });
  if (!senhaForte(senha)) throw new HttpError(400, 'A senha deve ter ao menos 8 caracteres, com letras e números.', 'SENHA_FRACA');
  const t = get('SELECT * FROM tokens_recuperacao WHERE token_hash=?', sha256(token));
  if (!t || t.utilizado || t.expira_em < iso()) throw new HttpError(400, 'Link vencido ou já utilizado. Solicite um novo.', 'TOKEN_INVALIDO'); // UC07 4a
  tx(() => {
    run('UPDATE usuarios SET senha_hash=? WHERE id=?', hashSenha(senha), t.usuario_id);
    run('UPDATE tokens_recuperacao SET utilizado=1 WHERE id=?', t.id);
    run('DELETE FROM sessoes WHERE usuario_id=?', t.usuario_id);
    registrar({ autorId: t.usuario_id, entidade: 'usuario', entidadeId: t.usuario_id, acao: 'REDEFINIR_SENHA' });
  });
  return { mensagem: 'Senha alterada. Faça login com a nova senha.' };
});

// ---------- arquivos enviados (somente usuários autenticados) ----------
import { caminhoUpload } from '../lib/files.js';
import { mimeDe } from '../lib/http.js';
import { createReadStream } from 'node:fs';
// Quem pode abrir cada arquivo: fotos de oferta (qualquer usuário logado, pois as OSCs navegam pelas ofertas);
// comprovante da OSC (a própria e o gestor); evidências (partes da entrega e gestor);
// anexos de chamado (autor e gestor); anexos de feedback anônimo (só gestor). Qualquer outro caso: negado.
function podeVerArquivo(nome, user) {
  if (get('SELECT 1 FROM imagens_oferta WHERE arquivo=?', nome)) return true;
  if (user.tipo === 'GESTOR') return true;
  if (get('SELECT 1 FROM oscs WHERE comprovante=? AND usuario_id=?', nome, user.id)) return true;
  if (get(`SELECT 1 FROM ocorrencias oc JOIN coletas c ON c.id=oc.coleta_id JOIN reservas r ON r.id=c.reserva_id JOIN ofertas o ON o.id=r.oferta_id
           WHERE oc.evidencia=? AND (r.osc_id=? OR o.estabelecimento_id=? OR c.transportador_id=?)`, nome, user.id, user.id, user.id)) return true;
  if (get('SELECT 1 FROM chamados WHERE anexo=? AND usuario_id=?', nome, user.id)) return true;
  return false;
}

route('GET', '/api/arquivos/:nome', ({ params, res, user }) => {
  if (!podeVerArquivo(params.nome, user)) throw new HttpError(403, 'Sem acesso a este arquivo.', 'SEM_PERMISSAO');
  const p = caminhoUpload(params.nome);
  res.writeHead(200, { 'Content-Type': mimeDe(p), 'Cache-Control': 'private, max-age=3600' });
  createReadStream(p).pipe(res);
});
