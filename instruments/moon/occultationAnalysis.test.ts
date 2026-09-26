import { createGaussianNoise } from '@/processing/image/syntheticMoon.testHelpers';

import {
  analyzeOccultationRecording,
  estimateClockOffsetFromHttpDate,
  formatUtcWithMilliseconds,
  sensorTimestampScaleToNanoseconds,
  type StarFrame,
} from './occultationAnalysis';

const cropSide = 25;
const framesPerSecond = 30;
const eventTimeSeconds = 2.345;
const firstSensorNanoseconds = 5_000_000_000_000;
/** Reloj del móvil del primer fotograma: 2026-09-26 21:00:00 UTC. */
const firstWallClockMilliseconds = Date.UTC(2026, 8, 26, 21, 0, 0);

function renderStarFrames(): StarFrame[] {
  const noise = createGaussianNoise(5);
  return Array.from({ length: 150 }, (_unused, frameIndex) => {
    const timeSeconds = frameIndex / framesPerSecond;
    const isVisible = timeSeconds < eventTimeSeconds;
    const grayPixels = new Uint8Array(cropSide * cropSide);
    for (let rowIndex = 0; rowIndex < cropSide; rowIndex++) {
      for (let columnIndex = 0; columnIndex < cropSide; columnIndex++) {
        const starProfile = isVisible ? 120 * Math.exp(-(((columnIndex - 12.4) ** 2 + (rowIndex - 11.8) ** 2) / (2 * 1.2 ** 2))) : 0;
        grayPixels[rowIndex * cropSide + columnIndex] = Math.max(0, Math.min(255, Math.round(20 + starProfile + 2 * noise())));
      }
    }
    // Entrega con 40-60 ms de retraso variable.
    const deliveryDelayMilliseconds = 40 + 20 * Math.abs(Math.sin(frameIndex));
    return {
      grayPixels,
      side: cropSide,
      sensorTimestampNanoseconds: firstSensorNanoseconds + timeSeconds * 1e9,
      wallClockMilliseconds: firstWallClockMilliseconds + timeSeconds * 1000 + deliveryDelayMilliseconds,
    };
  });
}

describe('ocultación: curva de luz e instante', () => {
  it('encuentra la desaparición con precisión de un fotograma y la pasa a hora del reloj', () => {
    const analysis = analyzeOccultationRecording(renderStarFrames(), { exposureSeconds: 1 / framesPerSecond })!;
    expect(analysis).not.toBeNull();
    expect(analysis.timing).not.toBeNull();
    expect(analysis.timing!.eventType).toBe('disappearance');
    expect(Math.abs(analysis.timing!.eventTimeSeconds - eventTimeSeconds)).toBeLessThan(1 / framesPerSecond);
    expect(analysis.framesPerSecond).toBeCloseTo(framesPerSecond, 3);
    expect(analysis.starCenter.x).toBeCloseTo(12.4, 0);
    // Ancla: el fotograma con menos retraso (40 ms).
    const expectedEventMilliseconds = firstWallClockMilliseconds + 40 + eventTimeSeconds * 1000;
    expect(Math.abs(analysis.eventWallClockMilliseconds! - expectedEventMilliseconds)).toBeLessThan(40);
    expect(analysis.deliveryJitterMilliseconds).toBeGreaterThan(5);
  });

  it('necesita al menos 6 fotogramas', () => {
    expect(analyzeOccultationRecording(renderStarFrames().slice(0, 4))).toBeNull();
  });

  it('desfase del reloj con la cabecera Date', () => {
    const phoneRequestStart = Date.UTC(2026, 8, 26, 21, 0, 0, 100);
    const estimate = estimateClockOffsetFromHttpDate(phoneRequestStart, phoneRequestStart + 200, 'Sat, 26 Sep 2026 21:00:02 GMT')!;
    // Servidor: 21:00:02,5 (mitad del segundo); móvil a mitad del viaje: 21:00:00,2.
    expect(estimate.offsetMilliseconds).toBeCloseTo(2300, 6);
    expect(estimate.uncertaintyMilliseconds).toBe(600);
    expect(estimateClockOffsetFromHttpDate(0, 1, null)).toBeNull();
    expect(estimateClockOffsetFromHttpDate(0, 1, 'no es una fecha')).toBeNull();
  });

  it('formatea la hora UTC con milisegundos', () => {
    expect(formatUtcWithMilliseconds(Date.UTC(2026, 8, 26, 21, 34, 5, 123))).toBe('2026-09-26 21:34:05.123 UTC');
  });
});

describe('unidades de las marcas del sensor', () => {
  it('deduce la unidad del intervalo entre fotogramas', () => {
    expect(sensorTimestampScaleToNanoseconds([0, 33_333_333, 66_666_666])).toBe(1);
    expect(sensorTimestampScaleToNanoseconds([0, 33.3, 66.6])).toBe(1e6);
    expect(sensorTimestampScaleToNanoseconds([0, 0.0333, 0.0666])).toBe(1e9);
  });
});
