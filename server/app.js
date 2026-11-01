import { createServer } from 'node:http';
import { route, tratar, json } from './lib/http.js';
import { totalConectados } from './lib/events.js';
import { get } from './db.js';
import './modules/auth.js';
import './modules/ofertas.js';
import './modules/reservas.js';
import './modules/logistica.js';
import './modules/avaliacao.js';
import './modules/historico.js';
import './modules/gestao.js';
import './modules/suporte.js';
import { config } from './config.js';
import { listarOutbox } from './dev.js';

route('GET', '/healthz', { publica: true }, () => { get('SELECT 1'); return { status: 'ok', conectados: totalConectados() }; });
if (!config.producao) listarOutbox();

export const criarServidor = () => createServer((req, res) => { tratar(req, res); });
