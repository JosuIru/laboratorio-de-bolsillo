import { estimateFrameOffset } from './burstSuperResolution';
import { createSeededRandom, gaussianBlurGray, type GrayImage } from './grayImage';
import {
  enhanceWithWavelets,
  frameSourceFromArray,
  interpolateDisplacementField,
  measureLaplacianSharpness,
  selectSharpestFrameIndices,
  stackLuckyFrames,
  warpFrame,
} from './luckyImaging';
import { createCachedScene, createGaussianNoise, createWaveTexture } from './syntheticMoon.testHelpers';

const frameSize = 96;
const sceneTexture = createWaveTexture(2024, 30, 0.02, 0.2, 0.35);
const sceneBrightness = createCachedScene((positionX, positionY) => 120 * sceneTexture(positionX, positionY), -20, 116, 0.25);

type DisplacementFunction = (positionX: number, positionY: number) => [number, number];

/** Fotograma: en (x, y) se ve lo que la escena tiene en (x, y) − desplazamiento(x, y). */
function renderDistortedFrame(displacement: DisplacementFunction, noiseSigma: number, noiseSeed: number): GrayImage {
  const subsamples = 3;
  const values = new Float32Array(frameSize * frameSize);
  const gaussianNoise = createGaussianNoise(noiseSeed);
  for (let rowIndex = 0; rowIndex < frameSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < frameSize; columnIndex++) {
      const [shiftX, shiftY] = displacement(columnIndex, rowIndex);
      let brightnessSum = 0;
      for (let subRow = 0; subRow < subsamples; subRow++) {
        for (let subColumn = 0; subColumn < subsamples; subColumn++) {
          brightnessSum += sceneBrightness(
            columnIndex - 0.5 + (subColumn + 0.5) / subsamples - shiftX,
            rowIndex - 0.5 + (subRow + 0.5) / subsamples - shiftY,
          );
        }
      }
      values[rowIndex * frameSize + columnIndex] = brightnessSum / subsamples ** 2 + noiseSigma * gaussianNoise();
    }
  }
  return { width: frameSize, height: frameSize, values };
}

/** Deformación suave al azar (turbulencia): suma de ondas largas con amplitud ~`amplitude` px. */
function createTurbulence(seed: number, amplitude: number, globalShiftX: number, globalShiftY: number): DisplacementFunction {
  const random = createSeededRandom(seed);
  const waves = Array.from({ length: 4 }, () => ({
    frequencyX: (random() - 0.5) / 25,
    frequencyY: (random() - 0.5) / 25,
    phaseX: random() * 2 * Math.PI,
    phaseY: random() * 2 * Math.PI,
  }));
  return (positionX, positionY) => {
    let shiftX = globalShiftX;
    let shiftY = globalShiftY;
    for (const wave of waves) {
      const argument = 2 * Math.PI * (wave.frequencyX * positionX + wave.frequencyY * positionY);
      shiftX += (amplitude / 2) * Math.sin(argument + wave.phaseX);
      shiftY += (amplitude / 2) * Math.sin(argument + wave.phaseY);
    }
    return [shiftX, shiftY];
  };
}

/** Error cuadrático medio tras registrar el resultado con la verdad (el apilado queda en la geometría de su referencia). */
function registeredRmsError(result: GrayImage, truth: GrayImage, margin: number): number {
  const offset = estimateFrameOffset(truth.values, result.values, frameSize, 8);
  const registered = warpFrame(result, offset);
  let squaredErrorSum = 0;
  let sampleCount = 0;
  for (let rowIndex = margin; rowIndex < frameSize - margin; rowIndex++) {
    for (let columnIndex = margin; columnIndex < frameSize - margin; columnIndex++) {
      const pixelIndex = rowIndex * frameSize + columnIndex;
      squaredErrorSum += (registered.values[pixelIndex]! - truth.values[pixelIndex]!) ** 2;
      sampleCount++;
    }
  }
  return Math.sqrt(squaredErrorSum / sampleCount);
}

