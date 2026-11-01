import { api, GET, POST } from '../api.js';
import { h, campo, entrada, selecao, lerArquivo, aviso, botao, acao, erroBox, fmtData, fmtKg, montar } from '../ui.js';
import { sessao, ir } from '../ctx.js';
import { criarMapa } from '../mapa.js';

export const VEICULOS = [['BICICLETA', 'Bicicleta (até 15 kg)'], ['MOTO', 'Moto (até 30 kg)'], ['CARRO', 'Carro (até 200 kg)'], ['VAN', 'Van / utilitário (até 800 kg)'], ['CAMINHAO', 'Caminhão (até 5 t)']];
export const lerForm = (f) => Object.fromEntries(new FormData(f));

export function login() {
  const erro = h('div');
  const form = h('form', { class: 'cartao centro', novalidate: true },
    h('h1', null, 'Entrar'),
    campo('E-mail', entrada('email', { type: 'email', autocomplete: 'username', required: true })),
    campo('Senha', entrada('senha', { type: 'password', autocomplete: 'current-password', required: true })),
    erro,
    h('button', { class: 'botao grande', type: 'submit' }, 'Entrar'),
    h('p', { class: 'pequeno' }, h('a', { href: '#/esqueci' }, 'Esqueci minha senha')),
    h('hr'),
    h('p', null, 'Ainda não tem conta? ', h('a', { href: '#/cadastro' }, 'Cadastre-se')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true; montar(erro);
    try {
      const { usuario } = await POST('/api/login', lerForm(form));
      sessao.usuario = usuario; window.dispatchEvent(new Event('cu:login')); ir('#/');
    } catch (e) { montar(erro, erroBox(e)); } finally { btn.disabled = false; }
  });
  return h('div', null,
    h('div', { class: 'hero' }, h('h1', null, 'Nenhum alimento perdido, ninguém com fome.'),
      h('p', null, 'A Colheita Urbana conecta supermercados, padarias e restaurantes com organizações que atendem quem mais precisa.')),
    form,
    location.hostname === 'localhost' ? h('p', { class: 'centro pequeno suave' }, 'Ambiente local: após ', h('code', null, 'npm run seed'), ' use gestor@colheita.local, mercado@colheita.local, osc1@colheita.local ou voluntario1@colheita.local (senha Senha@123).') : null);
}

export function escolherCadastro() {
  const card = (tipo, emoji, titulo, texto) => h('a', { class: 'cartao', href: `#/cadastro/${tipo}`, style: 'text-decoration:none;color:inherit' }, h('div', { style: 'font-size:2.2rem' }, emoji), h('h3', null, titulo), h('p', { class: 'suave' }, texto));
  return h('div', null, h('h1', null, 'Quero fazer parte'),
    h('p', null, 'Escolha como você vai participar. Todo cadastro passa por uma análise da equipe antes de ser liberado.'),
    h('div', { class: 'grade' },
      card('estabelecimento', '🛒', 'Sou um estabelecimento', 'Supermercado, padaria, restaurante… e quero doar alimentos excedentes.'),
      card('osc', '🤝', 'Sou uma OSC', 'Organização da sociedade civil que recebe e distribui doações.'),
      card('transportador', '🚗', 'Quero ser voluntário', 'Posso buscar alimentos nos doadores e levar até as OSCs.')),
    h('p', { style: 'margin-top:1rem' }, 'Já tem conta? ', h('a', { href: '#/login' }, 'Entrar')));
}

