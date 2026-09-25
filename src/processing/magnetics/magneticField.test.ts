import { createEventDetector } from '@/processing/dsp/peaks';
import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import {
  applyHardIronOffset,
  averageVectors,
  createHardIronEstimator,
  detectorThresholdsBySensitivity,
  deviationFromBaseline,
  isHardIronCoverageSufficient,
  type MagneticVector,
  vectorMagnitude,
} from './magneticField';

describe('vectorMagnitude y deviationFromBaseline', () => {
  it('calcula el módulo del campo', () => {
    expect(vectorMagnitude({ x: 3, y: 4, z: 12 })).toBe(13);
  });

  it('la resta vectorial ve un giro del campo que la resta de módulos no ve', () => {
    const baselineVector = { x: 40, y: 0, z: 0 };
    const rotatedVector = { x: 0, y: 40, z: 0 };
    expect(vectorMagnitude(rotatedVector) - vectorMagnitude(baselineVector)).toBe(0);
    expect(deviationFromBaseline(rotatedVector, baselineVector)).toBeCloseTo(40 * Math.SQRT2, 10);
  });
});

describe('averageVectors', () => {
  it('promedia por ejes y devuelve null sin muestras', () => {
    expect(averageVectors([{ x: 1, y: 2, z: 3 }, { x: 3, y: 4, z: 5 }])).toEqual({ x: 2, y: 3, z: 4 });
    expect(averageVectors([])).toBeNull();
  });
});

/** Lecturas de un móvil girado en todas direcciones: campo terrestre rotado + offset propio. */
function rotatingPhoneReadings(earthFieldMicroteslas: number, trueOffset: MagneticVector, sampleCount: number) {
  const nextRandom = createSeededRandom(12);
  return Array.from({ length: sampleCount }, (): MagneticVector => {
    // Dirección aleatoria uniforme en la esfera.
    const polarCosine = nextRandom() * 2 - 1;
    const azimuthRadians = nextRandom() * 2 * Math.PI;
    const polarSine = Math.sqrt(1 - polarCosine ** 2);
    const noise = () => (nextRandom() - 0.5) * 0.6;
    return {
      x: earthFieldMicroteslas * polarSine * Math.cos(azimuthRadians) + trueOffset.x + noise(),
      y: earthFieldMicroteslas * polarSine * Math.sin(azimuthRadians) + trueOffset.y + noise(),
      z: earthFieldMicroteslas * polarCosine + trueOffset.z + noise(),
    };
  });
}

describe('createHardIronEstimator', () => {
  const trueOffset = { x: 25, y: -60, z: 110 };

  it('recupera el offset propio del móvil tras girarlo en todas direcciones', () => {
    const hardIronEstimator = createHardIronEstimator();
    rotatingPhoneReadings(45, trueOffset, 2000).forEach((fieldVector) => hardIronEstimator.push(fieldVector));
    const hardIronEstimate = hardIronEstimator.estimate()!;
    expect(hardIronEstimate.hardIronOffset.offsetX).toBeCloseTo(trueOffset.x, 0);
    expect(hardIronEstimate.hardIronOffset.offsetY).toBeCloseTo(trueOffset.y, 0);
    expect(hardIronEstimate.hardIronOffset.offsetZ).toBeCloseTo(trueOffset.z, 0);
    expect(isHardIronCoverageSufficient(hardIronEstimate)).toBe(true);

    // Corregido, el módulo vuelve a ser el campo terrestre en cualquier orientación.
    const correctedMagnitudes = rotatingPhoneReadings(45, trueOffset, 20).map((fieldVector) =>
      vectorMagnitude(applyHardIronOffset(fieldVector, hardIronEstimate.hardIronOffset)),
    );
    correctedMagnitudes.forEach((correctedMagnitude) => expect(Math.abs(correctedMagnitude - 45)).toBeLessThan(2));
  });

  it('si apenas se gira el móvil, la cobertura no basta', () => {
    const hardIronEstimator = createHardIronEstimator();
    for (let sampleIndex = 0; sampleIndex < 50; sampleIndex++) {
      hardIronEstimator.push({ x: 20 + sampleIndex * 0.1, y: -30, z: 50 });
    }
    expect(isHardIronCoverageSufficient(hardIronEstimator.estimate()!)).toBe(false);
  });

  it('sin muestras no hay estimación, y reset la borra', () => {
    const hardIronEstimator = createHardIronEstimator();
    expect(hardIronEstimator.estimate()).toBeNull();
    hardIronEstimator.push({ x: 1, y: 1, z: 1 });
    hardIronEstimator.reset();
    expect(hardIronEstimator.estimate()).toBeNull();
  });
});

describe('detectorThresholdsBySensitivity', () => {
  it('más sensibilidad = umbral más bajo, y cada rearme está por debajo de su disparo', () => {
    const { low, medium, high } = detectorThresholdsBySensitivity;
    expect(high.trigger).toBeLessThan(medium.trigger);
    expect(medium.trigger).toBeLessThan(low.trigger);
    for (const thresholds of [low, medium, high]) expect(thresholds.release).toBeLessThan(thresholds.trigger);
  });

  it('con el detector de eventos avisa una vez al acercar un clavo y otra al volver a acercarlo', () => {
    const { trigger, release } = detectorThresholdsBySensitivity.high;
    const eventDetector = createEventDetector(trigger, release);
    const deviationSeries = [0.5, 1, 4, 7, 9, 6, 4, 2, 1, 6, 8];
    const alertFlags = deviationSeries.map((deviation) => eventDetector.push(deviation));
    expect(alertFlags.filter(Boolean)).toHaveLength(2);
    expect(alertFlags[3]).toBe(true);
    expect(alertFlags[9]).toBe(true);
  });
});
