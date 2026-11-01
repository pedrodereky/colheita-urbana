// Relógio injetável: permite testar janelas de retirada e jobs sem esperar.
let deslocamento = null;
export const agora = () => (deslocamento ? new Date(deslocamento) : new Date());
export const iso = (d = agora()) => d.toISOString();
export const definirAgora = (d) => { deslocamento = d ? new Date(d).getTime() : null; };
export const somarHoras = (d, h) => new Date(new Date(d).getTime() + h * 3600e3);
export const horasEntre = (a, b) => (new Date(b) - new Date(a)) / 3600e3;
