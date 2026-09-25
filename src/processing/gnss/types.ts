import type { CarrierBandId, ConstellationId } from './constellations';

/** Un satélite tal como lo ve el receptor en un instante (una señal: satélite + banda). */
export interface SatelliteObservation {
  constellationId: ConstellationId;
  /** Número del satélite dentro de su constelación (PRN, slot, etc.). */
  svid: number;
  bandId: CarrierBandId;
  /** Relación portadora/ruido en dB-Hz. 0 si el satélite está previsto pero no se recibe. */
  carrierToNoiseDensityDbHz: number;
  elevationDegrees: number;
  azimuthDegrees: number;
  isUsedInFix: boolean;
}

/** Clave única de una señal: el mismo satélite en L1 y L5 son dos señales. */
export function signalKey(observation: Pick<SatelliteObservation, 'constellationId' | 'svid' | 'bandId'>): string {
  return `${observation.constellationId}-${observation.svid}-${observation.bandId}`;
}

/** Nivel del control automático de ganancia de una banda (dB). */
export interface AutomaticGainControlReading {
  bandId: CarrierBandId;
  levelDb: number;
}
