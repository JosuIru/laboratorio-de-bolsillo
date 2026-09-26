import type { GrayImage } from './grayImage';
import { rotateGrayImage, stackMonoFramesOnDisk } from './rawGreenStack';
import { createCachedScene, createWaveTexture, renderSyntheticMoon } from './syntheticMoon.testHelpers';

const frameSide = 80;
const moonRadius = 20;
const albedoTexture = createCachedScene(createWaveTexture(5, 24, 1 / 12, 1 / 3, 0.25), -24, 24, 0.25);

function renderFrame(centerX: number, centerY: number, noiseSigma: number, randomSeed: number): GrayImage {
  return renderSyntheticMoon({
    width: frameSide,
    height: frameSide,
    centerX,
    centerY,
    radius: moonRadius,
    diskBrightness: 0.6,
    backgroundBrightness: 0.01,
    albedo: albedoTexture,
    blurSigmaPixels: 0.8,
    noiseSigma,
    randomSeed,
    subsamplesPerSide: 4,
  });
}

describe('apilado monocromo alineado por el disco', () => {
  const noiseSigma = 0.03;
  const frames = Array.from({ length: 12 }, (_unused, frameIndex) =>
    renderFrame(39.3 + (frameIndex % 4) * 0.37, 40.1 + Math.floor(frameIndex / 4) * 0.41, noiseSigma, 100 + frameIndex),
  );

  it('alinea, promedia y baja el ruido del cielo', () => {
    const result = stackMonoFramesOnDisk(frames, { keptFraction: 1, upsampleFactor: 1 })!;
    expect(result).not.toBeNull();
    expect(result.usedFrameCount).toBe(12);
    expect(result.diskRadiusPixels).toBeCloseTo(moonRadius, 0);
    const skyStandardDeviation = (image: GrayImage) => {
      const skyValues: number[] = [];
      for (let rowIndex = 0; rowIndex < 6; rowIndex++) {
        for (let columnIndex = 0; columnIndex < image.width; columnIndex++) skyValues.push(image.values[rowIndex * image.width + columnIndex]!);
      }
      const mean = skyValues.reduce((sum, value) => sum + value, 0) / skyValues.length;
      return Math.sqrt(skyValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / skyValues.length);
    };
    expect(skyStandardDeviation(result.stackedImage)).toBeLessThan(0.5 * skyStandardDeviation(result.bestSingleImage));
    // El disco queda en el centro de la rejilla.
    const centerValue = result.stackedImage.values[Math.floor(result.stackedImage.height / 2) * result.stackedImage.width + Math.floor(result.stackedImage.width / 2)]!;
    expect(centerValue).toBeGreaterThan(0.2);
  });

  it('con la rejilla dos veces más fina, el disco mide el doble', () => {
    const result = stackMonoFramesOnDisk(frames, { keptFraction: 0.5, upsampleFactor: 2 })!;
    expect(result.usedFrameCount).toBe(6);
    const middleRow = Math.floor(result.stackedImage.height / 2);
    let litColumnCount = 0;
    for (let columnIndex = 0; columnIndex < result.stackedImage.width; columnIndex++) {
      if (result.stackedImage.values[middleRow * result.stackedImage.width + columnIndex]! > 0.2) litColumnCount++;
    }
    expect(Math.abs(litColumnCount - 4 * moonRadius)).toBeLessThan(4);
  });

  it('devuelve null sin Luna', () => {
    const emptySky: GrayImage = { width: 40, height: 40, values: new Float32Array(1600).fill(0.01) };
    expect(stackMonoFramesOnDisk([emptySky])).toBeNull();
  });
});

describe('giro de imágenes grises', () => {
  // 3×2: fila 0 = 0 1 2, fila 1 = 3 4 5
  const image: GrayImage = { width: 3, height: 2, values: Float32Array.from([0, 1, 2, 3, 4, 5]) };

  it('90° en sentido horario', () => {
    const rotated = rotateGrayImage(image, 90);
    expect(rotated.width).toBe(2);
    expect(Array.from(rotated.values)).toEqual([3, 0, 4, 1, 5, 2]);
  });

  it('180° y 270°', () => {
    expect(Array.from(rotateGrayImage(image, 180).values)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(Array.from(rotateGrayImage(image, 270).values)).toEqual([2, 5, 1, 4, 0, 3]);
  });

  it('espejo después del giro', () => {
    expect(Array.from(rotateGrayImage(image, 0, true).values)).toEqual([2, 1, 0, 5, 4, 3]);
  });
});
