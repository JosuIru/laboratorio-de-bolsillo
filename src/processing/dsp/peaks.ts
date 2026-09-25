export interface DetectedPeak {
  sampleIndex: number;
  value: number;
}

export interface PeakDetectionOptions {
  /** Valor mínimo (en valor absoluto si `useAbsoluteValue`) para considerar un pico. */
  threshold: number;
  /** Separación mínima entre picos, en muestras (evita contar el mismo golpe varias veces). */
  minimumDistanceSamples: number;
  useAbsoluteValue?: boolean;
}

/**
 * Máximos locales por encima del umbral. Si dos picos están más cerca que la distancia mínima,
 * se queda el mayor.
 */
export function detectPeaks(samples: ArrayLike<number>, options: PeakDetectionOptions): DetectedPeak[] {
  const { threshold, minimumDistanceSamples, useAbsoluteValue = true } = options;
  const readValue = (sampleIndex: number) =>
    useAbsoluteValue ? Math.abs(samples[sampleIndex]!) : samples[sampleIndex]!;

  const candidatePeaks: DetectedPeak[] = [];
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const currentValue = readValue(sampleIndex);
    if (currentValue < threshold) continue;
    const previousValue = sampleIndex > 0 ? readValue(sampleIndex - 1) : -Infinity;
    const nextValue = sampleIndex < samples.length - 1 ? readValue(sampleIndex + 1) : -Infinity;
    // `>=` a la izquierda y `>` a la derecha: en una meseta se queda el primer punto.
    if (currentValue > previousValue && currentValue >= nextValue) {
      candidatePeaks.push({ sampleIndex, value: currentValue });
    }
  }

  const peaksByDescendingValue = [...candidatePeaks].sort((leftPeak, rightPeak) => rightPeak.value - leftPeak.value);
  const acceptedPeaks: DetectedPeak[] = [];
  for (const candidatePeak of peaksByDescendingValue) {
    const isTooClose = acceptedPeaks.some(
      (acceptedPeak) => Math.abs(acceptedPeak.sampleIndex - candidatePeak.sampleIndex) < minimumDistanceSamples,
    );
    if (!isTooClose) acceptedPeaks.push(candidatePeak);
  }
  return acceptedPeaks.sort((leftPeak, rightPeak) => leftPeak.sampleIndex - rightPeak.sampleIndex);
}

export interface EventDetectorTimingOptions {
  /** Tiempo mínimo tras un disparo antes de poder disparar otra vez (la «coda» de un golpe no es otro golpe). */
  refractorySeconds?: number;
  /**
   * Tiempo seguido que la señal debe pasar por debajo del umbral de rearme antes de rearmar.
   * Una vibración amortiguada cruza por cero en cada ciclo: sin esto, cada ciclo sería un evento.
   */
  quietSecondsBeforeRearm?: number;
}

/**
 * Detector de eventos en tiempo real con histéresis: se dispara al superar `triggerThreshold`
 * y se rearma al bajar de `releaseThreshold`, para no disparar en cada muestra de un golpe.
 *
 * Si `push` recibe la marca de tiempo, además exige el tiempo refractario tras el disparo y un
 * rato seguido de calma antes de rearmar.
 */
export function createEventDetector(
  triggerThreshold: number,
  releaseThreshold: number,
  timingOptions: EventDetectorTimingOptions = {},
) {
  if (releaseThreshold > triggerThreshold) {
    throw new RangeError('El umbral de rearme debe ser menor o igual que el de disparo');
  }
  const { refractorySeconds = 0, quietSecondsBeforeRearm = 0 } = timingOptions;
  let isArmed = true;
  let triggerTimestampSeconds = -Infinity;
  let lastLoudTimestampSeconds = -Infinity;
  return {
    /**
     * Devuelve `true` solo en la muestra que inicia un evento. Sin `timestampSeconds` solo se
     * aplica la histéresis.
     */
    push(sampleValue: number, timestampSeconds?: number): boolean {
      const absoluteValue = Math.abs(sampleValue);
      if (isArmed && absoluteValue >= triggerThreshold) {
        isArmed = false;
        if (timestampSeconds !== undefined) {
          triggerTimestampSeconds = timestampSeconds;
          lastLoudTimestampSeconds = timestampSeconds;
        }
        return true;
      }
      if (isArmed) return false;
      if (timestampSeconds === undefined) {
        if (absoluteValue < releaseThreshold) isArmed = true;
        return false;
      }
      if (absoluteValue >= releaseThreshold) {
        lastLoudTimestampSeconds = timestampSeconds;
        return false;
      }
      const hasRefractoryEnded = timestampSeconds - triggerTimestampSeconds >= refractorySeconds;
      const hasBeenQuietLongEnough = timestampSeconds - lastLoudTimestampSeconds >= quietSecondsBeforeRearm;
      if (hasRefractoryEnded && hasBeenQuietLongEnough) isArmed = true;
      return false;
    },
    reset(): void {
      isArmed = true;
      triggerTimestampSeconds = -Infinity;
      lastLoudTimestampSeconds = -Infinity;
    },
  };
}
