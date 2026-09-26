import { depthColorForFrame, renderSourceIndexMap, stackFocusBracket } from './focusStacking';
import { createGrayImage, createSeededRandom, gaussianBlurGray, type GrayImage, sampleBilinear } from './grayImage';
import type { FloatRgbImage } from './lunarStacking';
import {
  composeSimilarity,
  createSimilarityAligner,
  mapPointWithSimilarity,
  type SimilarityTransform,
  similarityScale,
} from './similarityAlignment';

const sceneSize = 128;
const frameCount = 7;
/** Foto en la que está enfocado cada plano: el cercano (izquierda) y el lejano (derecha). */
const nearPlaneFocusIndex = 1;
const farPlaneFocusIndex = 5;
const middleFrameIndex = 3;

/** Textura con detalle fino (ruido suavizado un poco), entre ~60 y ~200. */
function createTexture(seed: number): GrayImage {
  const randomValue = createSeededRandom(seed);
  const texture = createGrayImage(sceneSize, sceneSize);
  for (let pixelIndex = 0; pixelIndex < texture.values.length; pixelIndex++) texture.values[pixelIndex] = 130 + 90 * (randomValue() - 0.5);
  return gaussianBlurGray(texture, 0.8);
}

const sceneTexture = createTexture(7);

function blurSigmaForPlane(frameIndex: number, planeFocusIndex: number): number {
  return 0.25 + 0.9 * Math.abs(frameIndex - planeFocusIndex);
}

/** «Focus breathing» y pulso: de la referencia (foto del medio) a cada foto. */
function trueTransform(frameIndex: number): SimilarityTransform {
  const scale = 1 + 0.006 * (frameIndex - middleFrameIndex);
  return { scaleCosine: scale, scaleSine: 0, offsetX: 0.7 * (frameIndex - middleFrameIndex), offsetY: -0.45 * (frameIndex - middleFrameIndex) };
}

/** Escena con cada plano desenfocado según la foto (sin mover): mitad izquierda cerca, derecha lejos. */
function sceneForFrame(frameIndex: number): GrayImage {
  const nearPlane = gaussianBlurGray(sceneTexture, blurSigmaForPlane(frameIndex, nearPlaneFocusIndex));
  const farPlane = gaussianBlurGray(sceneTexture, blurSigmaForPlane(frameIndex, farPlaneFocusIndex));
  const composite = createGrayImage(sceneSize, sceneSize);
  for (let rowIndex = 0; rowIndex < sceneSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < sceneSize; columnIndex++) {
      const pixelIndex = rowIndex * sceneSize + columnIndex;
      composite.values[pixelIndex] = columnIndex < sceneSize / 2 ? nearPlane.values[pixelIndex]! : farPlane.values[pixelIndex]!;
    }
  }
  return composite;
}

/** Inversa de una semejanza sin giro: de la foto a la referencia. */
function inverseScaleAndShift(transform: SimilarityTransform): SimilarityTransform {
  const scale = transform.scaleCosine;
  return { scaleCosine: 1 / scale, scaleSine: 0, offsetX: -transform.offsetX / scale, offsetY: -transform.offsetY / scale };
}

function renderFrame(frameIndex: number, noiseSeed: number): Uint8Array {
  const scene = sceneForFrame(frameIndex);
  const frameToReference = inverseScaleAndShift(trueTransform(frameIndex));
  const randomValue = createSeededRandom(noiseSeed);
  const rgbPixels = new Uint8Array(sceneSize * sceneSize * 3);
  for (let rowIndex = 0; rowIndex < sceneSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < sceneSize; columnIndex++) {
      const scenePoint = mapPointWithSimilarity(frameToReference, sceneSize, sceneSize, columnIndex, rowIndex);
      const noise = (randomValue() + randomValue() + randomValue() - 1.5) * 1.2;
      const value = sampleBilinear(scene, scenePoint.x, scenePoint.y) + noise;
      const pixelOffset = (rowIndex * sceneSize + columnIndex) * 3;
      rgbPixels[pixelOffset] = Math.min(255, Math.max(0, Math.round(value)));
      rgbPixels[pixelOffset + 1] = Math.min(255, Math.max(0, Math.round(value * 0.9)));
      rgbPixels[pixelOffset + 2] = Math.min(255, Math.max(0, Math.round(value * 0.75)));
    }
  }
  return rgbPixels;
}

const frames = Array.from({ length: frameCount }, (_unused, frameIndex) => renderFrame(frameIndex, 100 + frameIndex));

function greenPlaneOfRgb(rgbPixels: Uint8Array): Float32Array {
  const values = new Float32Array(sceneSize * sceneSize);
  for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) values[pixelIndex] = rgbPixels[pixelIndex * 3 + 1]!;
  return values;
}

function greenPlaneOfFloat(image: FloatRgbImage): Float32Array {
  const values = new Float32Array(image.size * image.size);
  for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) values[pixelIndex] = image.channels[pixelIndex * 3 + 1]!;
  return values;
}

/** Nitidez de una zona: media del cuadrado del laplaciano. */
function regionSharpness(values: Float32Array, firstColumn: number, lastColumn: number): number {
  let squaredSum = 0;
  let sampleCount = 0;
  for (let rowIndex = 20; rowIndex < sceneSize - 20; rowIndex++) {
    for (let columnIndex = firstColumn; columnIndex < lastColumn; columnIndex++) {
      const pixelIndex = rowIndex * sceneSize + columnIndex;
      const laplacian =
        4 * values[pixelIndex]! - values[pixelIndex - 1]! - values[pixelIndex + 1]! - values[pixelIndex - sceneSize]! - values[pixelIndex + sceneSize]!;
      squaredSum += laplacian * laplacian;
      sampleCount++;
    }
  }
  return squaredSum / sampleCount;
}

