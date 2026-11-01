import { config } from '../config.js';

// Serviço de Mapas (RNF10). Provedor "local" estima por linha reta; "osrm" usa rotas reais.
// Se o provedor externo falhar, lança erro e quem chama aplica o fluxo alternativo (UC14 2a / UC20 2a).
const R = 6371;
const rad = (g) => (g * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const estimarMinutos = (km) => Math.round((km / config.regras.velocidadeMediaKmh) * 60);

let falhaForcada = false; // usado em testes
export const simularFalhaMapas = (v) => { falhaForcada = v; };

export async function rota(origem, destino) {
  if (falhaForcada) throw new Error('Serviço de mapas indisponível');
  if (config.mapas.provedor === 'osrm') {
    const url = `${config.mapas.osrmUrl}/route/v1/driving/${origem.longitude},${origem.latitude};${destino.longitude},${destino.latitude}?overview=simplified&geometries=geojson`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`OSRM ${r.status}`);
    const j = await r.json();
    const rt = j.routes?.[0];
    if (!rt) throw new Error('OSRM sem rota');
    return {
      distanciaKm: rt.distance / 1000, minutos: Math.round(rt.duration / 60),
      caminho: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon]), provedor: 'osrm',
    };
  }
  const km = haversineKm(origem, destino) * config.regras.fatorRota;
  return {
    distanciaKm: km, minutos: estimarMinutos(km),
    caminho: [[origem.latitude, origem.longitude], [destino.latitude, destino.longitude]], provedor: 'estimativa',
  };
}

// Só distância/tempo (sem geometria) - usado na listagem de ofertas
export async function distancia(origem, destino) {
  const r = await rota(origem, destino);
  return { distanciaKm: r.distanciaKm, minutos: r.minutos };
}
