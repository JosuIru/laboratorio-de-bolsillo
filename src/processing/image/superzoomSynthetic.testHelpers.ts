/**
 * Escena sintética y ráfagas simuladas para probar las mejoras del superzoom.
 *
 * La escena es una suma de ondas (textura sin periodo visible, espectro 1/f): así el desenfoque
 * gaussiano de la óptica es exacto (cada onda se atenúa por exp(−2π²σ²f²)) y se puede muestrear
 * en cualquier posición, que es lo que hace falta para simular giros, cizallas y aberración
 * cromática sin interpolar.
 */

import { createSeededRandom } from './grayImage';

export interface SceneWave {
  frequencyX: number;
  frequencyY: number;
  phaseRadians: number;
  amplitude: number;
}

export function createSceneWaves(seed: number, waveCount = 28, highestFrequency = 0.6): SceneWave[] {
  const random = createSeededRandom(seed);
  const lowestFrequency = 0.012;
  return Array.from({ length: waveCount }, () => {
    const frequencyCyclesPerPixel = lowestFrequency * (highestFrequency / lowestFrequency) ** random();
    const directionRadians = random() * Math.PI;
    return {
      frequencyX: frequencyCyclesPerPixel * Math.cos(directionRadians),
      frequencyY: frequencyCyclesPerPixel * Math.sin(directionRadians),
      phaseRadians: random() * 2 * Math.PI,
      amplitude: Math.min(26, 1.1 / frequencyCyclesPerPixel) * (0.5 + random()),
    };
  });
}

/** Atenuación de cada onda por una gaussiana de σ = `blurSigmaPixels`: exp(−2π²σ²f²). */
function waveAttenuations(sceneWaves: readonly SceneWave[], blurSigmaPixels: number): Float64Array {
  return Float64Array.from(sceneWaves, (wave) =>
    Math.exp(-2 * Math.PI * Math.PI * blurSigmaPixels * blurSigmaPixels * (wave.frequencyX ** 2 + wave.frequencyY ** 2)),
  );
}

const attenuationCache = new WeakMap<readonly SceneWave[], Map<number, Float64Array>>();

function cachedWaveAttenuations(sceneWaves: readonly SceneWave[], blurSigmaPixels: number): Float64Array {
  let attenuationsBySigma = attenuationCache.get(sceneWaves);
  if (!attenuationsBySigma) {
    attenuationsBySigma = new Map();
    attenuationCache.set(sceneWaves, attenuationsBySigma);
  }
  let attenuations = attenuationsBySigma.get(blurSigmaPixels);
  if (!attenuations) {
    attenuations = waveAttenuations(sceneWaves, blurSigmaPixels);
    attenuationsBySigma.set(blurSigmaPixels, attenuations);
  }
  return attenuations;
}

/** Brillo de la escena desenfocada con una gaussiana de σ = `blurSigmaPixels` (en unidades de la escena). */
export function blurredSceneBrightness(
  sceneWaves: readonly SceneWave[],
  positionX: number,
  positionY: number,
  blurSigmaPixels: number,
): number {
  const attenuations = cachedWaveAttenuations(sceneWaves, blurSigmaPixels);
  let brightness = 128;
  for (let waveIndex = 0; waveIndex < sceneWaves.length; waveIndex++) {
    const wave = sceneWaves[waveIndex]!;
    brightness +=
      attenuations[waveIndex]! *
      wave.amplitude *
      Math.sin(2 * Math.PI * (wave.frequencyX * positionX + wave.frequencyY * positionY) + wave.phaseRadians);
  }
  return brightness;
}

/**
 * Dónde cae en la escena el píxel (x, y) de un fotograma: giro alrededor del centro, traslación y
 * cizalla horizontal por filas (obturador electrónico con la mano moviéndose de lado).
 */
export interface FrameMotion {
  rotationDegrees: number;
  translationX: number;
  translationY: number;
  /** Píxeles de desplazamiento horizontal por cada fila de lectura. */
  rollingShutterShear: number;
}

