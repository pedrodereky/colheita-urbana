import { criarServidor } from './app.js';
import { iniciarAgendador } from './modules/jobs.js';
import { config } from './config.js';

const servidor = criarServidor();
servidor.listen(config.porta, () => {
  console.log(`Colheita Urbana em http://localhost:${config.porta}  (${config.producao ? 'produção' : 'desenvolvimento'})`);
  iniciarAgendador();
});
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => servidor.close(() => process.exit(0)));
