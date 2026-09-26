/**
 * Cálculos de nivel sonoro para el registro de ruido. Todo es puro (sin React ni RN).
 *
 * Los decibelios no se promedian ni se suman como números normales: se pasa a energía
 * (10^(L/10)), se opera y se vuelve a dB. Así, 60 dB + 60 dB = 63 dB, y un minuto con 30 s a
 * 70 dB y 30 s a 40 dB tiene un Leq de 67 dB, no de 55.
 */

/** Suelo para no devolver −∞ dB con silencio digital. */
export const minimumLevelDecibels = -160;

export function decibelsToEnergy(levelDecibels: number): number {
  return 10 ** (levelDecibels / 10);
}

export function energyToDecibels(energy: number): number {
  if (!(energy > 0)) return minimumLevelDecibels;
  return Math.max(minimumLevelDecibels, 10 * Math.log10(energy));
}

/** Suma energética: el nivel de varias fuentes sonando a la vez. */
export function energeticSumDecibels(levelsDecibels: ArrayLike<number>): number {
  let energySum = 0;
  for (let levelIndex = 0; levelIndex < levelsDecibels.length; levelIndex++) {
    energySum += decibelsToEnergy(levelsDecibels[levelIndex]!);
  }
  return energyToDecibels(energySum);
}

/**
 * Nivel continuo equivalente (Leq): media energética de niveles de tramos de igual duración.
 * Devuelve null si no hay datos.
 */
export function equivalentContinuousLevel(levelsDecibels: ArrayLike<number>): number | null {
  if (levelsDecibels.length === 0) return null;
  let energySum = 0;
  for (let levelIndex = 0; levelIndex < levelsDecibels.length; levelIndex++) {
    energySum += decibelsToEnergy(levelsDecibels[levelIndex]!);
  }
  return energyToDecibels(energySum / levelsDecibels.length);
}

/**
 * Nivel superado durante el `exceededPercent` % del tiempo (L10, L90…). L10 describe los
 * ruidos que destacan; L90, el ruido de fondo. Interpola entre muestras ordenadas.
 */
export function percentileExceededLevel(levelsDecibels: ArrayLike<number>, exceededPercent: number): number | null {
  if (levelsDecibels.length === 0) return null;
  const sortedLevels = Float64Array.from(levelsDecibels).sort();
  // Superado el x % del tiempo = cuantil (100 − x) %.
  const quantilePosition = ((100 - exceededPercent) / 100) * (sortedLevels.length - 1);
  const lowerIndex = Math.floor(quantilePosition);
  const upperIndex = Math.min(sortedLevels.length - 1, lowerIndex + 1);
  const interpolationFraction = quantilePosition - lowerIndex;
  return sortedLevels[lowerIndex]! + (sortedLevels[upperIndex]! - sortedLevels[lowerIndex]!) * interpolationFraction;
}

/**
 * Ponderación A (IEC 61672-1) en dB para una frecuencia: imita la sensibilidad del oído a
 * volumen moderado, que oye poco los graves. Vale 0 dB a 1 kHz.
 */
export function aWeightingDecibels(frequencyHz: number): number {
  if (!(frequencyHz > 0)) return minimumLevelDecibels;
  const squaredFrequency = frequencyHz * frequencyHz;
  const responseNumerator = 12194 ** 2 * squaredFrequency * squaredFrequency;
  const responseDenominator =
    (squaredFrequency + 20.6 ** 2) *
    Math.sqrt((squaredFrequency + 107.7 ** 2) * (squaredFrequency + 737.9 ** 2)) *
    (squaredFrequency + 12194 ** 2);
  return 20 * Math.log10(responseNumerator / responseDenominator) + 2.0;
}

/** Coeficientes de la ventana de Blackman que aplica el AnalyserNode (Web Audio). */
const blackmanCoefficients = [0.42, 0.5, 0.08] as const;
/** Media de w² de la ventana de Blackman: a0² + a1²/2 + a2²/2 ≈ 0,3046. */
const blackmanMeanSquare =
  blackmanCoefficients[0] ** 2 + blackmanCoefficients[1] ** 2 / 2 + blackmanCoefficients[2] ** 2 / 2;

export interface SpectrumLevels {
  /** Nivel con ponderación A en dBFS (convención AES17: senoidal a fondo de escala = 0). */
  aWeightedDecibelsFullScale: number;
  /** Nivel sin ponderar (Z) en dBFS, con la misma convención. */
  unweightedDecibelsFullScale: number;
}

/**
 * Crea un medidor que calcula el nivel ponderado A a partir del espectro del AnalyserNode
 * (fftSize/2 bins en dB; el nodo aplica Blackman y divide entre N). Cada bin es una banda
 * estrecha: se pondera su energía con la curva A de su frecuencia central y se suman todas.
 *
 * Por Parseval, Σ|X_k|² (un lado) ≈ media(w²)·media(x²)/2, así que
 * dBFS = 10·log10(2·media(x²)) = 10·log10(4·Σ|X_k|² / media(w²)). Coincide con el nivel RMS
 * del espectro de audio, y por eso su calibración vale también aquí.
 */
export function createSpectrumLevelMeter(fftSize: number, sampleRateHz: number) {
  const binCount = fftSize / 2;
  const aWeightingEnergyGains = new Float64Array(binCount);
  // El bin 0 (continua) no es sonido: se deja con ganancia 0.
  for (let binIndex = 1; binIndex < binCount; binIndex++) {
    aWeightingEnergyGains[binIndex] = decibelsToEnergy(aWeightingDecibels((binIndex * sampleRateHz) / fftSize));
  }
  const energyToFullScaleFactor = 4 / blackmanMeanSquare;

  return function measureSpectrumLevels(decibelSpectrum: ArrayLike<number>): SpectrumLevels {
    let unweightedEnergy = 0;
    let aWeightedEnergy = 0;
    const usableBinCount = Math.min(binCount, decibelSpectrum.length);
    for (let binIndex = 1; binIndex < usableBinCount; binIndex++) {
      const binDecibels = decibelSpectrum[binIndex]!;
      if (!Number.isFinite(binDecibels)) continue;
      const binEnergy = 10 ** (binDecibels / 10);
      unweightedEnergy += binEnergy;
      aWeightedEnergy += binEnergy * aWeightingEnergyGains[binIndex]!;
    }
    return {
      aWeightedDecibelsFullScale: energyToDecibels(aWeightedEnergy * energyToFullScaleFactor),
      unweightedDecibelsFullScale: energyToDecibels(unweightedEnergy * energyToFullScaleFactor),
    };
  };
}