export function frameToScenePosition(motion: FrameMotion, size: number, positionX: number, positionY: number): { x: number; y: number } {
  const center = (size - 1) / 2;
  const rotationRadians = (motion.rotationDegrees * Math.PI) / 180;
  const relativeX = positionX - center;
  const relativeY = positionY - center;
  return {
    x:
      center +
      Math.cos(rotationRadians) * relativeX -
      Math.sin(rotationRadians) * relativeY +
      motion.translationX +
      motion.rollingShutterShear * relativeY,
    y: center + Math.sin(rotationRadians) * relativeX + Math.cos(rotationRadians) * relativeY + motion.translationY,
  };
}

/** Inversa de `frameToScenePosition` (es afín: se invierte la matriz 2×2). */
export function sceneToFramePosition(motion: FrameMotion, size: number, sceneX: number, sceneY: number): { x: number; y: number } {
  const center = (size - 1) / 2;
  const rotationRadians = (motion.rotationDegrees * Math.PI) / 180;
  const matrixXX = Math.cos(rotationRadians);
  const matrixXY = -Math.sin(rotationRadians) + motion.rollingShutterShear;
  const matrixYX = Math.sin(rotationRadians);
  const matrixYY = Math.cos(rotationRadians);
  const determinant = matrixXX * matrixYY - matrixXY * matrixYX;
  const relativeX = sceneX - center - motion.translationX;
  const relativeY = sceneY - center - motion.translationY;
  return {
    x: center + (matrixYY * relativeX - matrixXY * relativeY) / determinant,
    y: center + (-matrixYX * relativeX + matrixXX * relativeY) / determinant,
  };
}

/** Ruido gaussiano (Box-Muller) con la semilla dada. */
export function createGaussianNoise(seed: number): () => number {
  const random = createSeededRandom(seed);
  return () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
}

export interface RenderFrameOptions {
  size: number;
  motion: FrameMotion;
  opticalBlurSigmaPixels: number;
  noiseSigma: number;
  noiseSeed: number;
}

/** Fotograma RGB de 8 bits (gris con un tinte leve por canal) de la escena vista con `motion`. */
export function renderSyntheticFrame(sceneWaves: readonly SceneWave[], options: RenderFrameOptions): Uint8Array {
  const { size, motion, opticalBlurSigmaPixels, noiseSigma } = options;
  const nextNoise = createGaussianNoise(options.noiseSeed);
  const channelTints = [1.02, 1, 0.94];
  const rgbPixels = new Uint8Array(size * size * 3);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      const scenePosition = frameToScenePosition(motion, size, columnIndex, rowIndex);
      const brightness = blurredSceneBrightness(sceneWaves, scenePosition.x, scenePosition.y, opticalBlurSigmaPixels);
      for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        const noisyValue = brightness * channelTints[channelIndex]! + noiseSigma * nextNoise();
        rgbPixels[(rowIndex * size + columnIndex) * 3 + channelIndex] = Math.max(0, Math.min(255, Math.round(noisyValue)));
      }
    }
  }
  return rgbPixels;
}

/** Error cuadrático medio entre dos planos, sin un margen de `margin` píxeles por lado. */
export function interiorRootMeanSquareError(
  firstValues: ArrayLike<number>,
  secondValues: ArrayLike<number>,
  size: number,
  margin: number,
): number {
  let squaredErrorSum = 0;
  let sampleCount = 0;
  for (let rowIndex = margin; rowIndex < size - margin; rowIndex++) {
    for (let columnIndex = margin; columnIndex < size - margin; columnIndex++) {
      const difference = firstValues[rowIndex * size + columnIndex]! - secondValues[rowIndex * size + columnIndex]!;
      squaredErrorSum += difference * difference;
      sampleCount++;
    }
  }
  return Math.sqrt(squaredErrorSum / Math.max(1, sampleCount));
}
