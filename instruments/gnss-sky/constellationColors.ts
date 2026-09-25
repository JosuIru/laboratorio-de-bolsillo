import type { ConstellationId } from '@/processing/gnss/constellations';

/** Colores por constelación: distinguibles en tema claro y oscuro. */
export const constellationColors: Record<ConstellationId, string> = {
  gps: '#3B82F6',
  galileo: '#F59E0B',
  glonass: '#EF4444',
  beidou: '#22C55E',
  qzss: '#A855F7',
  navic: '#EC4899',
  sbas: '#94A3B8',
  unknown: '#64748B',
};