describe('nitidez y selección', () => {
  it('ordena los fotogramas por nitidez y se queda con la fracción pedida', () => {
    const sharpFrame = renderDistortedFrame(() => [0, 0], 1, 1);
    const blurSigmas = [1.5, 0, 2.5, 0.7, 1.0];
    const frames = blurSigmas.map((blurSigma) => gaussianBlurGray(sharpFrame, blurSigma));
    const sharpnessScores = frames.map((frame) => measureLaplacianSharpness(frame));
    expect(selectSharpestFrameIndices(sharpnessScores, 0.4)).toEqual([1, 3]);
    expect(selectSharpestFrameIndices(sharpnessScores, 0)).toEqual([1]);
    // Un artefacto brillante y nítido en una esquina no lo convierte en el más nítido.
    const frameWithArtifact = { ...frames[4]!, values: frames[4]!.values.slice() };
    for (let rowIndex = 10; rowIndex < 14; rowIndex++) {
      for (let columnIndex = 10; columnIndex < 60; columnIndex++) frameWithArtifact.values[rowIndex * frameSize + columnIndex] = 255;
    }
    expect(measureLaplacianSharpness(frameWithArtifact)).toBeLessThan(sharpnessScores[3]!);
    // El brillo no cambia el orden (una nube fina baja todo por igual).
    const dimmedFrame = { ...frames[1]!, values: frames[1]!.values.map((value) => value * 0.5) };
    expect(measureLaplacianSharpness(dimmedFrame)).toBeCloseTo(sharpnessScores[1]!, 6);
  });
});

describe('campo de desplazamientos', () => {
  it('interpola un desplazamiento uniforme y deforma como se espera', () => {
    const localShifts = [30, 50, 70].flatMap((positionY) =>
      [30, 50, 70].map((positionX) => ({ positionX, positionY, shiftX: 1.5, shiftY: -0.5 })),
    );
    const field = interpolateDisplacementField(localShifts, frameSize, 12);
    const centerIndex = Math.round(50 / field.gridStepPixels) * field.gridColumns + Math.round(50 / field.gridStepPixels);
    expect(field.shiftX[centerIndex]).toBeCloseTo(1.5, 1);
    expect(field.shiftY[centerIndex]).toBeCloseTo(-0.5, 1);
    // Lejos de todos los puntos, el campo vuelve a 0 (solo alineado global).
    expect(Math.abs(field.shiftX[0]!)).toBeLessThan(0.3);
  });
});

