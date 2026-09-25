/**
 * Constelaciones y bandas GNSS. Los códigos de constelación son los de
 * `android.location.GnssStatus.CONSTELLATION_*`, que es lo que entrega el módulo nativo.
 */

export type ConstellationId = 'gps' | 'sbas' | 'glonass' | 'qzss' | 'beidou' | 'galileo' | 'navic' | 'unknown';

const constellationIdByAndroidCode: Record<number, ConstellationId> = {
  0: 'unknown',
  1: 'gps',
  2: 'sbas',
  3: 'glonass',
  4: 'qzss',
  5: 'beidou',
  6: 'galileo',
  7: 'navic',
};

/** Orden fijo para listas y leyendas. */
export const constellationDisplayOrder: readonly ConstellationId[] = [
  'gps',
  'galileo',
  'glonass',
  'beidou',
  'qzss',
  'navic',
  'sbas',
  'unknown',
];

/** Abreviatura internacional (no se traduce). */
export const constellationShortLabels: Record<ConstellationId, string> = {
  gps: 'GPS',
  sbas: 'SBAS',
  glonass: 'GLONASS',
  qzss: 'QZSS',
  beidou: 'BeiDou',
  galileo: 'Galileo',
  navic: 'NavIC',
  unknown: '?',
};

export function constellationFromAndroidCode(androidConstellationCode: number): ConstellationId {
  return constellationIdByAndroidCode[androidConstellationCode] ?? 'unknown';
}

/**
 * Banda de la portadora, agrupada como se suele hablar de ella en los móviles:
 * - `L1`: 1575,42 MHz (GPS L1, Galileo E1, BeiDou B1C, QZSS L1, SBAS L1).
 * - `L5`: 1176,45 MHz (GPS L5, Galileo E5a, BeiDou B2a, QZSS L5, NavIC L5).
 * - `G1`: GLONASS L1 FDMA (≈1598–1606 MHz, cada satélite en su canal).
 * - `B1I`: BeiDou B1I (1561,098 MHz).
 * - `L2`, `E5b`, `E6`: menos comunes en móviles.
 */
export type CarrierBandId = 'L1' | 'L5' | 'G1' | 'B1I' | 'L2' | 'E5b' | 'E6' | 'unknown';

interface BandDefinition {
  bandId: CarrierBandId;
  centerFrequencyHz: number;
  toleranceHz: number;
}

const megahertz = 1e6;

const bandDefinitions: readonly BandDefinition[] = [
  { bandId: 'L1', centerFrequencyHz: 1575.42 * megahertz, toleranceHz: 2.5 * megahertz },
  { bandId: 'L5', centerFrequencyHz: 1176.45 * megahertz, toleranceHz: 2.5 * megahertz },
  { bandId: 'B1I', centerFrequencyHz: 1561.098 * megahertz, toleranceHz: 2.5 * megahertz },
  // GLONASS FDMA: canales k = −7…+6, 1602 + k·0,5625 MHz → 1598,06–1605,38 MHz.
  { bandId: 'G1', centerFrequencyHz: 1601.72 * megahertz, toleranceHz: 4.5 * megahertz },
  { bandId: 'L2', centerFrequencyHz: 1227.6 * megahertz, toleranceHz: 2.5 * megahertz },
  { bandId: 'E5b', centerFrequencyHz: 1207.14 * megahertz, toleranceHz: 2.5 * megahertz },
  { bandId: 'E6', centerFrequencyHz: 1278.75 * megahertz, toleranceHz: 2.5 * megahertz },
];

/**
 * Clasifica la frecuencia portadora en una banda. Si el chip no informa de la frecuencia
 * (`null`), asume la banda por defecto de la constelación (todos los chips hacen al menos L1).
 */
export function classifyCarrierBand(constellationId: ConstellationId, carrierFrequencyHz: number | null): CarrierBandId {
  if (carrierFrequencyHz === null || !Number.isFinite(carrierFrequencyHz) || carrierFrequencyHz <= 0) {
    if (constellationId === 'glonass') return 'G1';
    if (constellationId === 'unknown') return 'unknown';
    return 'L1';
  }
  for (const bandDefinition of bandDefinitions) {
    if (Math.abs(carrierFrequencyHz - bandDefinition.centerFrequencyHz) <= bandDefinition.toleranceHz) {
      return bandDefinition.bandId;
    }
  }
  return 'unknown';
}

/** Bandas «altas» (familia L1) y «bajas» (familia L5 y vecinas), para hablar de doble frecuencia. */
export function isLowerBand(bandId: CarrierBandId): boolean {
  return bandId === 'L5' || bandId === 'L2' || bandId === 'E5b' || bandId === 'E6';
}

export const carrierBandDisplayOrder: readonly CarrierBandId[] = ['L1', 'G1', 'B1I', 'L5', 'L2', 'E5b', 'E6', 'unknown'];
