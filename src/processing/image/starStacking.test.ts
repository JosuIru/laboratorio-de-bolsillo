import { applyRigidTransform, composeRigidTransforms, type RigidTransform } from '../astronomy/starFieldAlignment';

import type { GrayImage } from './grayImage';
import { frameSourceFromArray } from './luckyImaging';
import { stackStarFrames, starTrailsFromGrayFrames, warpGrayImageRigid } from './starStacking';
import { randomStars, renderStarField, rotationAboutPoint } from './syntheticStarField.testHelpers';

const width = 200;
const height = 160;

/** Movimiento del cielo en `frameIndex` fotogramas: giro alrededor de un polo lejano. */
function skyMotionAfter(frameIndex: number, degreesPerFrame: number): RigidTransform {
  let accumulatedMotion: RigidTransform = { rotationRadians: 0, translationX: 0, translationY: 0 };
  const stepMotion = rotationAboutPoint(degreesPerFrame, 100, -3000);
  for (let stepIndex = 0; stepIndex < frameIndex; stepIndex++) accumulatedMotion = composeRigidTransforms(accumulatedMotion, stepMotion);
  return accumulatedMotion;
}

describe('warpGrayImageRigid', () => {
  it('desplaza una estrella a donde dice la transformación', () => {
    const star = { x: 60.3, y: 70.6, flux: 2000 };
    const image = renderStarField({ width, height, stars: [star], backgroundLevel: 10 });
    const transform: RigidTransform = { rotationRadians: 0.02, translationX: 5.5, translationY: -3.25 };
    const warpedImage = warpGrayImageRigid(image, transform, 10);
    const expectedPosition = applyRigidTransform(transform, star);
    let brightestIndex = 0;
    for (let pixelIndex = 1; pixelIndex < warpedImage.values.length; pixelIndex++) {
      if (warpedImage.values[pixelIndex]! > warpedImage.values[brightestIndex]!) brightestIndex = pixelIndex;
    }
    expect(Math.abs((brightestIndex % width) - expectedPosition.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(Math.floor(brightestIndex / width) - expectedPosition.y)).toBeLessThanOrEqual(0.5);
  });
});

describe('stackStarFrames', () => {
  const frameCount = 12;
  const trueStars = randomStars(150, width, height, 21, 25, 3000);
  // Un píxel caliente fijo en el sensor y un avión que cruza en un solo fotograma.
  const hotPixel = { x: 150, y: 40, excess: 120 };
  const planeRow = 120;
  const frames: GrayImage[] = Array.from({ length: frameCount }, (_unused, frameIndex) => {
    const frame = renderStarField({
      width,
      height,
      stars: trueStars,
      transform: skyMotionAfter(frameIndex, 0.06),
      backgroundLevel: 30,
      horizontalGradientLevels: 25,
      verticalGradientLevels: -10,
      noiseSigma: 4,
      seed: 100 + frameIndex,
      hotPixels: [hotPixel],
      quantize: true,
    });
    if (frameIndex === 5) {
      for (let columnIndex = 10; columnIndex < 190; columnIndex++) frame.values[planeRow * width + columnIndex] = 200;
    }
    return frame;
  });

  let stackResultPromise: ReturnType<typeof stackStarFrames> | null = null;
  const stackResult = () => (stackResultPromise ??= stackStarFrames(frameSourceFromArray(frames)));

  it('alinea todos los fotogramas y mide el giro del cielo', async () => {
    const result = await stackResult();
    expect(result.stackedFrameCount).toBe(frameCount);
    // Del primero al último hay 11 × 0,06° = 0,66°; la referencia puede estar en medio.
    expect(result.largestRotationDegrees).toBeGreaterThan(0.3);
    expect(result.largestRotationDegrees).toBeLessThan(0.7);
  });

  it('el apilado baja el ruido y descubre más estrellas que un fotograma suelto', async () => {
    const result = await stackResult();
    expect(result.stacked.backgroundNoise).toBeLessThan(result.singleFrame.backgroundNoise / 2.5);
    expect(result.stacked.stars.length).toBeGreaterThan(result.singleFrame.stars.length * 1.2);
  });

  it('resta el gradiente del cielo', async () => {
    const result = await stackResult();
    const { flattenedImage } = result.stacked;
    // Esquinas por dentro: el borde mismo lo cubren menos fotogramas (el cielo se ha movido).
    const cornerMeans = [
      [40, 40],
      [width - 60, 40],
      [40, height - 60],
      [width - 60, height - 60],
    ].map(([cornerX, cornerY]) => {
      const cornerValues: number[] = [];
      for (let rowIndex = cornerY!; rowIndex < cornerY! + 20; rowIndex++) {
        for (let columnIndex = cornerX!; columnIndex < cornerX! + 20; columnIndex++) {
          cornerValues.push(flattenedImage.values[rowIndex * width + columnIndex]!);
        }
      }
      cornerValues.sort((first, second) => first - second);
      return cornerValues[cornerValues.length >> 1]!;
    });
    for (const cornerMean of cornerMeans) expect(Math.abs(cornerMean)).toBeLessThan(1.5);
  });

  it('el recorte quita el avión y el píxel caliente', async () => {
    const result = await stackResult();
    const { flattenedImage, backgroundNoise, stars } = result.stacked;
    const planeValues: number[] = [];
    for (let columnIndex = 30; columnIndex < 170; columnIndex++) planeValues.push(flattenedImage.values[planeRow * width + columnIndex]!);
    planeValues.sort((first, second) => first - second);
    expect(planeValues[planeValues.length >> 1]!).toBeLessThan(3 * backgroundNoise);
    const referenceMotion = skyMotionAfter(result.referenceFrameIndex, 0.06);
    expect(stars.some((star) => Math.hypot(star.x - hotPixel.x, star.y - hotPixel.y) < 2)).toBe(false);
    // Las estrellas detectadas están donde deben en la referencia.
    const brightestTrueStar = trueStars.reduce((brightest, star) => (star.flux > brightest.flux ? star : brightest));
    const expectedPosition = applyRigidTransform(referenceMotion, brightestTrueStar);
    expect(stars.some((star) => Math.hypot(star.x - expectedPosition.x, star.y - expectedPosition.y) < 0.5)).toBe(true);
  });
});

describe('trazos de estrellas', () => {
  const trailStars = randomStars(40, width, height, 8, 800, 4000, 20);
  // Entre dos fotos el cielo avanza 8 px: sin relleno quedan huecos entre las estrellas.
  const shiftPerFrame = 8;
  const trailFrames = Array.from({ length: 5 }, (_unused, frameIndex) =>
    renderStarField({
      width,
      height,
      stars: trailStars,
      transform: { rotationRadians: 0, translationX: shiftPerFrame * frameIndex, translationY: 0 },
      backgroundLevel: 10,
      noiseSigma: 1,
      seed: 40 + frameIndex,
      quantize: true,
    }),
  );
  const brightestStar = trailStars.reduce((brightest, star) => (star.flux > brightest.flux ? star : brightest));
  const gapPixelIndex = Math.round(brightestStar.y) * width + Math.round(brightestStar.x + shiftPerFrame / 2);

  it('el máximo por píxel conserva la estrella en cada posición', () => {
    const trailBytes = starTrailsFromGrayFrames(trailFrames, { fillGaps: false });
    for (let frameIndex = 0; frameIndex < trailFrames.length; frameIndex++) {
      const starPixelIndex = Math.round(brightestStar.y) * width + Math.round(brightestStar.x + shiftPerFrame * frameIndex);
      expect(trailBytes[starPixelIndex]!).toBeGreaterThan(60);
    }
    // Sin relleno, entre dos posiciones queda un hueco oscuro.
    expect(trailBytes[gapPixelIndex]!).toBeLessThan(40);
  });

  it('con huecos rellenados el trazo es continuo', () => {
    const trailBytes = starTrailsFromGrayFrames(trailFrames, { fillGaps: true });
    expect(trailBytes[gapPixelIndex]!).toBeGreaterThan(60);
  });
});
