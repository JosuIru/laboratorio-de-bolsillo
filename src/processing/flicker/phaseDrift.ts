/**
 * Frecuencia del parpadeo a partir de la deriva de fase de las bandas entre fotogramas.
 *
 * En la fila central, la fase de las bandas del fotograma k es  θₖ = s·2π·f·tₖ + constante,
 * donde tₖ es la marca de tiempo del fotograma (del reloj del sensor), f la frecuencia del
 * parpadeo y s = ±1 el sentido de lectura del sensor respecto al eje del perfil. No hace falta
 * conocer el tiempo de lectura por fila: solo las marcas de tiempo.
 *
 * Como solo se ve un fotograma cada 1/fps, la fase determina f salvo múltiplos de la cadencia
 * (unos 30 Hz): se busca la desviación δ respecto a la frecuencia nominal f₀ (100 o 120 Hz)
 * dentro de ±`maximumDeviationHz`, maximizando la coherencia |Σ wₖ·e^{i(s·θₖ − 2π(f₀+δ)tₖ)}|.
 * Luego se afina con una regresión lineal de los residuos de fase. Con el sentido equivocado,
 * la fase gira a unos ±2·f₀ (módulo la cadencia), lejos de la ventana de búsqueda: así se
 * deduce también el sentido de lectura, salvo cadencias especiales (p. ej. 60 Hz a 30 fps).
 */

export interface PhaseSample {
  /** Segundos (en el reloj de la cámara). */
  timeSeconds: number;
  /** Fase de las bandas en la muestra central del perfil, en radianes. */
  phaseRadians: number;
  /** Peso (≈ amplitud² de las bandas: las débiles tienen una fase más ruidosa). */
  weight: number;
}

export interface PhaseDriftOptions {
  nominalFlickerFrequencyHz: number;
  /** Ventana de búsqueda alrededor de la nominal, en Hz de parpadeo. */
  maximumDeviationHz: number;
  /**
   * Incertidumbre relativa del reloj de la cámara (el cristal del móvil): se suma a la
   * estadística. 30 ppm es un valor típico.
   */
  clockToleranceRelative: number;
}

export const defaultPhaseDriftOptions: Omit<PhaseDriftOptions, 'nominalFlickerFrequencyHz'> = {
  maximumDeviationHz: 2,
  clockToleranceRelative: 30e-6,
};

/** Primer tramo de la búsqueda gruesa, en segundos. */
const initialSegmentSeconds = 1.5;

export interface FlickerFrequencyEstimate {
  flickerFrequencyHz: number;
  /** Frecuencia medida menos la nominal. */
  deviationHz: number;
  /** Incertidumbre típica (1σ): estadística y reloj del móvil combinados. */
  uncertaintyHz: number;
  /** Solo la parte estadística de la incertidumbre. */
  statisticalUncertaintyHz: number;
  /** 0-1: 1 = todas las fases caen sobre la recta (bandas nítidas y estables). */
  phaseCoherence: number;
  /** +1 si las bandas avanzan en el sentido del eje del perfil, −1 al revés. */
  readoutDirection: 1 | -1;
  /** true si los dos sentidos de lectura encajan igual de bien (el signo de δ no es fiable). */
  isDirectionAmbiguous: boolean;
  durationSeconds: number;
  sampleCount: number;
}

/** Lleva un ángulo a (−π, π]. */
export function wrapAngle(angleRadians: number): number {
  const wrappedAngle = angleRadians - 2 * Math.PI * Math.round(angleRadians / (2 * Math.PI));
  return wrappedAngle <= -Math.PI ? wrappedAngle + 2 * Math.PI : wrappedAngle;
}

interface CoherenceResult {
  coherence: number;
  meanPhase: number;
}

function phaseCoherenceAt(
  residualPhases: Float64Array,
  relativeTimes: Float64Array,
  weights: Float64Array,
  deviationHz: number,
  startIndex = 0,
): CoherenceResult {
  let realSum = 0;
  let imaginarySum = 0;
  let weightSum = 0;
  for (let sampleIndex = startIndex; sampleIndex < residualPhases.length; sampleIndex++) {
    const angle = residualPhases[sampleIndex]! - 2 * Math.PI * deviationHz * relativeTimes[sampleIndex]!;
    realSum += weights[sampleIndex]! * Math.cos(angle);
    imaginarySum += weights[sampleIndex]! * Math.sin(angle);
    weightSum += weights[sampleIndex]!;
  }
  return {
    coherence: weightSum > 0 ? Math.hypot(realSum, imaginarySum) / weightSum : 0,
    meanPhase: Math.atan2(imaginarySum, realSum),
  };
}

