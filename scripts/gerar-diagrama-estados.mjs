// Gera docs/diagrama-estados.drawio e docs/diagrama-estados.md (Mermaid) a partir da tabela abaixo.
// Mantenha esta lista alinhada a server/domain/estados.js.
import { writeFileSync } from 'node:fs';

const estados = {
  DISPONIVEL: [40, 180], RESERVADA: [280, 180], EM_COLETA: [520, 180], EM_TRANSPORTE: [760, 180], ENTREGUE: [1000, 180], AVALIADA: [1240, 180],
  CANCELADA: [160, 400], EXPIRADA: [400, 400], RECUSADA: [880, 400],
};
const rot = { DISPONIVEL: 'Disponível', RESERVADA: 'Reservada', EM_COLETA: 'Em coleta', EM_TRANSPORTE: 'Em transporte', ENTREGUE: 'Entregue', AVALIADA: 'Avaliada', CANCELADA: 'Cancelada', EXPIRADA: 'Expirada', RECUSADA: 'Recusada' };
// [origem, destino, evento, estilo de saída/entrada]
const frente = 'exitX=1;exitY=0.3;entryX=0;entryY=0.3;';
const volta = 'exitX=0;exitY=0.8;entryX=1;entryY=0.8;';
const baixo = (x) => `exitX=${x};exitY=1;entryX=0.5;entryY=0;`;
const T = [
  ['DISPONIVEL', 'RESERVADA', 'OSC reserva (RF09, RN19)', frente],
  ['RESERVADA', 'DISPONIVEL', 'janela vencida (RF10) / OSC cancela', volta],
  ['RESERVADA', 'EM_COLETA', 'voluntário aceita (RN02, RN10) / transporte próprio (RN25)', frente],
  ['EM_COLETA', 'RESERVADA', 'voluntário desiste (RN29)', volta],
  ['EM_COLETA', 'EM_TRANSPORTE', 'coleta registrada (RF13)', frente],
  ['EM_TRANSPORTE', 'ENTREGUE', 'OSC confirma recebimento (RN33)', frente],
  ['ENTREGUE', 'AVALIADA', 'OSC avalia a doação (RN07, RF16)', frente],
  ['EM_TRANSPORTE', 'RECUSADA', 'OSC recusa (RN24)', baixo(0.5)],
  ['DISPONIVEL', 'CANCELADA', 'estabelecimento cancela (RN30)', baixo(0.5)],
  ['DISPONIVEL', 'EXPIRADA', 'validade ou janela vencida', baixo(0.8)],
];

let id = 2; const celulas = [];
const ids = {};
for (const [k, [x, y]] of Object.entries(estados)) {
  const final = ['AVALIADA', 'CANCELADA', 'EXPIRADA', 'RECUSADA'].includes(k);
  ids[k] = ++id;
  celulas.push(`<mxCell id="${id}" value="${rot[k]}${final ? '&#xa;(final)' : ''}" style="rounded=1;whiteSpace=wrap;html=1;arcSize=30;fillColor=${final ? '#f8cecc' : '#d5e8d4'};strokeColor=#333333;fontSize=14;fontStyle=1" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="150" height="70" as="geometry"/></mxCell>`);
}
const inicio = ++id;
celulas.push(`<mxCell id="${inicio}" value="" style="ellipse;fillColor=#000000;strokeColor=#000000;" vertex="1" parent="1"><mxGeometry x="-30" y="205" width="20" height="20" as="geometry"/></mxCell>`);
celulas.push(`<mxCell id="${++id}" value="publicar oferta (RF05, RN06, RN16)" style="endArrow=block;html=1;edgeStyle=orthogonalEdgeStyle;fontSize=11;" edge="1" parent="1" source="${inicio}" target="${ids.DISPONIVEL}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
for (const [a, b, ev, est] of T) {
  celulas.push(`<mxCell id="${++id}" value="${ev.replace(/&/g, '&amp;')}" style="endArrow=block;html=1;edgeStyle=orthogonalEdgeStyle;rounded=1;fontSize=11;labelBackgroundColor=#ffffff;${est}" edge="1" parent="1" source="${ids[a]}" target="${ids[b]}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
}
celulas.push(`<mxCell id="${++id}" value="Qualquer estado ativo (Disponível, Reservada, Em coleta) → Cancelada quando o gestor suspende o cadastro (UC05); Reservada e Em coleta → Expirada quando a validade vence antes de uma nova tentativa (UC18). Toda transição é validada em estados.js e gravada na auditoria (RNF07)." style="text;html=1;whiteSpace=wrap;fontSize=12;align=left;" vertex="1" parent="1"><mxGeometry x="560" y="400" width="520" height="90" as="geometry"/></mxCell>`);
celulas.push(`<mxCell id="${++id}" value="Diagrama de Estados — Oferta / Doação (EstadoOferta)" style="text;html=1;fontSize=18;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="40" y="60" width="600" height="30" as="geometry"/></mxCell>`);

const xml = `<mxfile host="app.diagrams.net"><diagram name="3 - Estados (Oferta)" id="estados-oferta"><mxGraphModel dx="1400" dy="800" grid="1" gridSize="10" page="1" pageWidth="1500" pageHeight="700"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${celulas.join('')}</root></mxGraphModel></diagram></mxfile>`;
writeFileSync('docs/diagrama-estados.drawio', xml);

const md = ['# Diagrama de estados da oferta (EstadoOferta)', '', '```mermaid', 'stateDiagram-v2', '  [*] --> DISPONIVEL: publicar oferta (RF05)',
  ...T.map(([a, b, ev]) => `  ${a} --> ${b}: ${ev.replace(/[()]/g, '')}`), '  AVALIADA --> [*]', '  CANCELADA --> [*]', '  EXPIRADA --> [*]', '  RECUSADA --> [*]', '```', ''].join('\n');
writeFileSync('docs/diagrama-estados.md', md);
console.log('gerado: docs/diagrama-estados.drawio, docs/diagrama-estados.md');
