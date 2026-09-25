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

/**
 * Detector de eventos en tiempo real con histéresis: se dispara al superar `triggerThreshold`
 * y se rearma al bajar de `releaseThreshold`, para no disparar en cada muestra de un golpe.
 */
export function createEventDetector(triggerThreshold: number, releaseThreshold: number) {
  if (releaseThreshold > triggerThreshold) {
    throw new RangeError('El umbral de rearme debe ser menor o igual que el de disparo');
  }
  let isArmed = true;
  return {
    /** Devuelve `true` solo en la muestra que inicia un evento. */
    push(sampleValue: number): boolean {
      const absoluteValue = Math.abs(sampleValue);
      if (isArmed && absoluteValue >= triggerThreshold) {
        isArmed = false;
        return true;
      }
      if (!isArmed && absoluteValue < releaseThreshold) isArmed = true;
      return false;
    },
    reset(): void {
      isArmed = true;
    },
  };
}
