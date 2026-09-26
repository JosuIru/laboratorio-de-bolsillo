import type { GrayImage } from './grayImage';
import { deconvolveRichardsonLucy, deconvolveWithLimbPsf, estimateLimbPointSpreadFunction } from './limbDeconvolution';
import { createCachedScene, createWaveTexture, renderSyntheticMoon } from './syntheticMoon.testHelpers';

const imageSize = 96;
const moonCenterX = 47.6;
const moonCenterY = 48.3;
const moonRadius = 30;

const albedoTexture = createCachedScene(createWaveTexture(11, 40, 1 / 40, 1 / 5, 0.25), -40, 40, 0.25);

function renderMoon(blurSigmaPixels: number, noiseSigma: number, phaseAngleDegrees = 0): GrayImage {
  return renderSyntheticMoon({
    width: imageSize,
    height: imageSize,
    centerX: moonCenterX,
    centerY: moonCenterY,
    radius: moonRadius,
    phaseAngleDegrees,
    diskBrightness: 200,
    backgroundBrightness: 5,
    albedo: albedoTexture,
    blurSigmaPixels,
    noiseSigma,
    subsamplesPerSide: 4,
  });
}

/** Error cuadrático medio frente a la verdad dentro del disco ampliado 3 px. */
function rmsErrorInsideDisk(image: GrayImage, truth: GrayImage): number {
  let squaredErrorSum = 0;
  let sampleCount = 0;
  for (let rowIndex = 0; rowIndex < imageSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < imageSize; columnIndex++) {
      if (Math.hypot(columnIndex - moonCenterX, rowIndex - moonCenterY) > moonRadius + 3) continue;
      const pixelIndex = rowIndex * imageSize + columnIndex;
      squaredErrorSum += (image.values[pixelIndex]! - truth.values[pixelIndex]!) ** 2;
      sampleCount++;
    }
  }
  return Math.sqrt(squaredErrorSum / sampleCount);
}

describe('PSF medida en el limbo', () => {
  it.each([1.2, 2, 3])('recupera σ = %f px dentro del 15 %% (luna llena con ruido)', (trueSigma) => {
    const pointSpreadFunction = estimateLimbPointSpreadFunction(renderMoon(trueSigma, 1.5));
    expect(pointSpreadFunction).not.toBeNull();
    expect(Math.abs(pointSpreadFunction!.sigmaPixels - trueSigma) / trueSigma).toBeLessThan(0.15);
  });

  it('también en cuarto creciente (solo la mitad del limbo está iluminada)', () => {
    const pointSpreadFunction = estimateLimbPointSpreadFunction(renderMoon(2, 1.5, 90));
    expect(pointSpreadFunction).not.toBeNull();
    expect(pointSpreadFunction!.edgeSpread.profileCount).toBeLessThan(120);
    expect(Math.abs(pointSpreadFunction!.sigmaPixels - 2) / 2).toBeLessThan(0.15);
  });

  it('devuelve null sin Luna', () => {
    const emptySky: GrayImage = { width: 64, height: 64, values: new Float32Array(64 * 64).fill(3) };
    expect(estimateLimbPointSpreadFunction(emptySky)).toBeNull();
  });
});

describe('Richardson–Lucy con la PSF del limbo', () => {
  const truth = renderMoon(0, 0);
  const blurredNoisy = renderMoon(2, 1);

  it('reduce el error frente a la verdad', () => {
    const result = deconvolveWithLimbPsf(blurredNoisy);
    expect(result).not.toBeNull();
    const errorBefore = rmsErrorInsideDisk(blurredNoisy, truth);
    const errorAfter = rmsErrorInsideDisk(result!.image, truth);
    expect(errorAfter).toBeLessThan(0.8 * errorBefore);
  });

  it('se para al llegar al nivel del ruido y la variación total no empeora el resultado', () => {
    const psfSigma = estimateLimbPointSpreadFunction(blurredNoisy)!.sigmaPixels;
    const plain = deconvolveRichardsonLucy(blurredNoisy, psfSigma, { iterationCount: 200 });
    expect(plain.stoppedAtNoiseLevel).toBe(true);
    expect(plain.iterationsPerformed).toBeLessThan(200);
    const withTotalVariation = deconvolveRichardsonLucy(blurredNoisy, psfSigma, { iterationCount: 200, totalVariationWeight: 0.003 });
    expect(rmsErrorInsideDisk(withTotalVariation.image, truth)).toBeLessThan(rmsErrorInsideDisk(blurredNoisy, truth));
  });
});

