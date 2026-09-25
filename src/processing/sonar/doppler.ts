import { frequencyToBin } from '@/processing/dsp/spectrum';

import { speedOfSoundMetersPerSecond } from './soundSpeed';

/**
 * Gestos por efecto Doppler: el altavoz emite un tono continuo y una mano que se acerca lo
 * devuelve un poco más agudo (y más grave si se aleja). En el espectro aparece energía a los
 * lados del tono; su posición media da el desplazamiento y, con él, la velocidad:
 *
 *   Δf ≈ 2·v·f₀ / c   (el 2 es por ida y vuelta)
 */

export interface DopplerShiftOptions {
  sampleRateHz: number;
  fftSize: number;
  carrierFrequencyHz: number;
  /** Hasta dónde se busca a cada lado del tono (±300 Hz ≈ ±2,6 m/s a 20 kHz). */
  maximumShiftHz?: number;
  /** Zona alrededor del tono que se ignora: ahí están el propio tono y su fuga espectral. */
  carrierExclusionHz?: number;
}

export interface DopplerShiftEstimate {
  /** Desplazamiento medio de la energía lateral (positivo = más agudo = acercándose). */
  shiftHz: number;
  /** Energía por encima del ruido a cada lado, relativa a la del tono. */
  upperSidebandRelativePower: number;
  lowerSidebandRelativePower: number;
  carrierAmplitude: number;
}

/**
 * Estima el desplazamiento Doppler a partir de un espectro de amplitud lineal. Resta el suelo
 * de ruido (la mediana de la zona de búsqueda) para que, sin movimiento, el resultado sea 0 en
 * vez de un valor al azar.
 */
export function estimateDopplerShift(
  amplitudeSpectrum: ArrayLike<number>,
  options: DopplerShiftOptions,
): DopplerShiftEstimate {
  const { sampleRateHz, fftSize, carrierFrequencyHz, maximumShiftHz = 300, carrierExclusionHz = 30 } = options;
  const binResolutionHz = sampleRateHz / fftSize;
  const carrierBin = frequencyToBin(carrierFrequencyHz, sampleRateHz, fftSize);
  const exclusionBins = Math.max(1, Math.ceil(carrierExclusionHz / binResolutionHz));
  const searchBins = Math.max(exclusionBins + 1, Math.round(maximumShiftHz / binResolutionHz));
  const lastBin = Math.min(amplitudeSpectrum.length - 1, carrierBin + searchBins);
  const firstBin = Math.max(1, carrierBin - searchBins);

  let carrierAmplitude = 0;
  for (let binIndex = carrierBin - exclusionBins; binIndex <= carrierBin + exclusionBins; binIndex++) {
    carrierAmplitude = Math.max(carrierAmplitude, amplitudeSpectrum[binIndex] ?? 0);
  }

  const sidebandPowers: number[] = [];
  for (let binIndex = firstBin; binIndex <= lastBin; binIndex++) {
    if (Math.abs(binIndex - carrierBin) <= exclusionBins) continue;
    sidebandPowers.push((amplitudeSpectrum[binIndex] ?? 0) ** 2);
  }
  const sortedPowers = [...sidebandPowers].sort((leftPower, rightPower) => leftPower - rightPower);
  const noiseFloorPower = sortedPowers[Math.floor(sortedPowers.length / 2)] ?? 0;

  let upperSidebandPower = 0;
  let lowerSidebandPower = 0;
  let weightedOffsetSumHz = 0;
  for (let binIndex = firstBin; binIndex <= lastBin; binIndex++) {
    const binOffset = binIndex - carrierBin;
    if (Math.abs(binOffset) <= exclusionBins) continue;
    // Solo cuenta lo que destaca claramente del ruido.
    const excessPower = Math.max(0, (amplitudeSpectrum[binIndex] ?? 0) ** 2 - 2 * noiseFloorPower);
    if (binOffset > 0) upperSidebandPower += excessPower;
    else lowerSidebandPower += excessPower;
    weightedOffsetSumHz += excessPower * binOffset * binResolutionHz;
  }
  const totalSidebandPower = upperSidebandPower + lowerSidebandPower;
  const carrierPower = Math.max(carrierAmplitude * carrierAmplitude, 1e-20);
  return {
    shiftHz: totalSidebandPower > 0 ? weightedOffsetSumHz / totalSidebandPower : 0,
    upperSidebandRelativePower: upperSidebandPower / carrierPower,
    lowerSidebandRelativePower: lowerSidebandPower / carrierPower,
    carrierAmplitude,
  };
}

/** Velocidad radial del objeto (positiva = acercándose). */
export function dopplerShiftToVelocityMetersPerSecond(
  shiftHz: number,
  carrierFrequencyHz: number,
  temperatureCelsius: number,
): number {
  return (shiftHz * speedOfSoundMetersPerSecond(temperatureCelsius)) / (2 * carrierFrequencyHz);
}

export type HandGesture = 'approaching' | 'receding' | 'still';

export interface GestureClassifierOptions {
  /** Velocidad mínima para contar como gesto. */
  minimumSpeedMetersPerSecond?: number;
  /** Energía lateral mínima (relativa al tono) para creerse el desplazamiento. */
  minimumSidebandRelativePower?: number;
  /** Tramas seguidas en el mismo sentido para dar el gesto por bueno. */
  confirmationFrameCount?: number;
}

/**
 * Convierte las estimaciones sucesivas en gestos. Pide varias tramas seguidas en el mismo
 * sentido para no parpadear con el ruido.
 */
export function createGestureClassifier(options: GestureClassifierOptions = {}) {
  const {
    minimumSpeedMetersPerSecond = 0.08,
    minimumSidebandRelativePower = 1e-4,
    confirmationFrameCount = 2,
  } = options;
  let candidateGesture: HandGesture = 'still';
  let candidateFrameCount = 0;
  let confirmedGesture: HandGesture = 'still';
  return {
    push(velocityMetersPerSecond: number, sidebandRelativePower: number): HandGesture {
      const isMoving =
        sidebandRelativePower >= minimumSidebandRelativePower &&
        Math.abs(velocityMetersPerSecond) >= minimumSpeedMetersPerSecond;
      const frameGesture: HandGesture = !isMoving ? 'still' : velocityMetersPerSecond > 0 ? 'approaching' : 'receding';
      candidateFrameCount = frameGesture === candidateGesture ? candidateFrameCount + 1 : 1;
      candidateGesture = frameGesture;
      if (candidateFrameCount >= confirmationFrameCount) confirmedGesture = candidateGesture;
      return confirmedGesture;
    },
    reset(): void {
      candidateGesture = 'still';
      candidateFrameCount = 0;
      confirmedGesture = 'still';
    },
  };
}
