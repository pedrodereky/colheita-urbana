import { h } from './ui.js';

// Mapa Leaflet (empacotado em /vendor). Tiles do OpenStreetMap; se estiverem indisponíveis o mapa continua com marcadores.
const disponivel = () => typeof window.L !== 'undefined';
const POS = [-15.7942, -47.8822]; // Brasília

export function criarMapa({ pequeno = false } = {}) {
  const el = h('div', { class: `mapa${pequeno ? ' pequeno' : ''}`, role: 'img', 'aria-label': 'Mapa' });
  const api = { el, mapa: null, camadas: [] };
  if (!disponivel()) { el.append(h('p', { class: 'vazio' }, 'Mapa indisponível neste dispositivo.')); api.limpar = () => {}; api.marcar = () => {}; api.linha = () => {}; api.ajustar = () => {}; return api; }
  requestAnimationFrame(() => {
    if (!el.isConnected) { setTimeout(() => iniciar(), 50); return; }
    iniciar();
  });
  function iniciar() {
    if (api.mapa) return;
    api.mapa = window.L.map(el, { scrollWheelZoom: false }).setView(POS, 11);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap', referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(api.mapa);
    api.pendentes?.forEach((f) => f());
    setTimeout(() => api.mapa.invalidateSize(), 150);
  }
  const quando = (f) => { if (api.mapa) f(); else (api.pendentes ||= []).push(f); };
  api.limpar = () => quando(() => { api.camadas.forEach((c) => c.remove()); api.camadas = []; });
  api.marcar = (lat, lon, rotulo, cor = '#1b5e20') => quando(() => {
    const m = window.L.circleMarker([lat, lon], { radius: 9, color: '#fff', weight: 2, fillColor: cor, fillOpacity: 1 }).addTo(api.mapa).bindTooltip(rotulo, { permanent: false });
    api.camadas.push(m);
  });
  api.linha = (pontos, cor = '#0d47a1') => quando(() => { api.camadas.push(window.L.polyline(pontos, { color: cor, weight: 4, opacity: 0.8 }).addTo(api.mapa)); });
  api.ajustar = () => quando(() => {
    const pts = api.camadas.map((c) => (c.getLatLng ? [c.getLatLng()] : c.getLatLngs().flat())).flat();
    if (pts.length > 1) api.mapa.fitBounds(window.L.latLngBounds(pts).pad(0.25));
    else if (pts.length === 1) api.mapa.setView(pts[0], 14);
  });
  api.aoClicar = (fn) => quando(() => api.mapa.on('click', (e) => fn(e.latlng.lat, e.latlng.lng)));
  return api;
}