const nearRegion = [18, 52] as const;
const farRegion = [76, 110] as const;

describe('similarityAlignment', () => {
  it('encuentra la escala del «focus breathing» y la traslación', () => {
    const referenceImage = createGrayImage(sceneSize, sceneSize, greenPlaneOfRgb(frames[middleFrameIndex]!));
    const alignToReference = createSimilarityAligner(referenceImage, { maximumShiftPixels: 16, estimateRotation: true });
    const neighbourImage = createGrayImage(sceneSize, sceneSize, greenPlaneOfRgb(frames[middleFrameIndex + 1]!));
    const { transform } = alignToReference(neighbourImage);
    const expected = trueTransform(middleFrameIndex + 1);
    expect(similarityScale(transform)).toBeCloseTo(expected.scaleCosine, 3);
    expect(transform.offsetX).toBeCloseTo(expected.offsetX, 0);
    expect(Math.abs(transform.offsetY - expected.offsetY)).toBeLessThan(0.25);
  });

  it('compone dos semejanzas como aplicarlas una tras otra', () => {
    const first: SimilarityTransform = { scaleCosine: 1.01, scaleSine: 0.002, offsetX: 1.5, offsetY: -0.5 };
    const second: SimilarityTransform = { scaleCosine: 0.99, scaleSine: -0.001, offsetX: -0.3, offsetY: 2 };
    const pointInFirst = mapPointWithSimilarity(first, 100, 100, 12, 80);
    const pointInSecond = mapPointWithSimilarity(second, 100, 100, pointInFirst.x, pointInFirst.y);
    const composedPoint = mapPointWithSimilarity(composeSimilarity(first, second), 100, 100, 12, 80);
    expect(composedPoint.x).toBeCloseTo(pointInSecond.x, 6);
    expect(composedPoint.y).toBeCloseTo(pointInSecond.y, 6);
  });
});

describe('stackFocusBracket', () => {
  const result = stackFocusBracket(frames, sceneSize, { maximumShiftPixels: 16, estimateRotation: true });
  const stackedGreen = greenPlaneOfFloat(result.stackedImage);
  const stackedNearSharpness = regionSharpness(stackedGreen, ...nearRegion);
  const stackedFarSharpness = regionSharpness(stackedGreen, ...farRegion);
  const frameSharpnesses = frames.map((framePixels) => {
    const greenValues = greenPlaneOfRgb(framePixels);
    return { near: regionSharpness(greenValues, ...nearRegion), far: regionSharpness(greenValues, ...farRegion) };
  });

  it('recupera el alineado encadenado de todas las fotos', () => {
    result.transforms.forEach((transform, frameIndex) => {
      const expected = trueTransform(frameIndex);
      expect(Math.abs(similarityScale(transform) - expected.scaleCosine)).toBeLessThan(0.0035);
      expect(Math.abs(transform.offsetX - expected.offsetX)).toBeLessThan(0.35);
      expect(Math.abs(transform.offsetY - expected.offsetY)).toBeLessThan(0.35);
    });
    expect(result.focusBreathingPercent).toBeGreaterThan(1.5);
  });

  it('el resultado es más nítido en los dos planos que cualquier foto sola', () => {
    const bestNearSharpness = Math.max(...frameSharpnesses.map((frameSharpness) => frameSharpness.near));
    const bestFarSharpness = Math.max(...frameSharpnesses.map((frameSharpness) => frameSharpness.far));
    // En cada plano, casi tan nítido como la mejor foto para ese plano…
    expect(stackedNearSharpness).toBeGreaterThan(0.8 * bestNearSharpness);
    expect(stackedFarSharpness).toBeGreaterThan(0.8 * bestFarSharpness);
    // …y ninguna foto sola está enfocada en los dos: en el peor de sus planos, el resultado gana de largo.
    for (const frameSharpness of frameSharpnesses) {
      const frameWorstRatio = Math.min(frameSharpness.near / bestNearSharpness, frameSharpness.far / bestFarSharpness);
      const stackedWorstRatio = Math.min(stackedNearSharpness / bestNearSharpness, stackedFarSharpness / bestFarSharpness);
      expect(stackedWorstRatio).toBeGreaterThan(2 * frameWorstRatio);
    }
  });

  it('el mapa de qué foto se usó separa los dos planos (profundidad)', () => {
    function dominantIndexInRegion(firstColumn: number, lastColumn: number): number {
      const indexCounts = new Array<number>(frameCount).fill(0);
      for (let rowIndex = 20; rowIndex < sceneSize - 20; rowIndex++) {
        for (let columnIndex = firstColumn; columnIndex < lastColumn; columnIndex++) {
          indexCounts[result.sourceIndexMap[rowIndex * sceneSize + columnIndex]!]!++;
        }
      }
      return indexCounts.indexOf(Math.max(...indexCounts));
    }
    expect(dominantIndexInRegion(...nearRegion)).toBe(nearPlaneFocusIndex);
    expect(dominantIndexInRegion(...farRegion)).toBe(farPlaneFocusIndex);
    const depthImage = renderSourceIndexMap(result, frameCount);
    expect(depthImage.size).toBe(sceneSize);
    expect(depthColorForFrame(0, frameCount)).toEqual([220, 50, 47]);
    expect(depthColorForFrame(frameCount - 1, frameCount)).toEqual([120, 80, 205]);
  });

  it('elige como mejor foto sola una de las enfocadas en un plano', () => {
    expect([nearPlaneFocusIndex, farPlaneFocusIndex]).toContain(result.bestSingleFrameIndex);
    expect(result.bestSingleImage.size).toBe(sceneSize);
    expect(result.timings.totalMilliseconds).toBeGreaterThanOrEqual(0);
  });
});