interface DirectionFit {
  readoutDirection: 1 | -1;
  deviationHz: number;
  statisticalUncertaintyHz: number;
  coherence: number;
}

function fitDirection(
  samples: readonly PhaseSample[],
  readoutDirection: 1 | -1,
  options: PhaseDriftOptions,
): DirectionFit {
  const sampleCount = samples.length;
  const firstTime = samples[0]!.timeSeconds;
  const relativeTimes = new Float64Array(sampleCount);
  const residualPhases = new Float64Array(sampleCount);
  const weights = new Float64Array(sampleCount);
  let totalWeight = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const sample = samples[sampleIndex]!;
    const relativeTime = sample.timeSeconds - firstTime;
    relativeTimes[sampleIndex] = relativeTime;
    // Se resta la fase que tendría el parpadeo nominal; queda la que gira a δ.
    residualPhases[sampleIndex] = wrapAngle(
      readoutDirection * sample.phaseRadians - 2 * Math.PI * options.nominalFlickerFrequencyHz * relativeTime,
    );
    weights[sampleIndex] = sample.weight;
    totalWeight += sample.weight;
  }
  const durationSeconds = relativeTimes[sampleCount - 1]! || 1;

  // Búsqueda gruesa multirresolución: primero en los últimos segundos (resolución baja, toda la
  // ventana de ±maximumDeviationHz) y luego en tramos 4 veces más largos, cada vez más cerca del
  // pico anterior. Cuesta decenas de veces menos que barrer toda la ventana con la resolución
  // del historial completo, y con cientos de fotogramas eso importa en el hilo JS.
  let bestDeviationHz = 0;
  let searchCenterHz = 0;
  let searchHalfWidthHz = options.maximumDeviationHz;
  let segmentSeconds = Math.min(durationSeconds, initialSegmentSeconds);
  for (;;) {
    const segmentStartTime = durationSeconds - segmentSeconds;
    let segmentStartIndex = 0;
    while (segmentStartIndex < sampleCount - 1 && relativeTimes[segmentStartIndex]! < segmentStartTime) {
      segmentStartIndex++;
    }
    const searchStepHz = 1 / (4 * Math.max(segmentSeconds, 1e-3));
    let bestCoherence = -1;
    for (
      let candidateDeviationHz = searchCenterHz - searchHalfWidthHz;
      candidateDeviationHz <= searchCenterHz + searchHalfWidthHz + 1e-12;
      candidateDeviationHz += searchStepHz
    ) {
      const { coherence } = phaseCoherenceAt(
        residualPhases,
        relativeTimes,
        weights,
        candidateDeviationHz,
        segmentStartIndex,
      );
      if (coherence > bestCoherence) {
        bestCoherence = coherence;
        bestDeviationHz = candidateDeviationHz;
      }
    }
    if (segmentSeconds >= durationSeconds) break;
    searchCenterHz = bestDeviationHz;
    searchHalfWidthHz = 1 / segmentSeconds;
    segmentSeconds = Math.min(durationSeconds, segmentSeconds * 4);
  }

  // Ajuste fino: regresión lineal ponderada de los residuos (ya pequeños, sin saltos de 2π).
  let refinedDeviationHz = bestDeviationHz;
  let statisticalUncertaintyHz = Number.POSITIVE_INFINITY;
  for (let refinementPass = 0; refinementPass < 3; refinementPass++) {
    const { meanPhase } = phaseCoherenceAt(residualPhases, relativeTimes, weights, refinedDeviationHz);
    let weightedTimeSum = 0;
    let weightedResidualSum = 0;
    const phaseResiduals = new Float64Array(sampleCount);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      phaseResiduals[sampleIndex] = wrapAngle(
        residualPhases[sampleIndex]! - 2 * Math.PI * refinedDeviationHz * relativeTimes[sampleIndex]! - meanPhase,
      );
      weightedTimeSum += weights[sampleIndex]! * relativeTimes[sampleIndex]!;
      weightedResidualSum += weights[sampleIndex]! * phaseResiduals[sampleIndex]!;
    }
    const weightedMeanTime = weightedTimeSum / totalWeight;
    const weightedMeanResidual = weightedResidualSum / totalWeight;
    let timeVariationSum = 0;
    let covariationSum = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const timeOffset = relativeTimes[sampleIndex]! - weightedMeanTime;
      timeVariationSum += weights[sampleIndex]! * timeOffset * timeOffset;
      covariationSum += weights[sampleIndex]! * timeOffset * (phaseResiduals[sampleIndex]! - weightedMeanResidual);
    }
    if (timeVariationSum <= 0) break;
    const slopeRadiansPerSecond = covariationSum / timeVariationSum;
    refinedDeviationHz += slopeRadiansPerSecond / (2 * Math.PI);

    // Dispersión de los residuos alrededor de la recta, con pesos normalizados a media 1.
    let weightedSquaredResidualSum = 0;
    let lagOneProductSum = 0;
    let squaredLineResidualSum = 0;
    let previousLineResidual = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const lineResidual =
        phaseResiduals[sampleIndex]! -
        weightedMeanResidual -
        slopeRadiansPerSecond * (relativeTimes[sampleIndex]! - weightedMeanTime);
      weightedSquaredResidualSum += weights[sampleIndex]! * lineResidual * lineResidual;
      squaredLineResidualSum += lineResidual * lineResidual;
      if (sampleIndex > 0) lagOneProductSum += lineResidual * previousLineResidual;
      previousLineResidual = lineResidual;
    }
    const residualVariance =
      ((weightedSquaredResidualSum / totalWeight) * sampleCount) / Math.max(1, sampleCount - 2);
    // Los residuos suelen estar correlacionados (deriva lenta de la exposición): se infla la
    // varianza según su autocorrelación, para no prometer más precisión de la que hay.
    const lagOneCorrelation =
      squaredLineResidualSum > 0 ? Math.min(0.95, Math.max(0, lagOneProductSum / squaredLineResidualSum)) : 0;
    const correlationInflation = (1 + lagOneCorrelation) / (1 - lagOneCorrelation);
    const normalizedTimeVariation = (timeVariationSum / totalWeight) * sampleCount;
    statisticalUncertaintyHz =
      Math.sqrt((residualVariance * correlationInflation) / normalizedTimeVariation) / (2 * Math.PI);
  }

  const finalCoherence = phaseCoherenceAt(residualPhases, relativeTimes, weights, refinedDeviationHz).coherence;
  return {
    readoutDirection,
    deviationHz: refinedDeviationHz,
    statisticalUncertaintyHz,
    coherence: finalCoherence,
  };
}

