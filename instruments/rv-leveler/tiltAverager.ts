import type { TiltAngles } from '@/processing/signal/orientation';

export interface AveragedTilt {
  meanTilt: TiltAngles;
  /** Mayor diferencia entre lecturas de la ventana, en cualquiera de los dos ejes. */
  spreadDegrees: number;
  /** Lecturas que hay ahora en la ventana. */
  sampleCount: number;
}

/**
 * Media móvil de la inclinación sobre las últimas `windowSampleCount` lecturas. Además de suavizar,
 * mide cuánto varían: si alguien se mueve dentro del vehículo, la dispersión crece.
 */
export function createTiltAverager(windowSampleCount: number) {
  if (!(Number.isInteger(windowSampleCount) && windowSampleCount > 0)) {
    throw new RangeError('windowSampleCount debe ser un entero positivo');
  }
  let windowReadings: TiltAngles[] = [];

  return {
    push(tiltReading: TiltAngles): AveragedTilt {
      windowReadings.push(tiltReading);
      if (windowReadings.length > windowSampleCount) windowReadings.shift();
      let tiltXSum = 0;
      let tiltYSum = 0;
      let minimumTiltX = Infinity;
      let maximumTiltX = -Infinity;
      let minimumTiltY = Infinity;
      let maximumTiltY = -Infinity;
      for (const windowReading of windowReadings) {
        tiltXSum += windowReading.tiltXDegrees;
        tiltYSum += windowReading.tiltYDegrees;
        minimumTiltX = Math.min(minimumTiltX, windowReading.tiltXDegrees);
        maximumTiltX = Math.max(maximumTiltX, windowReading.tiltXDegrees);
        minimumTiltY = Math.min(minimumTiltY, windowReading.tiltYDegrees);
        maximumTiltY = Math.max(maximumTiltY, windowReading.tiltYDegrees);
      }
      return {
        meanTilt: { tiltXDegrees: tiltXSum / windowReadings.length, tiltYDegrees: tiltYSum / windowReadings.length },
        spreadDegrees: Math.max(maximumTiltX - minimumTiltX, maximumTiltY - minimumTiltY),
        sampleCount: windowReadings.length,
      };
    },
    reset(): void {
      windowReadings = [];
    },
  };
}
