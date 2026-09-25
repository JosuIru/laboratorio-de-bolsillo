import { chooseSonarBand, type SonarBand } from '@/processing/sonar/chirp';
import { type SonarBandPreset, sonarBandPresets } from '@/processing/sonar/hardwareTest';

export const sonarInstrumentId = 'sonar';

/** Duración de cada chirp: 8 ms dan un buen filtro adaptado sin tapar ecos cercanos. */
export const chirpDurationSeconds = 0.008;
/** Un pulso cada 120 ms: los ecos de la sala (a pocos metros) ya se han apagado. */
export const pulsePeriodSeconds = 0.12;
/** Ventana de ecos: 25 ms ≈ 4 m, de sobra para el rango útil. */
export const maximumEchoDelaySeconds = 0.025;
export const minimumRangeMeters = 0.2;
export const maximumRangeMeters = 3;
/** Pulsos que se promedian para el medidor y el ecograma (~0,5 s). */
export const averagedPulseCount = 4;
/** Pulsos que se promedian para grabar el fondo (~2 s). */
export const backgroundPulseCount = 16;

export const echogramColumnCount = 120;
export const echogramRowCount = 90;
export const echogramFloorDecibels = -80;
export const echogramMinimumDecibels = -70;
export const echogramMaximumDecibels = -10;
/** Columnas del perfil que se guardan con cada medición. */
export const savedProfileColumnCount = 60;

export const volumeOptions: readonly number[] = [0.25, 0.5, 0.75, 1];
export const defaultVolume = 0.75;
export const minimumTemperatureCelsius = -10;
export const maximumTemperatureCelsius = 40;
export const defaultTemperatureCelsius = 20;

export function sonarBandFor(sampleRateHz: number, bandPreset: SonarBandPreset): SonarBand {
  const { lowFrequencyHz, highFrequencyHz } = sonarBandPresets[bandPreset];
  return chooseSonarBand(sampleRateHz, lowFrequencyHz, highFrequencyHz);
}

export function clampTemperatureCelsius(temperatureCelsius: number): number {
  return Math.min(maximumTemperatureCelsius, Math.max(minimumTemperatureCelsius, Math.round(temperatureCelsius)));
}
