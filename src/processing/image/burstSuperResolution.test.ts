import {
  computeLuminance,
  computeRobustnessMap,
  estimateFrameOffset,
  type FrameOffset,
  kernelSigmaForFrameCount,
  mergeFramesToFinerGrid,
  superResolveBurst,
  upscaleFrameBilinear,
} from './burstSuperResolution';
import type { FloatRgbImage } from './lunarStacking';

const frameSize = 96;
/** Submuestras por lado con que se integra cada píxel del sensor (el píxel no es un punto). */
const sensorSubsamples = 4;

/** Generador pseudoaleatorio con semilla (mulberry32): la escena es siempre la misma. */
function createSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Textura sin periodo visible, como una foto real: ondas de frecuencia (repartida en escala
 * logarítmica), dirección y fase al azar, con amplitud inversa a la frecuencia (espectro 1/f).
 * Parte del detalle está por encima de la frecuencia de Nyquist de un fotograma (0,5
 * ciclos/píxel): un fotograma solo lo confunde (aliasing), pero varios desplazados lo recuperan.
 */
const sceneWaves = (() => {
  const random = createSeededRandom(20260925);
  const lowestFrequency = 0.015;
  const highestFrequency = 0.75;
  return Array.from({ length: 24 }, () => {
    const frequencyCyclesPerPixel = lowestFrequency * (highestFrequency / lowestFrequency) ** random();
    const directionRadians = random() * Math.PI;
    return {
      frequencyX: frequencyCyclesPerPixel * Math.cos(directionRadians),
      frequencyY: frequencyCyclesPerPixel * Math.sin(directionRadians),
      phaseRadians: random() * 2 * Math.PI,
      amplitude: Math.min(30, 1.2 / frequencyCyclesPerPixel) * (0.5 + random()),
    };
  });
})();

function sceneBrightness(positionX: number, positionY: number): number {
  let brightness = 128;
  for (const wave of sceneWaves) {
    brightness +=
      wave.amplitude *
      Math.sin(2 * Math.PI * (wave.frequencyX * positionX + wave.frequencyY * positionY) + wave.phaseRadians);
  }
  return brightness;
}

type SceneFunction = (positionX: number, positionY: number) => number;

/**
 * Fotograma de lado `size` con píxeles de `pixelPitch` unidades de escena, desplazado de modo que
 * lo que en la referencia está en (x, y) aparece en (x + offsetX, y + offsetY).
 */
function renderFrame(scene: SceneFunction, size: number, offset: FrameOffset, pixelPitch = 1): Uint8Array {
  const rgbPixels = new Uint8Array(size * size * 3);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      let brightnessSum = 0;
      for (let subRow = 0; subRow < sensorSubsamples; subRow++) {
        for (let subColumn = 0; subColumn < sensorSubsamples; subColumn++) {
          const sceneX = (columnIndex - 0.5 + (subColumn + 0.5) / sensorSubsamples) * pixelPitch - offset.offsetX;
          const sceneY = (rowIndex - 0.5 + (subRow + 0.5) / sensorSubsamples) * pixelPitch - offset.offsetY;
          brightnessSum += scene(sceneX, sceneY);
        }
      }
      const brightness = Math.round(Math.min(255, Math.max(0, brightnessSum / sensorSubsamples ** 2)));
      rgbPixels.set([brightness, brightness, brightness], (rowIndex * size + columnIndex) * 3);
    }
  }
  return rgbPixels;
}

/**
 * La verdad a doble densidad: el píxel de salida (X, Y) está en la posición de referencia
 * ((X + 0,5) / 2 − 0,5, …) y, como los del sensor, integra un píxel de entrada entero. Es lo que
 * se vería sin aliasing; recuperar más detalle que eso ya sería deconvolución (lo hace el realce).
 */