// Seletor de localização: coordenadas editáveis, "usar minha localização" e clique no mapa
function seletorLocalizacao(inicial = { latitude: -15.7942, longitude: -47.8822 }) {
  const lat = entrada('latitude', { type: 'number', step: 'any', required: true, value: inicial.latitude });
  const lon = entrada('longitude', { type: 'number', step: 'any', required: true, value: inicial.longitude });
  const mapa = criarMapa({ pequeno: true });
  const marcar = () => { mapa.limpar?.(); mapa.marcar?.(Number(lat.value), Number(lon.value), 'Seu endereço'); mapa.ajustar?.(); };
  mapa.aoClicar?.((la, lo) => { lat.value = la.toFixed(6); lon.value = lo.toFixed(6); marcar(); });
  setTimeout(marcar, 300);
  lat.addEventListener('change', marcar); lon.addEventListener('change', marcar);
  const usar = botao('📍 Usar minha localização', async () => {
    const pos = await new Promise((ok, no) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(ok, () => no(new Error('Não foi possível obter sua localização.'))) : no(new Error('Seu navegador não oferece localização.')));
    lat.value = pos.coords.latitude.toFixed(6); lon.value = pos.coords.longitude.toFixed(6); marcar();
  }, 'sec mini');
  return h('fieldset', { style: 'border:1px solid var(--borda);border-radius:12px;margin:0 0 .9rem' },
    h('legend', null, 'Localização no mapa'),
    h('p', { class: 'suave pequeno' }, 'Usada para calcular distâncias e rotas. Clique no mapa para ajustar.'),
    mapa.el, h('div', { class: 'form-grade', style: 'margin-top:.6rem' }, campo('Latitude', lat), campo('Longitude', lon)), usar);
}

export function cadastro({ params }) {
  const tipo = params.tipo;
  if (!['estabelecimento', 'osc', 'transportador'].includes(tipo)) return erroBox(new Error('Tipo de cadastro inválido.'));
  const titulos = { estabelecimento: 'Cadastro de estabelecimento', osc: 'Cadastro de OSC', transportador: 'Cadastro de voluntário transportador' };
  const hoje = new Date(); const umAno = new Date(hoje.getFullYear() + 1, hoje.getMonth(), hoje.getDate()).toISOString().slice(0, 10);
  const erro = h('div');
  const termos = h('input', { type: 'checkbox', name: 'termos', id: 'termos', required: true });

  const especificos = {
    estabelecimento: [
      h('div', { class: 'form-grade' }, campo('CNPJ', entrada('cnpj', { required: true, inputmode: 'numeric', placeholder: '00.000.000/0000-00' })),
        campo('Ramo', selecao('ramo', [['Supermercado', 'Supermercado'], ['Padaria', 'Padaria'], ['Restaurante', 'Restaurante'], ['Hortifruti', 'Hortifruti'], ['Outro', 'Outro']]))),
    ],
    osc: [
      campo('CNPJ', entrada('cnpj', { required: true, inputmode: 'numeric', placeholder: '00.000.000/0000-00' })),
      h('div', { class: 'form-grade' },
        campo('Capacidade com refrigeração (kg)', entrada('capacidadeRefrigeradaKg', { type: 'number', min: 0, step: 'any', required: true, value: 0 })),
        campo('Capacidade sem refrigeração (kg)', entrada('capacidadeSecaKg', { type: 'number', min: 0, step: 'any', required: true, value: 0 }))),
      campo('Validade da documentação anual', entrada('validadeDocumentacao', { type: 'date', required: true, value: umAno })),
      campo('Comprovante de regularidade', entrada('comprovante', { type: 'file', accept: 'application/pdf,image/jpeg,image/png', required: true }), 'PDF ou imagem, até 5 MB.'),
    ],
    transportador: [
      campo('CPF', entrada('cpf', { required: true, inputmode: 'numeric', placeholder: '000.000.000-00' })),
      h('div', { class: 'form-grade' }, campo('Meio de transporte', selecao('tipoVeiculo', VEICULOS)), campo('Disponibilidade de horário', entrada('disponibilidade', { required: true, placeholder: 'Ex.: seg a sex, após as 18h' }))),
    ],
  }[tipo];

  const local = seletorLocalizacao();
  const form = h('form', { class: 'cartao', novalidate: true },
    h('h1', null, titulos[tipo]),
    h('div', { class: 'form-grade' }, campo(tipo === 'transportador' ? 'Nome completo' : 'Nome da instituição', entrada('nome', { required: true, autocomplete: 'organization' })), campo('Telefone', entrada('telefone', { type: 'tel', required: true }))),
    h('div', { class: 'form-grade' }, campo('E-mail', entrada('email', { type: 'email', required: true, autocomplete: 'email' })), campo('Senha', entrada('senha', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), 'Mínimo de 8 caracteres, com letras e números.')),
    campo(tipo === 'transportador' ? 'Endereço' : 'Endereço completo', entrada('endereco', { required: true, autocomplete: 'street-address' })),
    ...especificos, local,
    h('div', { class: 'campo' }, h('label', { class: 'check', for: 'termos' }, termos, h('span', null, 'Li e aceito os termos de uso e a política de privacidade (LGPD). Meus dados sensíveis são armazenados criptografados.'))),
    erro,
    h('button', { class: 'botao grande', type: 'submit' }, 'Enviar cadastro'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]'); montar(erro);
    if (!form.reportValidity()) return;
    btn.disabled = true;
    try {
      const dados = lerForm(form);
      dados.termos = termos.checked;
      dados.latitude = Number(dados.latitude); dados.longitude = Number(dados.longitude);
      if (tipo === 'osc') {
        dados.capacidadeRefrigeradaKg = Number(dados.capacidadeRefrigeradaKg); dados.capacidadeSecaKg = Number(dados.capacidadeSecaKg);
        const arq = form.elements.comprovante.files[0];
        dados.comprovante = arq ? await lerArquivo(arq) : null;
      }
      const r = await POST(`/api/cadastro/${tipo}`, dados);
      montar(form.parentElement || form, h('div', { class: 'cartao centro' }, h('h1', null, 'Cadastro enviado! 🎉'), h('div', { class: 'ok' }, r.mensagem), h('p', null, 'Você receberá uma notificação assim que a análise terminar. Enquanto isso já pode entrar para acompanhar o status.'), h('a', { class: 'botao', href: '#/login' }, 'Ir para o login')));
    } catch (e) { montar(erro, erroBox(e)); aviso(e.message, 'erro'); } finally { btn.disabled = false; }
  });
  return h('div', null, h('p', null, h('a', { href: '#/cadastro' }, '← Voltar')), form);
}

