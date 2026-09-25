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
  trackBaselineMagnitude,
  vectorMagnitude,
} from './magneticField';

describe('vectorMagnitude y deviationFromBaseline', () => {
  it('calcula el módulo del campo', () => {
    expect(vectorMagnitude({ x: 3, y: 4, z: 12 })).toBe(13);
  });

  it('girar el móvil 30° en un campo de 50 µT no da desviación', () => {
    const baselineVector = { x: 50, y: 0, z: 0 };
    const rotationRadians = (30 * Math.PI) / 180;
    const rotatedVector = { x: 50 * Math.cos(rotationRadians), y: 50 * Math.sin(rotationRadians), z: 0 };
    // Con la resta vectorial daría 2·50·sin(15°) ≈ 26 µT y saltaría incluso con sensibilidad media.
    expect(deviationFromBaseline(rotatedVector, vectorMagnitude(baselineVector))).toBeCloseTo(0, 10);
  });

  it('un aumento del módulo sí se detecta, sea cual sea la orientación', () => {
    const baselineMagnitude = 50;
    const strongerFieldVector = { x: 0, y: 0, z: 58 };
    expect(deviationFromBaseline(strongerFieldVector, baselineMagnitude)).toBeCloseTo(8, 10);
    expect(deviationFromBaseline(strongerFieldVector, baselineMagnitude)).toBeGreaterThan(detectorThresholdsBySensitivity.high.trigger);
    expect(deviationFromBaseline({ x: 0, y: 42, z: 0 }, baselineMagnitude)).toBeCloseTo(8, 10);
  });
});

describe('trackBaselineMagnitude', () => {
  /** Sigue un campo constante durante `durationSeconds` a 100 Hz. */
  function trackConstantField(initialBaseline: number, fieldMagnitude: number, durationSeconds: number, timeConstantSeconds: number) {
    let baselineMagnitude = initialBaseline;
    for (let sampleIndex = 0; sampleIndex < durationSeconds * 100; sampleIndex++) {
      baselineMagnitude = trackBaselineMagnitude(baselineMagnitude, fieldMagnitude, 0.01, timeConstantSeconds);
    }
    return baselineMagnitude;
  }

  it('tras un escalón de 20 µT la desviación baja del umbral de rearme en pocas constantes de tiempo', () => {
    const baselineAfterMinute = trackConstantField(50, 70, 60, 30);
    // Tras 2τ queda un 13,5 % del escalón.
    expect(70 - baselineAfterMinute).toBeCloseTo(20 * Math.exp(-2), 1);
    const baselineAfterTwoMinutes = trackConstantField(50, 70, 120, 30);
    expect(70 - baselineAfterTwoMinutes).toBeLessThan(detectorThresholdsBySensitivity.high.release);
  });

  it('pasar 2 s sobre un objeto apenas mueve la línea base', () => {
    expect(trackConstantField(50, 70, 2, 30) - 50).toBeLessThan(1.5);
  });

  it('sin tiempo transcurrido no cambia', () => {
    expect(trackBaselineMagnitude(50, 70, 0, 30)).toBe(50);
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
