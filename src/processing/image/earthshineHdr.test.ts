import { estimateExposureRatio, fuseEarthshineExposures, renderEarthshineHdr, toneMapHighDynamicRange } from './earthshineHdr';
import type { GrayImage } from './grayImage';
import { createGaussianNoise, renderSyntheticMoon } from './syntheticMoon.testHelpers';

const imageSize = 96;
const moonCenter = 48;
const moonRadius = 36;

/** Luna creciente (iluminada a la derecha) con luz cenicienta 1000 veces más débil, en brillo lineal. */
const trueRadiance = renderSyntheticMoon({
  width: imageSize,
  height: imageSize,
  centerX: moonCenter,
  centerY: moonCenter,
  radius: moonRadius,
  phaseAngleDegrees: 120,
  litDirectionDegrees: 0,
  diskBrightness: 1000,
  shadowBrightness: 1,
  backgroundBrightness: 0.05,
  blurSigmaPixels: 0.7,
});

/** Exposición de 8 bits: escala, ruido de lectura, redondeo y saturación. */
function exposeSensor(radiance: GrayImage, exposureScale: number, noiseSeed: number, noiseSigma = 0.8): GrayImage {
  const gaussianNoise = createGaussianNoise(noiseSeed);
  return {
    ...radiance,
    values: radiance.values.map((value) => Math.min(255, Math.max(0, Math.round(value * exposureScale + noiseSigma * gaussianNoise())))),
  };
}

/** Media de la imagen en los píxeles que cumplen la condición (coordenadas relativas al centro). */
function regionMean(image: GrayImage, isInRegion: (relativeX: number, relativeY: number) => boolean): number {
  let valueSum = 0;
  let sampleCount = 0;
  for (let rowIndex = 0; rowIndex < imageSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < imageSize; columnIndex++) {
      if (!isInRegion(columnIndex - moonCenter, rowIndex - moonCenter)) continue;
      valueSum += image.values[rowIndex * imageSize + columnIndex]!;
      sampleCount++;
    }
  }
  return valueSum / sampleCount;
}

// Con fase 120° el terminador pasa por x = R/2 en el centro y se acerca a x = 0 en los cuernos.
const isLitInterior = (relativeX: number, relativeY: number) => relativeX > 0.65 * moonRadius && Math.hypot(relativeX, relativeY) < moonRadius - 3;
const isShadowInterior = (relativeX: number, relativeY: number) => relativeX < -0.1 * moonRadius && Math.hypot(relativeX, relativeY) < moonRadius - 3;
const isSky = (relativeX: number, relativeY: number) => Math.hypot(relativeX, relativeY) > moonRadius + 4;

describe('fuseEarthshineExposures', () => {
  const shortScale = 0.2;
  const exposureRatio = 250;
  const shortExposure = exposeSensor(trueRadiance, shortScale, 1);
  const longExposure = exposeSensor(trueRadiance, shortScale * exposureRatio, 2);

  it('recupera la parte al sol de la corta y la luz cenicienta de la larga', () => {
    // Por separado ninguna sirve: la corta no ve la sombra (0,2 niveles) y la larga satura.
    expect(regionMean(longExposure, isLitInterior)).toBe(255);
    const { radiance, longExposureWeight } = fuseEarthshineExposures(shortExposure, longExposure, { exposureRatio });
    expect(regionMean(radiance, isLitInterior)).toBeCloseTo(1000 * shortScale, -0.5);
    const shadowRadiance = regionMean(radiance, isShadowInterior);
    expect(Math.abs(shadowRadiance - 1 * shortScale) / (1 * shortScale)).toBeLessThan(0.05);
    expect(regionMean(longExposureWeight, isShadowInterior)).toBeCloseTo(1, 4);
    expect(regionMean(longExposureWeight, isLitInterior)).toBeCloseTo(0, 4);
  });

  it('nunca usa un píxel saturado de la larga, ni siquiera en la transición', () => {
    const { radiance, longExposureWeight } = fuseEarthshineExposures(shortExposure, longExposure, { exposureRatio });
    for (let pixelIndex = 0; pixelIndex < longExposure.values.length; pixelIndex++) {
      if (longExposure.values[pixelIndex]! >= 250) expect(longExposureWeight.values[pixelIndex]).toBe(0);
      // El brillo fusionado no se aleja de la verdad más que el ruido de la corta (o de la larga, donde manda).
      const expectedRadiance = trueRadiance.values[pixelIndex]! * shortScale;
      expect(Math.abs(radiance.values[pixelIndex]! - expectedRadiance)).toBeLessThan(4);
    }
  });

  it('estima la relación de exposiciones cuando hay píxeles útiles en las dos', () => {
    const moderateRatio = 8;
    const gentleShort = exposeSensor(trueRadiance, 0.02, 3, 0.3);
    const gentleLong = exposeSensor(trueRadiance, 0.02 * moderateRatio, 4, 0.3);
    const estimatedRatio = estimateExposureRatio(gentleShort, gentleLong)!;
    expect(Math.abs(estimatedRatio - moderateRatio) / moderateRatio).toBeLessThan(0.08);
  });
});

describe('toneMapHighDynamicRange', () => {
  it('muestra a la vez la luz cenicienta y la parte al sol', () => {
    const shortExposure = exposeSensor(trueRadiance, 0.2, 5);
    const longExposure = exposeSensor(trueRadiance, 50, 6);
    const { displayImage } = renderEarthshineHdr(shortExposure, longExposure, { exposureRatio: 250 });
    const skyDisplay = regionMean(displayImage, isSky);
    const shadowDisplay = regionMean(displayImage, isShadowInterior);
    const litDisplay = regionMean(displayImage, isLitInterior);
    expect(skyDisplay).toBeLessThan(0.05);
    expect(shadowDisplay - skyDisplay).toBeGreaterThan(0.1);
    expect(litDisplay).toBeGreaterThan(0.9);
    // Una curva lineal dejaría la luz cenicienta en 1/1000 del blanco: invisible.
    expect(shadowDisplay).toBeGreaterThan(50 * (1 / 1000));
  });

  it('es monótona y va de 0 a 1', () => {
    const ramp: GrayImage = { width: 100, height: 1, values: Float32Array.from({ length: 100 }, (_unused, index) => index ** 3) };
    const mapped = toneMapHighDynamicRange(ramp, { skyLevel: 0, whiteLevel: 99 ** 3 });
    expect(mapped.values[0]).toBe(0);
    expect(mapped.values[99]).toBeCloseTo(1, 6);
    for (let index = 1; index < 100; index++) expect(mapped.values[index]!).toBeGreaterThan(mapped.values[index - 1]!);
  });
});
