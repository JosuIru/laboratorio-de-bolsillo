import { createGrayImage } from './grayImage';
import {
  exposureAveragedVisibleFraction,
  fitOccultationTiming,
  fresnelEdgeIntensity,
  type LightCurveModelParameters,
  type LightCurveSample,
  measureApertureFlux,
} from './occultationTiming';
import { createGaussianNoise } from './syntheticMoon.testHelpers';

const trueEventTime = 1.2345;
const visibleFlux = 1000;
const hiddenFlux = 100;

function synthesizeLightCurve(
  modelParameters: LightCurveModelParameters,
  frameRate: number,
  frameCount: number,
  noiseSigma: number,
  seed: number,
  startTimeSeconds = 0.003,
): LightCurveSample[] {
  const gaussianNoise = createGaussianNoise(seed);
  return Array.from({ length: frameCount }, (_unused, frameIndex) => {
    const timeSeconds = startTimeSeconds + frameIndex / frameRate;
    const visibleFraction = exposureAveragedVisibleFraction(timeSeconds - trueEventTime, modelParameters);
    return { timeSeconds, flux: hiddenFlux + (visibleFlux - hiddenFlux) * visibleFraction + noiseSigma * gaussianNoise() };
  });
}

const fresnelDefaults = { limbVelocityMetersPerSecond: 500, wavelengthMeters: 550e-9, moonDistanceMeters: 384_400_000 };

describe('difracción de Fresnel en un borde', () => {
  it('vale ¼ en el borde geométrico, ~1,37 en la primera franja y tiende a 1 y a 0', () => {
    expect(fresnelEdgeIntensity(0)).toBeCloseTo(0.25, 3);
    let firstFringePeak = 0;
    for (let fresnelDistance = 0; fresnelDistance < 2; fresnelDistance += 0.001) {
      firstFringePeak = Math.max(firstFringePeak, fresnelEdgeIntensity(fresnelDistance));
    }
    expect(firstFringePeak).toBeCloseTo(1.37, 2);
    expect(fresnelEdgeIntensity(20)).toBeCloseTo(1, 1);
    expect(fresnelEdgeIntensity(-20)).toBeLessThan(0.001);
    // La tabla y el desarrollo asintótico empalman en w = 8.
    expect(fresnelEdgeIntensity(7.999)).toBeCloseTo(fresnelEdgeIntensity(8.001), 2);
  });
});

describe('instante de una ocultación', () => {
  it('desaparición a 30 fotogramas/s con ruido: error acorde con la incertidumbre', () => {
    const modelParameters: LightCurveModelParameters = { ...fresnelDefaults, eventType: 'disappearance', model: 'step', exposureSeconds: 1 / 30 };
    const normalizedErrors: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const samples = synthesizeLightCurve(modelParameters, 30, 75, 40, seed);
      const timing = fitOccultationTiming(samples, { exposureSeconds: 1 / 30 })!;
      expect(timing.eventType).toBe('disappearance');
      expect(timing.eventTimeUncertaintySeconds).toBeLessThan(0.01);
      expect(timing.dropSignificance).toBeGreaterThan(20);
      expect(Math.abs(timing.visibleLevel - visibleFlux)).toBeLessThan(30);
      normalizedErrors.push((timing.eventTimeSeconds - trueEventTime) / timing.eventTimeUncertaintySeconds);
    }
    const withinTwoSigma = normalizedErrors.filter((normalizedError) => Math.abs(normalizedError) < 2).length;
    expect(withinTwoSigma).toBeGreaterThanOrEqual(16);
  });

  it('reconoce una reaparición', () => {
    const modelParameters: LightCurveModelParameters = { ...fresnelDefaults, eventType: 'reappearance', model: 'step', exposureSeconds: 1 / 30 };
    const timing = fitOccultationTiming(synthesizeLightCurve(modelParameters, 30, 75, 40, 99), { exposureSeconds: 1 / 30 })!;
    expect(timing.eventType).toBe('reappearance');
    expect(Math.abs(timing.eventTimeSeconds - trueEventTime)).toBeLessThan(4 * timing.eventTimeUncertaintySeconds);
  });

  it('con tiempo muerto entre fotogramas la incertidumbre no baja del hueco/√12', () => {
    const modelParameters: LightCurveModelParameters = { ...fresnelDefaults, eventType: 'disappearance', model: 'step', exposureSeconds: 0.005 };
    const timing = fitOccultationTiming(synthesizeLightCurve(modelParameters, 30, 75, 5, 7), { exposureSeconds: 0.005 })!;
    expect(timing.eventTimeUncertaintySeconds).toBeGreaterThanOrEqual((1 / 30 - 0.005) / Math.sqrt(12));
    expect(Math.abs(timing.eventTimeSeconds - trueEventTime)).toBeLessThan(1 / 30);
  });

  it('con vídeo rápido, el modelo de Fresnel recupera el instante al milisegundo', () => {
    const modelParameters: LightCurveModelParameters = { ...fresnelDefaults, eventType: 'disappearance', model: 'fresnel', exposureSeconds: 1 / 240 };
    const samples = synthesizeLightCurve(modelParameters, 240, 144, 30, 3, 0.95);
    const fresnelTiming = fitOccultationTiming(samples, { ...fresnelDefaults, model: 'fresnel', exposureSeconds: 1 / 240 })!;
    expect(fresnelTiming.eventType).toBe('disappearance');
    expect(Math.abs(fresnelTiming.eventTimeSeconds - trueEventTime)).toBeLessThan(0.001);
    expect(Math.abs(fresnelTiming.eventTimeSeconds - trueEventTime)).toBeLessThan(4 * fresnelTiming.eventTimeUncertaintySeconds);
    const stepTiming = fitOccultationTiming(samples, { model: 'step', exposureSeconds: 1 / 240 })!;
    expect(fresnelTiming.residualRms).toBeLessThan(stepTiming.residualRms);
  });

  it('devuelve null con muy pocas muestras', () => {
    expect(fitOccultationTiming([{ timeSeconds: 0, flux: 1 }])).toBeNull();
  });
});

describe('fotometría de apertura', () => {
  it('recupera el flujo de una estrella sobre un cielo con ruido', () => {
    const image = createGrayImage(40, 40);
    const gaussianNoise = createGaussianNoise(5);
    const starFlux = 5000;
    const starSigma = 1.3;
    for (let rowIndex = 0; rowIndex < 40; rowIndex++) {
      for (let columnIndex = 0; columnIndex < 40; columnIndex++) {
        const squaredDistance = (columnIndex - 20.3) ** 2 + (rowIndex - 19.6) ** 2;
        const starValue = (starFlux / (2 * Math.PI * starSigma ** 2)) * Math.exp(-squaredDistance / (2 * starSigma ** 2));
        image.values[rowIndex * 40 + columnIndex] = 30 + starValue + 2 * gaussianNoise();
      }
    }
    const aperture = measureApertureFlux(image, 20.3, 19.6, 5);
    expect(aperture.skyLevelPerPixel).toBeCloseTo(30, 0);
    expect(Math.abs(aperture.flux - starFlux) / starFlux).toBeLessThan(0.03);
    expect(aperture.fluxUncertainty).toBeGreaterThan(0);
  });
});