/** Coherencia mínima del sentido descartado para considerar ambiguo el sentido de lectura. */
const ambiguousDirectionCoherenceRatio = 0.8;

/**
 * Estima la frecuencia del parpadeo con las fases de las bandas de varios fotogramas. Devuelve
 * null con menos de 3 muestras o si no avanza el tiempo. Las muestras deben ir en orden.
 */
export function estimateFlickerFrequency(
  samples: readonly PhaseSample[],
  options: PhaseDriftOptions,
): FlickerFrequencyEstimate | null {
  if (samples.length < 3) return null;
  const durationSeconds = samples[samples.length - 1]!.timeSeconds - samples[0]!.timeSeconds;
  if (!(durationSeconds > 0)) return null;
  const totalWeight = samples.reduce((weightSum, sample) => weightSum + sample.weight, 0);
  if (!(totalWeight > 0)) return null;

  const forwardFit = fitDirection(samples, 1, options);
  const backwardFit = fitDirection(samples, -1, options);
  const [bestFit, otherFit] =
    forwardFit.coherence >= backwardFit.coherence ? [forwardFit, backwardFit] : [backwardFit, forwardFit];
  const isDirectionAmbiguous = otherFit.coherence >= ambiguousDirectionCoherenceRatio * bestFit.coherence;
  // Si no se puede decidir, se supone que el sensor lee en el orden de las filas del búfer
  // (lo habitual cuando el fotograma llega en la orientación nativa del sensor).
  const chosenFit = isDirectionAmbiguous ? forwardFit : bestFit;

  const flickerFrequencyHz = options.nominalFlickerFrequencyHz + chosenFit.deviationHz;
  const clockUncertaintyHz = flickerFrequencyHz * options.clockToleranceRelative;
  return {
    flickerFrequencyHz,
    deviationHz: chosenFit.deviationHz,
    uncertaintyHz: Math.hypot(chosenFit.statisticalUncertaintyHz, clockUncertaintyHz),
    statisticalUncertaintyHz: chosenFit.statisticalUncertaintyHz,
    phaseCoherence: chosenFit.coherence,
    readoutDirection: chosenFit.readoutDirection,
    isDirectionAmbiguous,
    durationSeconds,
    sampleCount: samples.length,
  };
}
