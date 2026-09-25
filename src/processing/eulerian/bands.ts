import type { PixelCombination } from './dominantFrequency';

/**
 * Bandas de la amplificación euleriana y cómo se procesa cada una. Valores de partida de Wu et
 * al. (2012) adaptados a una rejilla pequeña: el pulso es un cambio de color en toda la piel
 * (nivel muy grueso, α grande); la respiración y la vibración son movimientos (nivel más fino,
 * luminancia, α moderado para no amplificar el ruido).
 */

export type MagnificationBandId = 'pulse' | 'breathing' | 'vibration';

/** Qué se amplifica: el color (tres canales) o la luminancia (movimiento de los bordes). */
export type AmplifiedSignal = 'color' | 'luminance';

export type FrequencyDisplayUnit = 'beatsPerMinute' | 'breathsPerMinute' | 'hertz';

export interface MagnificationBandPreset {
  id: MagnificationBandId;
  defaultLowCutoffHz: number;
  defaultHighCutoffHz: number;
  amplifiedSignal: AmplifiedSignal;
  /** Pasos REDUCE desde la rejilla base hasta el nivel que se filtra. */
  pyramidReductionCount: number;
  amplificationChoices: readonly number[];
  defaultAmplification: number;
  /** Tope de lo que se suma a cada píxel, en niveles de 0-255. */
  maximumAddedLevels: number;
  /** Segundos de historia para la medida de frecuencia. */
  measurementWindowSeconds: number;
  pixelCombination: PixelCombination;
  displayUnit: FrequencyDisplayUnit;
}

export const magnificationBandPresets: Record<MagnificationBandId, MagnificationBandPreset> = {
  pulse: {
    id: 'pulse',
    defaultLowCutoffHz: 0.8,
    defaultHighCutoffHz: 3,
    amplifiedSignal: 'color',
    pyramidReductionCount: 2,
    amplificationChoices: [25, 50, 100, 150],
    defaultAmplification: 100,
    maximumAddedLevels: 60,
    measurementWindowSeconds: 12,
    pixelCombination: 'coherent',
    displayUnit: 'beatsPerMinute',
  },
  breathing: {
    id: 'breathing',
    defaultLowCutoffHz: 0.1,
    defaultHighCutoffHz: 0.7,
    amplifiedSignal: 'luminance',
    pyramidReductionCount: 1,
    amplificationChoices: [5, 10, 20, 40],
    defaultAmplification: 20,
    maximumAddedLevels: 80,
    measurementWindowSeconds: 30,
    pixelCombination: 'incoherent',
    displayUnit: 'breathsPerMinute',
  },
  vibration: {
    id: 'vibration',
    defaultLowCutoffHz: 2,
    defaultHighCutoffHz: 8,
    amplifiedSignal: 'luminance',
    pyramidReductionCount: 1,
    amplificationChoices: [5, 10, 20, 40],
    defaultAmplification: 20,
    maximumAddedLevels: 80,
    measurementWindowSeconds: 8,
    pixelCombination: 'incoherent',
    displayUnit: 'hertz',
  },
};

/** Frecuencias de corte elegibles para la banda de vibración (Hz). */
export const vibrationCutoffChoicesHz: readonly number[] = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 14];

/** Frecuencia más alta que se puede filtrar y medir sin aliasing claro: el 45 % de los fotogramas/s. */
export function maximumUsableFrequencyHz(framesPerSecond: number): number {
  return 0.45 * framesPerSecond;
}

/** Pasa una frecuencia a la unidad de la banda: lpm y rpm son ciclos por minuto. */
export function convertFrequencyToDisplayUnit(frequencyHz: number, displayUnit: FrequencyDisplayUnit): number {
  return displayUnit === 'hertz' ? frequencyHz : frequencyHz * 60;
}

/**
 * Banda efectiva: la elegida, con la frecuencia superior limitada por los fotogramas/s. Null
 * si con esa cadencia no cabe ninguna banda útil (la inferior ya supera el límite).
 */
export function resolveEffectiveBand(
  lowCutoffHz: number,
  highCutoffHz: number,
  framesPerSecond: number,
): { lowCutoffHz: number; highCutoffHz: number; isHighCutoffLimited: boolean } | null {
  const frequencyLimitHz = maximumUsableFrequencyHz(framesPerSecond);
  const limitedHighCutoffHz = Math.min(highCutoffHz, frequencyLimitHz);
  if (!(lowCutoffHz > 0) || lowCutoffHz >= limitedHighCutoffHz * 0.9) return null;
  return { lowCutoffHz, highCutoffHz: limitedHighCutoffHz, isHighCutoffLimited: limitedHighCutoffHz < highCutoffHz };
}