function renderGroundTruthAtDoubleDensity(scene: SceneFunction, size: number, referenceOffset: FrameOffset): FloatRgbImage {
  const outputSize = size * 2;
  const channels = new Float32Array(outputSize * outputSize * 3);
  for (let outputRow = 0; outputRow < outputSize; outputRow++) {
    for (let outputColumn = 0; outputColumn < outputSize; outputColumn++) {
      let brightnessSum = 0;
      for (let subRow = 0; subRow < sensorSubsamples; subRow++) {
        for (let subColumn = 0; subColumn < sensorSubsamples; subColumn++) {
          const sceneX =
            (outputColumn + 0.5) / 2 - 0.5 - 0.5 + (subColumn + 0.5) / sensorSubsamples - referenceOffset.offsetX;
          const sceneY = (outputRow + 0.5) / 2 - 0.5 - 0.5 + (subRow + 0.5) / sensorSubsamples - referenceOffset.offsetY;
          brightnessSum += scene(sceneX, sceneY);
        }
      }
      const brightness = brightnessSum / sensorSubsamples ** 2;
      channels.set([brightness, brightness, brightness], (outputRow * outputSize + outputColumn) * 3);
    }
  }
  return { size: outputSize, channels };
}

/** Error cuadrático medio en la zona central (los bordes no los cubren todos los fotogramas). */
function centralRootMeanSquareError(image: FloatRgbImage, groundTruth: FloatRgbImage, border: number): number {
  let squaredErrorSum = 0;
  let sampleCount = 0;
  for (let rowIndex = border; rowIndex < image.size - border; rowIndex++) {
    for (let columnIndex = border; columnIndex < image.size - border; columnIndex++) {
      const valueIndex = (rowIndex * image.size + columnIndex) * 3;
      const error = image.channels[valueIndex]! - groundTruth.channels[valueIndex]!;
      squaredErrorSum += error * error;
      sampleCount++;
    }
  }
  return Math.sqrt(squaredErrorSum / sampleCount);
}

const handTremorOffsets: FrameOffset[] = [
  { offsetX: 0, offsetY: 0 },
  { offsetX: 3.5, offsetY: -1.25 },
  { offsetX: -2.3, offsetY: 4.6 },
  { offsetX: 1.75, offsetY: 2.5 },
  { offsetX: -4.4, offsetY: -3.1 },
  { offsetX: 0.5, offsetY: 0.5 },
  { offsetX: 6.2, offsetY: 1.8 },
  { offsetX: -1.6, offsetY: -5.3 },
  { offsetX: 2.25, offsetY: -2.75 },
  { offsetX: -3.8, offsetY: 1.4 },
  { offsetX: 4.9, offsetY: 3.7 },
  { offsetX: -0.7, offsetY: 2.1 },
];

const burstFrames = handTremorOffsets.map((offset) => renderFrame(sceneBrightness, frameSize, offset));

describe('estimateFrameOffset', () => {
  it('encuentra el desplazamiento con precisión subpíxel', () => {
    const referenceLuminance = computeLuminance(burstFrames[0]!, frameSize);
    handTremorOffsets.slice(1).forEach((trueOffset, offsetIndex) => {
      const targetLuminance = computeLuminance(burstFrames[offsetIndex + 1]!, frameSize);
      const estimatedOffset = estimateFrameOffset(referenceLuminance, targetLuminance, frameSize, 16);
      expect(estimatedOffset.offsetX).toBeCloseTo(trueOffset.offsetX, 1);
      expect(estimatedOffset.offsetY).toBeCloseTo(trueOffset.offsetY, 1);
    });
  });

  it('encuentra desplazamientos grandes gracias a la pirámide', () => {
    const largeOffset = { offsetX: 13.4, offsetY: -11.8 };
    const smoothScene: SceneFunction = (positionX, positionY) =>
      128 + 60 * Math.sin(2 * Math.PI * 0.045 * positionX) * Math.cos(2 * Math.PI * 0.035 * positionY) +
      30 * Math.sin(2 * Math.PI * (0.12 * positionX + 0.09 * positionY));
    const referenceLuminance = computeLuminance(renderFrame(smoothScene, frameSize, { offsetX: 0, offsetY: 0 }), frameSize);
    const targetLuminance = computeLuminance(renderFrame(smoothScene, frameSize, largeOffset), frameSize);
    const estimatedOffset = estimateFrameOffset(referenceLuminance, targetLuminance, frameSize, 24);
    expect(estimatedOffset.offsetX).toBeCloseTo(largeOffset.offsetX, 1);
    expect(estimatedOffset.offsetY).toBeCloseTo(largeOffset.offsetY, 1);
  });
});

