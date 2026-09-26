import type { GrayImage } from '@/processing/image/grayImage';
import { renderSyntheticMoon } from '@/processing/image/syntheticMoon.testHelpers';

import {
  albedoRatioForPairing,
  chooseAutomaticRegions,
  measureEarthshineRatio,
  srgbByteToLinear,
} from './earthshineAlbedoMeasurement';

const imageSide = 160;
const diskCircle = { centerX: 80, centerY: 80, radius: 50 };
const sunlitLinearBrightness = 150;
const trueRatio = 1 / 2000;
const exposureRatio = 100;

function encodeSrgb(linearImage: GrayImage): GrayImage {
  const encodedValues = new Float32Array(linearImage.values.length);
  for (let pixelIndex = 0; pixelIndex < encodedValues.length; pixelIndex++) {
    const normalizedValue = Math.min(1, Math.max(0, linearImage.values[pixelIndex]! / 255));
    encodedValues[pixelIndex] = 255 * (normalizedValue <= 0.0031308 ? 12.92 * normalizedValue : 1.055 * normalizedValue ** (1 / 2.4) - 0.055);
  }
  return { ...linearImage, values: encodedValues };
}

/** Creciente (fase 120°) iluminado por la derecha, con luz cenicienta en la parte en sombra. */
function renderExposure(exposureFactor: number): GrayImage {
  return encodeSrgb(
    renderSyntheticMoon({
      width: imageSide,
      height: imageSide,
      centerX: diskCircle.centerX,
      centerY: diskCircle.centerY,
      radius: diskCircle.radius,
      phaseAngleDegrees: 120,
      litDirectionDegrees: 0,
      diskBrightness: sunlitLinearBrightness * exposureFactor,
      shadowBrightness: sunlitLinearBrightness * trueRatio * exposureFactor,
      backgroundBrightness: 0.004 * exposureFactor,
      subsamplesPerSide: 2,
    }),
  );
}

describe('razón luz cenicienta / Sol', () => {
  const shortExposure = renderExposure(1);
  const longExposure = renderExposure(exposureRatio);

  it('la conversión sRGB a lineal es la estándar', () => {
    expect(srgbByteToLinear(255)).toBeCloseTo(255, 3);
    expect(srgbByteToLinear(0)).toBe(0);
    expect(srgbByteToLinear(187.5)).toBeCloseTo(255 * 0.5, 0);
  });

  it('elige las zonas automáticas a cada lado y recupera la razón', () => {
    const automaticRegions = chooseAutomaticRegions(shortExposure, diskCircle)!;
    expect(automaticRegions.sunlitPoint.x).toBeGreaterThan(diskCircle.centerX + 20);
    expect(automaticRegions.darkPoint.x).toBeLessThan(diskCircle.centerX - 20);
    const measurement = measureEarthshineRatio({ shortExposure, longExposure, diskCircle, exposureRatio, ...automaticRegions });
    expect('problem' in measurement).toBe(false);
    if ('problem' in measurement) return;
    expect(Math.abs(measurement.earthshineToSunlitRatio / trueRatio - 1)).toBeLessThan(0.05);
    expect(measurement.ratioRelativeUncertainty).toBeGreaterThanOrEqual(0.25);
  });

  it('avisa si la zona de la luz cenicienta cae en la parte iluminada (saturada en la larga)', () => {
    const measurement = measureEarthshineRatio({
      shortExposure,
      longExposure,
      diskCircle,
      exposureRatio,
      darkPoint: { x: diskCircle.centerX + 35, y: diskCircle.centerY },
      sunlitPoint: { x: diskCircle.centerX + 35, y: diskCircle.centerY },
    });
    expect(measurement).toEqual({ problem: 'earthshineSaturated' });
  });

  it('avisa si se marca fuera del disco', () => {
    const measurement = measureEarthshineRatio({
      shortExposure,
      longExposure,
      diskCircle,
      exposureRatio,
      darkPoint: { x: 5, y: 5 },
      sunlitPoint: { x: diskCircle.centerX + 35, y: diskCircle.centerY },
    });
    expect(measurement).toEqual({ problem: 'outsideDisk' });
  });

  it('cociente de albedos según el terreno', () => {
    expect(albedoRatioForPairing('sameTerrain', 0.6)).toBe(1);
    expect(albedoRatioForPairing('mareInShadow', 0.6)).toBe(0.6);
    expect(albedoRatioForPairing('mareInSunlight', 0.6)).toBeCloseTo(1 / 0.6, 6);
  });
});
