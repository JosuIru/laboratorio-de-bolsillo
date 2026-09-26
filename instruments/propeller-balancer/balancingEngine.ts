import { createFftPlan } from '@/processing/dsp/fft';
import { computeAmplitudeSpectrum, createSpectrumWorkspace } from '@/processing/dsp/spectrum';
import { createWindow } from '@/processing/dsp/windows';
import { estimateSampleRateHz, resampleUniformly } from '@/processing/signal/resampling';

/**
 * Equilibrado en un plano por el método de las cuatro pasadas (sin sensor de fase): se mide la
 * vibración a la velocidad de giro (1×) sin peso y con un peso de prueba en tres posiciones a
 * 0°, 120° y 240°. Como el desequilibrio y el efecto del peso se suman como vectores, las cuatro
 * amplitudes bastan para saber cuánto peso poner y dónde.
 */

// ── Vibración a la velocidad de giro ────────────────────────────────────────────────────────

export interface AccelerationSeries {
  timestampsSeconds: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
}

export interface RotationVibration {
  /** Frecuencia de giro detectada (el pico más alto del rango), en Hz. */
  rotationFrequencyHz: number;
  /** Amplitud de la vibración a esa frecuencia, sumando los tres ejes en potencia, en m/s². */
  amplitude: number;
  sampleRateHz: number;
}

/** Tamaño máximo de la FFT: a 200 Hz son ~5 s de medida. */
const maximumFftSize = 1024;
const minimumFftSize = 128;

function largestPowerOfTwoAtMost(sampleCount: number): number {
  let powerOfTwo = 1;
  while (powerOfTwo * 2 <= sampleCount) powerOfTwo *= 2;
  return powerOfTwo;
}

/**
 * Busca el pico de vibración entre `minimumFrequencyHz` y `maximumFrequencyHz` (o cerca de
 * `expectedFrequencyHz` si ya se conoce, ±15 %) y devuelve su amplitud. Cada eje se analiza por
 * separado y se suman potencias: el módulo del vector no sirve, porque un desequilibrio que gira
 * en un plano tiene módulo casi constante.
 */
export function measureRotationVibration(
  series: AccelerationSeries,
  minimumFrequencyHz: number,
  maximumFrequencyHz: number,
  expectedFrequencyHz: number | null = null,
): RotationVibration | null {
  const sampleRateHz = estimateSampleRateHz(series.timestampsSeconds);
  if (!sampleRateHz) return null;
  const resampledAxes = [series.x, series.y, series.z].map(
    (axisValues) => resampleUniformly(series.timestampsSeconds, axisValues, sampleRateHz).values,
  );
  const fftSize = Math.min(maximumFftSize, largestPowerOfTwoAtMost(resampledAxes[0]!.length));
  if (fftSize < minimumFftSize) return null;

  const fftPlan = createFftPlan(fftSize);
  const hannWindow = createWindow('hann', fftSize);
  const spectrumWorkspace = createSpectrumWorkspace(fftSize);
  const combinedPower = new Float64Array(fftSize / 2 + 1);
  for (const axisValues of resampledAxes) {
    const latestSamples = axisValues.subarray(axisValues.length - fftSize);
    const axisAmplitudes = computeAmplitudeSpectrum(
      fftPlan,
      latestSamples,
      hannWindow.coefficients,
      hannWindow.coherentGain,
      spectrumWorkspace,
    );
    for (let binIndex = 0; binIndex < combinedPower.length; binIndex++)
      combinedPower[binIndex]! += axisAmplitudes[binIndex]! ** 2;
  }

  const binWidthHz = sampleRateHz / fftSize;
  const searchLowHz = expectedFrequencyHz !== null ? expectedFrequencyHz * 0.85 : minimumFrequencyHz;
  const searchHighHz = expectedFrequencyHz !== null ? expectedFrequencyHz * 1.15 : maximumFrequencyHz;
  const firstBin = Math.max(2, Math.floor(searchLowHz / binWidthHz));
  const lastBin = Math.min(combinedPower.length - 2, Math.ceil(searchHighHz / binWidthHz));
  if (lastBin < firstBin) return null;
  let peakBin = firstBin;
  for (let binIndex = firstBin + 1; binIndex <= lastBin; binIndex++) {
    if (combinedPower[binIndex]! > combinedPower[peakBin]!) peakBin = binIndex;
  }
  // Una senoidal entre dos bins reparte su energía: se suman el pico y sus vecinos (Hann
  // concentra ~todo en tres bins), corrigiendo la ganancia de ruido de la ventana.
  const neighborhoodPower = combinedPower[peakBin - 1]! + combinedPower[peakBin]! + combinedPower[peakBin + 1]!;
  const leftPower = combinedPower[peakBin - 1]!;
  const rightPower = combinedPower[peakBin + 1]!;
  const peakPower = combinedPower[peakBin]!;
  const curvature = leftPower - 2 * peakPower + rightPower;
  const binOffset = curvature < 0 ? (0.5 * (leftPower - rightPower)) / curvature : 0;
  return {
    rotationFrequencyHz: (peakBin + binOffset) * binWidthHz,
    amplitude: Math.sqrt(neighborhoodPower / hannWindow.equivalentNoiseBandwidthBins),
    sampleRateHz,
  };
}

