import { kernelSigmaForFrameCount, sharpeningSigmaForScale } from './burstSuperResolution';
import {
  bilinearUpscalePsfSigma,
  createGaussianPlaneBlur,
  deconvolveImageLevels,
  deconvolvePlaneAccelerated,
  devicePsfSigmaForZoom,
  superResolutionPsfSigma,
} from './burstDeconvolution';
import { superResolveBurstWithLocalAlignment } from './localBurstAlignment';
import { type FloatRgbImage, sharpenImage } from './lunarStacking';
import {
  blurredSceneBrightness,
  createGaussianNoise,
  createSceneWaves,
  frameToScenePosition,
  interiorRootMeanSquareError,
  renderSyntheticFrame,
} from './superzoomSynthetic.testHelpers';

const sceneWaves = createSceneWaves(4242, 24, 0.55);

function greenPlane(image: FloatRgbImage): Float32Array {
  const plane = new Float32Array(image.size * image.size);
  for (let pixelIndex = 0; pixelIndex < plane.length; pixelIndex++) plane[pixelIndex] = image.channels[pixelIndex * 3 + 1]!;
  return plane;
}

describe('createGaussianPlaneBlur', () => {
  it('conserva la media y suaviza como una gaussiana', () => {
    const size = 40;
    const impulse = new Float32Array(size * size);
    impulse[20 * size + 20] = 100;
    const blurred = new Float32Array(size * size);
    createGaussianPlaneBlur(size, 1.5)(impulse, blurred);
    const total = blurred.reduce((valueSum, value) => valueSum + value, 0);
    expect(total).toBeCloseTo(100, 3);
    // Varianza de la respuesta a un impulso ≈ σ² en cada eje (el núcleo corta en 2,5σ).
    let horizontalVariance = 0;
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      let columnSum = 0;
      for (let rowIndex = 0; rowIndex < size; rowIndex++) columnSum += blurred[rowIndex * size + columnIndex]!;
      horizontalVariance += (columnSum / 100) * (columnIndex - 20) ** 2;
    }
    expect(Math.sqrt(horizontalVariance)).toBeGreaterThan(1.35);
    expect(Math.sqrt(horizontalVariance)).toBeLessThan(1.55);
  });
});

describe('deconvolvePlaneAccelerated', () => {
  const size = 128;
  const blurSigma = 1.5;
  const nextNoise = createGaussianNoise(7);
  const sharpPlane = new Float32Array(size * size);
  const blurredNoisyPlane = new Float32Array(size * size);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      const pixelIndex = rowIndex * size + columnIndex;
      // La escena a media escala: sus ondas llegan a ~0,28 ciclos/px, bajo el límite de la rejilla.
      sharpPlane[pixelIndex] = blurredSceneBrightness(sceneWaves, columnIndex / 2, rowIndex / 2, 0.2);
      blurredNoisyPlane[pixelIndex] = blurredSceneBrightness(sceneWaves, columnIndex / 2, rowIndex / 2, Math.hypot(0.2, blurSigma / 2)) + nextNoise();
    }
  }

  it('cada nivel se acerca más a la escena nítida', () => {
    const [softPlane, mediumPlane, strongPlane] = deconvolvePlaneAccelerated(blurredNoisyPlane, size, blurSigma, {
      snapshotIterations: [2, 4, 7],
      dampingNoiseSigmas: 0.5,
    });
    const blurredError = interiorRootMeanSquareError(blurredNoisyPlane, sharpPlane, size, 8);
    const softError = interiorRootMeanSquareError(softPlane!, sharpPlane, size, 8);
    const mediumError = interiorRootMeanSquareError(mediumPlane!, sharpPlane, size, 8);
    const strongError = interiorRootMeanSquareError(strongPlane!, sharpPlane, size, 8);
    expect(softError).toBeLessThan(0.97 * blurredError);
    expect(mediumError).toBeLessThan(softError);
    expect(strongError).toBeLessThan(mediumError);
    expect(strongError).toBeLessThan(0.9 * blurredError);
    console.info(
      `RL acelerado (σ ${blurSigma}): error ${blurredError.toFixed(2)} → ${softError.toFixed(2)} / ` +
        `${mediumError.toFixed(2)} / ${strongError.toFixed(2)} niveles (suave / medio / fuerte)`,
    );
  });

  it('con el umbral sobre el cambio, no sube el ruido de una zona lisa', () => {
    const flatSize = 64;
    const nextFlatNoise = createGaussianNoise(11);
    const flatChannels = new Float32Array(flatSize * flatSize * 3);
    for (let pixelIndex = 0; pixelIndex < flatSize * flatSize; pixelIndex++) {
      const noisyValue = 120 + 2 * nextFlatNoise();
      flatChannels[pixelIndex * 3] = noisyValue;
      flatChannels[pixelIndex * 3 + 1] = noisyValue;
      flatChannels[pixelIndex * 3 + 2] = noisyValue;
    }
    const flatImage: FloatRgbImage = { size: flatSize, channels: flatChannels };
    const standardDeviation = (values: Float32Array) => {
      const mean = values.reduce((valueSum, value) => valueSum + value, 0) / values.length;
      return Math.sqrt(values.reduce((squaredSum, value) => squaredSum + (value - mean) ** 2, 0) / values.length);
    };
    const originalDeviation = standardDeviation(greenPlane(flatImage));
    const strongDeviation = standardDeviation(greenPlane(deconvolveImageLevels(flatImage, blurSigma).images.strong));
    const rawStrongPlane = deconvolvePlaneAccelerated(greenPlane(flatImage), flatSize, blurSigma, {
      snapshotIterations: [7],
      dampingNoiseSigmas: 0,
    })[0]!;
    expect(strongDeviation).toBeLessThan(1.2 * originalDeviation);
    expect(standardDeviation(rawStrongPlane)).toBeGreaterThan(1.3 * originalDeviation);
    console.info(
      `Ruido en zona lisa: ${originalDeviation.toFixed(2)} → ${strongDeviation.toFixed(2)} (fuerte con umbral), ` +
        `${standardDeviation(rawStrongPlane).toFixed(2)} sin amortiguar ni umbral`,
    );
  });
});

