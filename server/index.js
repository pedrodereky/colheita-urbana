import { criarServidor } from './app.js';
import { iniciarAgendador } from './modules/jobs.js';
import { config } from './config.js';

// Modo demonstração (ex.: hospedagem gratuita sem disco persistente): recria os dados fictícios
// a cada início com o banco vazio, antes de aceitar conexões.
if (process.env.AUTO_DEMO === '1') {
  const { popularDemo } = await import('./seed.js');
  const { popularDemoCompleto } = await import('./seed-demo.js');
  popularDemo();
  await popularDemoCompleto();
}

const servidor = criarServidor();
servidor.listen(config.porta, () => {
  console.log(`Colheita Urbana em http://localhost:${config.porta}  (${config.producao ? 'produção' : 'desenvolvimento'})`);
  iniciarAgendador();
});
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => servidor.close(() => process.exit(0)));