export function esqueci() {
  const msg = h('div');
  const form = h('form', { class: 'cartao centro' }, h('h1', null, 'Recuperar senha'),
    h('p', null, 'Informe o e-mail do cadastro. Enviaremos um link temporário para criar uma nova senha.'),
    campo('E-mail', entrada('email', { type: 'email', required: true })), msg,
    h('button', { class: 'botao grande', type: 'submit' }, 'Enviar link'), h('p', null, h('a', { href: '#/login' }, 'Voltar ao login')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { const r = await POST('/api/senha/esqueci', lerForm(form)); montar(msg, h('div', { class: 'ok', role: 'status' }, r.mensagem)); }
    catch (e) { montar(msg, erroBox(e)); }
  });
  return form;
}

export function redefinir({ query }) {
  const msg = h('div');
  const form = h('form', { class: 'cartao centro' }, h('h1', null, 'Criar nova senha'),
    campo('Nova senha', entrada('senha', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), 'Mínimo de 8 caracteres, com letras e números.'), msg,
    h('button', { class: 'botao grande', type: 'submit' }, 'Salvar nova senha'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await POST('/api/senha/redefinir', { token: query.token, senha: form.elements.senha.value }); aviso('Senha alterada. Faça login.', 'ok'); ir('#/login'); }
    catch (e) { montar(msg, erroBox(e)); }
  });
  return form;
}

export async function verificarRecibo({ params }) {
  let corpo;
  try {
    const r = await GET(`/api/verificar-recibo/${encodeURIComponent(params.codigo)}`);
    corpo = h('div', { class: 'cartao centro' }, h('h1', null, '✅ Recibo autêntico'),
      h('p', null, h('b', null, r.numero)), h('p', null, `${r.doador} doou ${fmtKg(r.quantidadeKg)} de ${r.alimento} para ${r.receptora}.`), h('p', { class: 'suave' }, `Emitido em ${fmtData(r.dataEmissao)}`));
  } catch (e) { corpo = h('div', { class: 'cartao centro' }, h('h1', null, 'Recibo não encontrado'), erroBox(e)); }
  return corpo;
}