describe('stackLuckyFrames', () => {
  const truth = renderDistortedFrame(() => [0, 0], 0, 0);

  it('el alineado por puntos recupera mejor una escena con deformación local que el alineado global', () => {
    const frames = Array.from({ length: 24 }, (_unused, frameIndex) => {
      const random = createSeededRandom(500 + frameIndex);
      return renderDistortedFrame(
        createTurbulence(900 + frameIndex, 1.6, (random() - 0.5) * 6, (random() - 0.5) * 6),
        2,
        frameIndex,
      );
    });
    const frameSource = frameSourceFromArray(frames);
    const globalOnly = stackLuckyFrames(frameSource, { keptFraction: 1, alignmentPointSpacingPixels: 0 });
    const withAlignmentPoints = stackLuckyFrames(frameSource, { keptFraction: 1, alignmentPointSpacingPixels: 12 });
    const globalOnlyError = registeredRmsError(globalOnly.image, truth, 14);
    const alignmentPointsError = registeredRmsError(withAlignmentPoints.image, truth, 14);
    expect(withAlignmentPoints.alignmentPointCount).toBeGreaterThan(20);
    expect(alignmentPointsError).toBeLessThan(0.7 * globalOnlyError);
  });

  it('el sigma-clipping elimina un fotograma con un artefacto (un avión)', () => {
    const frames = Array.from({ length: 12 }, (_unused, frameIndex) => renderDistortedFrame(() => [0, 0], 2, 40 + frameIndex));
    // El del avión, algo más borroso que los demás: la nitidez por bloques no lo toma como el mejor.
    frames[4] = gaussianBlurGray(frames[4]!, 0.6);
    const artifactFrame = frames[4];
    for (let rowIndex = 40; rowIndex < 46; rowIndex++) {
      for (let columnIndex = 20; columnIndex < 76; columnIndex++) {
        artifactFrame.values[rowIndex * frameSize + columnIndex] = 255;
      }
    }
    const artifactError = (image: GrayImage) => {
      let largestError = 0;
      for (let rowIndex = 40; rowIndex < 46; rowIndex++) {
        for (let columnIndex = 24; columnIndex < 72; columnIndex++) {
          const pixelIndex = rowIndex * frameSize + columnIndex;
          largestError = Math.max(largestError, Math.abs(image.values[pixelIndex]! - truth.values[pixelIndex]!));
        }
      }
      return largestError;
    };
    const frameSource = frameSourceFromArray(frames);
    const plainMean = stackLuckyFrames(frameSource, { keptFraction: 1, alignmentPointSpacingPixels: 0, sigmaClippingKappa: 0 });
    const clipped = stackLuckyFrames(frameSource, { keptFraction: 1, alignmentPointSpacingPixels: 0, sigmaClippingKappa: 2.5 });
    expect(artifactError(plainMean.image)).toBeGreaterThan(6);
    expect(clipped.usedFrameIndices[0]).not.toBe(4);
    expect(artifactError(clipped.image)).toBeLessThan(4);
    expect(clipped.rejectedSampleFraction).toBeLessThan(0.05);
  });

  it('pide cada fotograma a la fuente sin guardarlos (memoria acotada)', () => {
    const baseFrame = renderDistortedFrame(() => [0, 0], 0, 0);
    const loadCounts = new Array<number>(10).fill(0);
    const result = stackLuckyFrames(
      {
        frameCount: 10,
        loadFrame: (frameIndex) => {
          loadCounts[frameIndex]!++;
          return { ...baseFrame, values: baseFrame.values.map((value) => value + frameIndex * 0.01) };
        },
      },
      { keptFraction: 0.5 },
    );
    expect(result.usedFrameIndices).toHaveLength(5);
    expect(loadCounts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(10 + 5 * 5 + 1);
  });
});

describe('enhanceWithWavelets', () => {
  const blurredScene = gaussianBlurGray(renderDistortedFrame(() => [0, 0], 0, 0), 1.2);

  it('con ganancias 1 devuelve la imagen original', () => {
    const reconstructed = enhanceWithWavelets(blurredScene, { levelGains: [1, 1, 1, 1] });
    for (let pixelIndex = 0; pixelIndex < blurredScene.values.length; pixelIndex += 97) {
      expect(reconstructed.values[pixelIndex]).toBeCloseTo(blurredScene.values[pixelIndex]!, 3);
    }
  });

  it('con ganancias > 1 en los niveles finos realza el detalle sin cambiar el brillo medio', () => {
    const enhanced = enhanceWithWavelets(blurredScene, { levelGains: [2, 1.6, 1.2, 1] });
    expect(measureLaplacianSharpness(enhanced, undefined, 0)).toBeGreaterThan(2 * measureLaplacianSharpness(blurredScene, undefined, 0));
    const meanOf = (image: GrayImage) => image.values.reduce((sum, value) => sum + value, 0) / image.values.length;
    expect(Math.abs(meanOf(enhanced) - meanOf(blurredScene))).toBeLessThan(0.5);
  });

  it('el umbral de ruido evita amplificar el ruido de una zona lisa', () => {
    const gaussianNoise = createGaussianNoise(3);
    const flatNoisy: GrayImage = {
      width: 64,
      height: 64,
      values: Float32Array.from({ length: 64 * 64 }, () => 100 + 3 * gaussianNoise()),
    };
    const standardDeviation = (image: GrayImage) => {
      const mean = image.values.reduce((sum, value) => sum + value, 0) / image.values.length;
      return Math.sqrt(image.values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / image.values.length);
    };
    const amplified = enhanceWithWavelets(flatNoisy, { levelGains: [2, 2, 1] });
    const denoised = enhanceWithWavelets(flatNoisy, { levelGains: [2, 2, 1], noiseThresholdSigmas: 3 });
    expect(standardDeviation(amplified)).toBeGreaterThan(1.5 * standardDeviation(flatNoisy));
    expect(standardDeviation(denoised)).toBeLessThan(standardDeviation(flatNoisy));
  });
});