/**
 * La fuerza del desequilibrio crece con ω²: una pasada a otra velocidad vibra más o menos solo
 * por eso. Lleva la amplitud medida a `referenceFrequencyHz` multiplicando por (f₀/fᵢ)², para que
 * las cuatro pasadas se comparen como si se hubieran hecho a la misma velocidad.
 */
export function normalizeAmplitudeToReferenceSpeed(
  measuredAmplitude: number,
  rotationFrequencyHz: number,
  referenceFrequencyHz: number,
): number {
  if (!(rotationFrequencyHz > 0) || !(referenceFrequencyHz > 0)) return measuredAmplitude;
  return measuredAmplitude * (referenceFrequencyHz / rotationFrequencyHz) ** 2;
}

// ── Cuatro pasadas ──────────────────────────────────────────────────────────────────────────

/** Posiciones del peso de prueba, en grados desde la marca de referencia, en el sentido elegido. */
export const trialPositionsDegrees = [0, 120, 240] as const;

export interface BalancingInput {
  /** Vibración sin peso de prueba. */
  initialAmplitude: number;
  /** Vibración con el peso de prueba en 0°, 120° y 240°. */
  trialAmplitudes: readonly [number, number, number];
  trialMassGrams: number;
}

export type BalancingProblem = 'trial-too-small' | 'inconsistent' | 'already-balanced';

export interface BalancingSolution {
  /** Peso a poner (sin el de prueba), en gramos. */
  correctionMassGrams: number;
  /** Dónde ponerlo, en grados desde la marca, en el mismo sentido que las posiciones de prueba. */
  correctionAngleDegrees: number;
  /** Vibración que produce el peso de prueba por sí solo (misma unidad que las amplitudes). */
  trialEffectAmplitude: number;
  /** Cuánto se ajustan las tres medidas al modelo (0 = perfecto); por encima de 0,25, medir otra vez. */
  fitResidual: number;
}

/** Si el peso de prueba mueve la vibración menos de esto (fracción de la inicial), no da para calcular. */
const minimumTrialEffectFraction = 0.15;
const maximumFitResidual = 0.25;
/** Por debajo, la hélice ya está equilibrada para lo que distingue el móvil. */
export const balancedAmplitude = 0.02;

function normalizeDegrees(angleDegrees: number): number {
  return ((angleDegrees % 360) + 360) % 360;
}

/**
 * |Rᵢ|² = V0² + T² + 2·V0·T·cos(θ − φᵢ), con Rᵢ la vibración con el peso en φᵢ, V0 la inicial,
 * T el efecto del peso y θ el ángulo del desequilibrio. Con φ = 0°, 120°, 240°:
 * T² = (R1² + R2² + R3²)/3 − V0², y θ sale de Σ cᵢ·(cos φᵢ, sin φᵢ) = (3/2)(cos θ, sin θ).
 * La corrección va en θ + 180° con masa = masa de prueba · V0 / T.
 */
