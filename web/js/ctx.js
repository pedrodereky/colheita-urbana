// Estado compartilhado entre o roteador e as telas
export const sessao = { usuario: null };
let ouvintes = [];
let limpezas = [];
// Registra uma função executada quando o usuário sai da tela atual (ex.: parar o GPS)
export const aoSair = (fn) => { limpezas.push(fn); };
export const limparOuvintes = () => { ouvintes = []; for (const f of limpezas) { try { f(); } catch { /* ignora */ } } limpezas = []; };
// As telas "ouvem" eventos em tempo real (entrega, localizacao, chat, notificacao) enquanto estiverem abertas
export const ouvir = (fn) => { ouvintes.push(fn); };
export const despachar = (evento, dados) => { for (const fn of ouvintes) { try { fn(evento, dados); } catch (e) { console.error(e); } } };
export const ir = (hash) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = hash; };
