// Gerador mínimo de PDF (texto, Helvetica, A4) sem dependências. Suficiente para recibos e relatórios.
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function gerarPdf({ titulo, linhas }) {
  const paginas = [];
  let atual = [];
  const MAX = 46;
  const todas = [{ t: titulo, tam: 16 }, { t: '', tam: 10 }, ...linhas.map((t) => ({ t, tam: 11 }))];
  for (const l of todas) {
    if (atual.length >= MAX) { paginas.push(atual); atual = []; }
    atual.push(l);
  }
  paginas.push(atual);

  const objs = [];
  const add = (c) => { objs.push(c); return objs.length; };
  const catalogo = add('');   // 1
  const arvore = add('');     // 2
  const fonte = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  const kids = [];
  for (const pg of paginas) {
    let y = 800;
    let conteudo = 'BT\n';
    for (const { t, tam } of pg) {
      conteudo += `/F1 ${tam} Tf 1 0 0 1 50 ${y} Tm (${esc(t.slice(0, 95))}) Tj\n`;
      y -= tam + 6;
    }
    conteudo += 'ET';
    const buf = Buffer.from(conteudo, 'latin1');
    const c = add(`<< /Length ${buf.length} >>\nstream\n${buf.toString('latin1')}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${arvore} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fonte} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalogo - 1] = `<< /Type /Catalog /Pages ${arvore} 0 R >>`;
  objs[arvore - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