describe('PSF del superzoom', () => {
  it('combina la del móvil, el núcleo de fusión y el alineado', () => {
    expect(superResolutionPsfSigma(0.66, 0.4, 2)).toBeCloseTo(1.556, 2);
    expect(bilinearUpscalePsfSigma(0.66, 2)).toBeCloseTo(1.552, 2);
    expect(devicePsfSigmaForZoom(1)).toBeCloseTo(0.66, 5);
    expect(devicePsfSigmaForZoom(4)).toBeCloseTo(1.32, 5);
  });

  it('tras la fusión, la deconvolución con esa PSF acerca más a la escena que la máscara de enfoque', () => {
    const frameSize = 128;
    const opticalBlurSigma = 0.66;
    const translations = [
      [0, 0],
      [0.5, 0.25],
      [0.25, 0.75],
      [0.75, 0.5],
      [1.3, -0.6],
      [-0.4, 1.1],
      [0.9, 1.4],
      [-1.2, -0.3],
      [0.1, -1.4],
      [1.6, 0.9],
    ] as const;
    const frames = translations.map(([translationX, translationY], frameIndex) =>
      renderSyntheticFrame(sceneWaves, {
        size: frameSize,
        motion: { rotationDegrees: 0, translationX, translationY, rollingShutterShear: 0 },
        opticalBlurSigmaPixels: opticalBlurSigma,
        noiseSigma: 1.5,
        noiseSeed: 300 + frameIndex,
      }),
    );
    const result = superResolveBurstWithLocalAlignment(frames, frameSize, {
      scale: 2,
      keptFraction: 0.5,
      maximumShiftPixels: 8,
      useLocalAlignment: false,
    });
    const outputSize = frameSize * 2;
    const referenceMotion = {
      rotationDegrees: 0,
      translationX: translations[result.referenceFrameIndex]![0],
      translationY: translations[result.referenceFrameIndex]![1],
      rollingShutterShear: 0,
    };
    // Lo nítido que podría ser: la escena sin la óptica (con el mínimo que admite la rejilla fina).
    const sharpGreen = new Float32Array(outputSize * outputSize);
    for (let outputRow = 0; outputRow < outputSize; outputRow++) {
      for (let outputColumn = 0; outputColumn < outputSize; outputColumn++) {
        const scenePosition = frameToScenePosition(referenceMotion, frameSize, (outputColumn + 0.5) / 2 - 0.5, (outputRow + 0.5) / 2 - 0.5);
        sharpGreen[outputRow * outputSize + outputColumn] = blurredSceneBrightness(sceneWaves, scenePosition.x, scenePosition.y, 0.2);
      }
    }
    const errorOf = (image: FloatRgbImage) => interiorRootMeanSquareError(greenPlane(image), sharpGreen, outputSize, 16);
    const kernelSigma = kernelSigmaForFrameCount(result.usedFrameCount);
    const psfSigma = superResolutionPsfSigma(opticalBlurSigma, kernelSigma, 2);
    const deconvolved = deconvolveImageLevels(result.image, psfSigma);
    const mergedError = errorOf(result.image);
    const deconvolvedErrors = {
      soft: errorOf(deconvolved.images.soft),
      medium: errorOf(deconvolved.images.medium),
      strong: errorOf(deconvolved.images.strong),
    };
    const unsharpMaskErrors = [0.5, 1, 1.6].map((amount) => errorOf(sharpenImage(result.image, sharpeningSigmaForScale(2), amount)));
    expect(deconvolvedErrors.medium).toBeLessThan(0.8 * mergedError);
    // El nivel fuerte queda más cerca de la escena que la máscara de enfoque media (cantidad 1).
    expect(deconvolvedErrors.strong).toBeLessThan(unsharpMaskErrors[1]!);

    // Justificación del σ: con la PSF calculada se queda cerca del mejor de varios σ probados.
    const candidateSigmas = [0.9, 1.2, psfSigma, 1.9, 2.3];
    const candidateErrors = candidateSigmas.map((candidateSigma) => errorOf(deconvolveImageLevels(result.image, candidateSigma).images.medium));
    expect(candidateErrors[2]!).toBeLessThanOrEqual(1.05 * Math.min(...candidateErrors));
    console.info(
      `Fusión: ${mergedError.toFixed(2)}; deconvolución σ ${psfSigma.toFixed(2)} suave/medio/fuerte ` +
        `${deconvolvedErrors.soft.toFixed(2)}/${deconvolvedErrors.medium.toFixed(2)}/${deconvolvedErrors.strong.toFixed(2)}; ` +
        `máscara 0,5/1/1,6 ${unsharpMaskErrors.map((error) => error.toFixed(2)).join('/')}; ` +
        `σ probados ${candidateSigmas.map((sigma, index) => `${sigma.toFixed(2)}→${candidateErrors[index]!.toFixed(2)}`).join(', ')}`,
    );
  });
});