export function solveFourRunBalancing(balancingInput: BalancingInput): BalancingSolution | BalancingProblem {
  const { initialAmplitude, trialAmplitudes, trialMassGrams } = balancingInput;
  if (initialAmplitude < balancedAmplitude) return 'already-balanced';
  const meanTrialSquared =
    trialAmplitudes.reduce((squaredSum, trialAmplitude) => squaredSum + trialAmplitude ** 2, 0) / 3;
  const trialEffectSquared = meanTrialSquared - initialAmplitude ** 2;
  if (!(trialEffectSquared > 0)) return 'inconsistent';
  const trialEffectAmplitude = Math.sqrt(trialEffectSquared);
  if (trialEffectAmplitude < minimumTrialEffectFraction * initialAmplitude) return 'trial-too-small';

  const cosineTerms = trialAmplitudes.map(
    (trialAmplitude) =>
      (trialAmplitude ** 2 - initialAmplitude ** 2 - trialEffectSquared) /
      (2 * initialAmplitude * trialEffectAmplitude),
  );
  let cosineSum = 0;
  let sineSum = 0;
  trialPositionsDegrees.forEach((positionDegrees, positionIndex) => {
    const positionRadians = (positionDegrees * Math.PI) / 180;
    cosineSum += cosineTerms[positionIndex]! * Math.cos(positionRadians);
    sineSum += cosineTerms[positionIndex]! * Math.sin(positionRadians);
  });
  const unbalanceAngleRadians = Math.atan2(sineSum, cosineSum);

  // Cuánto se aleja cada medida de lo que predice el modelo con ese ángulo.
  const fitResidual = Math.max(
    ...trialPositionsDegrees.map((positionDegrees, positionIndex) => {
      const predictedSquared =
        initialAmplitude ** 2 +
        trialEffectSquared +
        2 *
          initialAmplitude *
          trialEffectAmplitude *
          Math.cos(unbalanceAngleRadians - (positionDegrees * Math.PI) / 180);
      return Math.abs(Math.sqrt(Math.max(0, predictedSquared)) - trialAmplitudes[positionIndex]!) / initialAmplitude;
    }),
  );
  if (fitResidual > maximumFitResidual) return 'inconsistent';

  return {
    correctionMassGrams: (trialMassGrams * initialAmplitude) / trialEffectAmplitude,
    correctionAngleDegrees: normalizeDegrees((unbalanceAngleRadians * 180) / Math.PI + 180),
    trialEffectAmplitude,
    fitResidual,
  };
}

export interface BladeSplit {
  bladeCorrections: { bladeNumber: number; massGrams: number }[];
  /**
   * Parte de la corrección que no cabe en las palas: con dos palas (opuestas, en una misma
   * línea) la componente lateral hay que ponerla en el buje, a 90° o 270°. Null si no hace falta.
   */
  hubCorrection: { massGrams: number; angleDegrees: number } | null;
}

/** Por debajo de esta fracción de la corrección, la parte lateral no merece la pena. */
const negligibleHubFraction = 0.05;

/**
 * En una hélice solo se puede poner peso en las palas: reparte la corrección entre las dos palas
 * vecinas al ángulo (descomposición de vectores). Con `bladeCount` palas equiespaciadas, la pala
 * 1 está en 0°. Con dos palas no hay dos direcciones independientes: la parte a lo largo de las
 * palas va a la de ese lado y la lateral se devuelve aparte, para el buje.
 */
export function splitCorrectionBetweenBlades(
  correctionMassGrams: number,
  correctionAngleDegrees: number,
  bladeCount: number,
): BladeSplit {
  const angle = normalizeDegrees(correctionAngleDegrees);
  if (bladeCount < 2)
    return { bladeCorrections: [{ bladeNumber: 1, massGrams: correctionMassGrams }], hubCorrection: null };
  if (bladeCount === 2) {
    const angleRadians = (angle * Math.PI) / 180;
    const alongBladesGrams = correctionMassGrams * Math.cos(angleRadians);
    const sidewaysGrams = correctionMassGrams * Math.sin(angleRadians);
    return {
      bladeCorrections:
        Math.abs(alongBladesGrams) > 1e-9
          ? [{ bladeNumber: alongBladesGrams > 0 ? 1 : 2, massGrams: Math.abs(alongBladesGrams) }]
          : [],
      hubCorrection:
        Math.abs(sidewaysGrams) > negligibleHubFraction * correctionMassGrams
          ? { massGrams: Math.abs(sidewaysGrams), angleDegrees: sidewaysGrams > 0 ? 90 : 270 }
          : null,
    };
  }
  const bladeSpacingDegrees = 360 / bladeCount;
  const lowerBladeIndex = Math.floor(angle / bladeSpacingDegrees) % bladeCount;
  const upperBladeIndex = (lowerBladeIndex + 1) % bladeCount;
  const offsetFromLowerRadians = ((angle - lowerBladeIndex * bladeSpacingDegrees) * Math.PI) / 180;
  const spacingRadians = (bladeSpacingDegrees * Math.PI) / 180;
  // Ley de los senos en el triángulo que forman la corrección y sus dos componentes.
  const lowerMass =
    (correctionMassGrams * Math.sin(spacingRadians - offsetFromLowerRadians)) / Math.sin(spacingRadians);
  const upperMass = (correctionMassGrams * Math.sin(offsetFromLowerRadians)) / Math.sin(spacingRadians);
  return {
    bladeCorrections: [
      { bladeNumber: lowerBladeIndex + 1, massGrams: lowerMass },
      { bladeNumber: upperBladeIndex + 1, massGrams: upperMass },
    ].filter((bladeCorrection) => bladeCorrection.massGrams > 1e-6),
    hubCorrection: null,
  };
}
