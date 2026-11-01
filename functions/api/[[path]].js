import { encaminhar } from '../../cloudflare/encaminhar.js';
export const onRequest = (ctx) => encaminhar(ctx);
