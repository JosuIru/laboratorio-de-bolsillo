import type { PlanePoint } from '@/processing/localization/multilateration';

export const soundLocatorInstrumentId = 'sound-locator';

export const minimumReceiverCount = 3;
export const maximumReceiverCount = 6;
export const receiverLabels: readonly string[] = ['A', 'B', 'C', 'D', 'E', 'F'];

export type LayoutPreset = 'triangle' | 'square';
export const layoutPresets: readonly LayoutPreset[] = ['triangle', 'square'];

/** Posiciones estándar (m): triángulo equilátero y cuadrado de 2 m de lado. */
export const layoutPresetPositions: Record<LayoutPreset, readonly PlanePoint[]> = {
  triangle: [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 1, y: Math.round(Math.sqrt(3) * 1000) / 1000 },
  ],
  square: [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ],
};

/**
 * Incertidumbre supuesta de cada medida, antes de ver los residuos:
 * - comienzo de la palmada en móviles distintos (micrófonos y orientaciones diferentes): ~0,15 ms;
 * - posición del micrófono de cada móvil medida con cinta: ~3 cm.
 */
export const onsetTimingStandardDeviationSeconds = 0.00015;
export const receiverPositionStandardDeviationMeters = 0.03;

export function rangeStandardDeviationMeters(speedOfSoundMetersPerSecond: number): number {
  return Math.hypot(speedOfSoundMetersPerSecond * onsetTimingStandardDeviationSeconds, receiverPositionStandardDeviationMeters);
}

/** Tamaño del bloque del micrófono. */
export const recorderBufferLength = 2048;
/** Un hueco mayor que esto entre bloques del micrófono invalida la medida en curso. */
export const maximumAudioGapSeconds = 0.1;

export const minimumTemperatureCelsius = -10;
export const maximumTemperatureCelsius = 40;
export const defaultTemperatureCelsius = 20;

export function clampTemperatureCelsius(temperatureCelsius: number): number {
  return Math.min(maximumTemperatureCelsius, Math.max(minimumTemperatureCelsius, Math.round(temperatureCelsius)));
}