describe('superresolución por ráfaga', () => {
  const frames = burstFrames;
  const groundTruth = renderGroundTruthAtDoubleDensity(sceneBrightness, frameSize, handTremorOffsets[0]!);
  const comparisonBorder = 24;

  it('con desplazamientos conocidos, recupera detalle que un fotograma solo no tiene', () => {
    const mergedImage = mergeFramesToFinerGrid(
      frames,
      handTremorOffsets,
      frames.map(() => null),
      frameSize,
      { scale: 2, kernelSigmaPixels: kernelSigmaForFrameCount(frames.length) },
    );
    const singleFrameImage = upscaleFrameBilinear(frames[0]!, frameSize, 2);
    const mergedError = centralRootMeanSquareError(mergedImage, groundTruth, comparisonBorder);
    const singleFrameError = centralRootMeanSquareError(singleFrameImage, groundTruth, comparisonBorder);
    expect(mergedError).toBeLessThan(singleFrameError * 0.8);
  });

  it('el proceso completo (alineado incluido) mejora al zoom digital normal', () => {
    const result = superResolveBurst(frames, frameSize, {
      scale: 2,
      keptFraction: 1,
      maximumShiftPixels: 16,
    });
    expect(result.usedFrameCount).toBe(frames.length);
    expect(result.image.size).toBe(frameSize * 2);
    expect(result.meanShiftPixels).toBeGreaterThan(1);
    const referenceGroundTruth = renderGroundTruthAtDoubleDensity(
      sceneBrightness,
      frameSize,
      handTremorOffsets[result.referenceFrameIndex]!,
    );
    const mergedError = centralRootMeanSquareError(result.image, referenceGroundTruth, comparisonBorder);
    const singleFrameError = centralRootMeanSquareError(result.singleFrameImage, referenceGroundTruth, comparisonBorder);
    expect(mergedError).toBeLessThan(singleFrameError * 0.85);
  });

  it('no deja fantasmas de lo que se mueve en la escena', () => {
    // En un fotograma pasa un objeto blanco por una zona: no debe aparecer en el resultado.
    const movingObjectScene: SceneFunction = (positionX, positionY) =>
      positionX > 40 && positionX < 56 && positionY > 40 && positionY < 56 ? 255 : sceneBrightness(positionX, positionY);
    const framesWithMovingObject = frames.map((framePixels, frameIndex) =>
      frameIndex === 3 ? renderFrame(movingObjectScene, frameSize, handTremorOffsets[3]!) : framePixels,
    );
    // La referencia (el fotograma 0) se fija aquí: en el proceso completo sería el más nítido.
    const referenceLuminance = computeLuminance(framesWithMovingObject[0]!, frameSize);
    const robustnessMaps = framesWithMovingObject.map((framePixels, frameIndex) =>
      frameIndex === 0
        ? null
        : computeRobustnessMap(
            referenceLuminance,
            computeLuminance(framePixels, frameSize),
            frameSize,
            handTremorOffsets[frameIndex]!,
          ),
    );
    const mergedImage = mergeFramesToFinerGrid(framesWithMovingObject, handTremorOffsets, robustnessMaps, frameSize, {
      scale: 2,
      kernelSigmaPixels: kernelSigmaForFrameCount(framesWithMovingObject.length),
    });
    const result = { image: mergedImage };
    let objectAreaErrorSum = 0;
    let objectAreaSampleCount = 0;
    for (let outputRow = 84; outputRow < 108; outputRow++) {
      for (let outputColumn = 84; outputColumn < 108; outputColumn++) {
        const valueIndex = (outputRow * result.image.size + outputColumn) * 3;
        objectAreaErrorSum += result.image.channels[valueIndex]! - groundTruth.channels[valueIndex]!;
        objectAreaSampleCount++;
      }
    }
    // Sin el peso de parecido, el objeto (un fotograma de 12, ~+100 niveles) sumaría ~+8 de media.
    expect(objectAreaErrorSum / objectAreaSampleCount).toBeLessThan(3);
  });
});