describe('anillo de Gibbs en el limbo', () => {
  const flatMoonRadius = 44;
  const flatMoonCenterX = 63.7;
  const flatMoonCenterY = 64.2;
  const flatImageSize = 128;
  const blurSigma = 3;
  // Luna llena sin textura: el borde verdadero no tiene ningún pico, todo pico es un artefacto.
  const flatMoon = renderSyntheticMoon({
    width: flatImageSize,
    height: flatImageSize,
    centerX: flatMoonCenterX,
    centerY: flatMoonCenterY,
    radius: flatMoonRadius,
    diskBrightness: 200,
    backgroundBrightness: 5,
    blurSigmaPixels: blurSigma,
    noiseSigma: 0.5,
    subsamplesPerSide: 4,
  });

  /** Pico del perfil radial junto al limbo sobre el nivel del interior, en tanto por uno. */
  function limbOvershoot(image: GrayImage): number {
    const radialSums = new Float64Array(flatMoonRadius + 10);
    const radialCounts = new Float64Array(flatMoonRadius + 10);
    for (let rowIndex = 0; rowIndex < flatImageSize; rowIndex++) {
      for (let columnIndex = 0; columnIndex < flatImageSize; columnIndex++) {
        const radiusIndex = Math.round(Math.hypot(columnIndex - flatMoonCenterX, rowIndex - flatMoonCenterY));
        if (radiusIndex >= radialSums.length) continue;
        radialSums[radiusIndex] = radialSums[radiusIndex]! + image.values[rowIndex * flatImageSize + columnIndex]!;
        radialCounts[radiusIndex] = radialCounts[radiusIndex]! + 1;
      }
    }
    const radialProfile = Array.from(radialSums, (sum, radiusIndex) => sum / Math.max(1, radialCounts[radiusIndex]!));
    const interiorValues = radialProfile.slice(Math.round(0.4 * flatMoonRadius), Math.round(0.7 * flatMoonRadius));
    const interiorLevel = interiorValues.reduce((sum, value) => sum + value, 0) / interiorValues.length;
    const limbPeak = Math.max(...radialProfile.slice(Math.round(flatMoonRadius - 5 * blurSigma), flatMoonRadius + 1));
    return limbPeak / interiorLevel - 1;
  }

  it('Richardson–Lucy solo deja un anillo claro y la supresión lo quita sin tocar el interior', () => {
    const withRing = deconvolveWithLimbPsf(flatMoon, {}, null, { suppressRinging: false })!;
    const withoutRing = deconvolveWithLimbPsf(flatMoon)!;
    expect(limbOvershoot(withRing.image)).toBeGreaterThan(0.08);
    expect(limbOvershoot(withoutRing.image)).toBeLessThan(0.035);
    const diskCircle = withoutRing.pointSpreadFunction.diskCircle;
    const bandInnerRadius = diskCircle.radius - 4 * withoutRing.pointSpreadFunction.sigmaPixels - 1;
    for (let pixelIndex = 0; pixelIndex < flatImageSize ** 2; pixelIndex++) {
      const columnIndex = pixelIndex % flatImageSize;
      const rowIndex = Math.floor(pixelIndex / flatImageSize);
      if (Math.hypot(columnIndex - diskCircle.centerX, rowIndex - diskCircle.centerY) < bandInnerRadius) {
        expect(withoutRing.image.values[pixelIndex]).toBe(withRing.image.values[pixelIndex]);
      }
    }
  });
});
