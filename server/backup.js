import { backupDiario } from './modules/jobs.js';
console.log(backupDiario() ? 'Backup criado.' : 'Já existe backup de hoje.');
