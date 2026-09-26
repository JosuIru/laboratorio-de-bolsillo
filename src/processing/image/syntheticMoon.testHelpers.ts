/**
 * Lunas sintéticas para los tests: disco con fase, textura, desenfoque y ruido conocidos.
 * No es código de la app (solo lo importan los tests).
 */

import { createSeededRandom, gaussianBlurGray, type GrayImage } from './grayImage';

export interface SyntheticMoonParameters {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  radius: number;
  /** Ángulo de fase: 0 = llena, 90 = cuarto, 180 = nueva. */
  phaseAngleDegrees?: number;
  /** Hacia dónde está el limbo iluminado en la imagen (0 = derecha, 90 = abajo). */
  litDirectionDegrees?: number;
  diskBrightness?: number;
  backgroundBrightness?: number;
  /** Brillo de la parte en sombra (luz cenicienta), 0 por defecto. */
  shadowBrightness?: number;
  /** Factor de albedo en coordenadas relativas al centro del disco. */
  albedo?: (relativeX: number, relativeY: number) => number;
  subsamplesPerSide?: number;
  blurSigmaPixels?: number;
  noiseSigma?: number;
  randomSeed?: number;
}

/** Ruido gaussiano (Box-Muller) con un generador con semilla. */
export function createGaussianNoise(seed: number): () => number {
  const random = createSeededRandom(seed);
  return () => Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(2 * Math.PI * random());
}

export function renderSyntheticMoon(parameters: SyntheticMoonParameters): GrayImage {
  const {
    width,
    height,
    centerX,
    centerY,
    radius,
    phaseAngleDegrees = 0,
    litDirectionDegrees = 0,
    diskBrightness = 200,
    backgroundBrightness = 10,
    shadowBrightness = 0,
    albedo = () => 1,
    subsamplesPerSide = 6,
    blurSigmaPixels = 0,
    noiseSigma = 0,
    randomSeed = 7,
  } = parameters;
  const phaseAngle = (phaseAngleDegrees * Math.PI) / 180;
  const litDirection = (litDirectionDegrees * Math.PI) / 180;
  const sunX = Math.sin(phaseAngle) * Math.cos(litDirection);
  const sunY = Math.sin(phaseAngle) * Math.sin(litDirection);
  const sunZ = Math.cos(phaseAngle);
  const values = new Float32Array(width * height);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      let brightnessSum = 0;
      for (let subRow = 0; subRow < subsamplesPerSide; subRow++) {
        for (let subColumn = 0; subColumn < subsamplesPerSide; subColumn++) {
          const relativeX = columnIndex - 0.5 + (subColumn + 0.5) / subsamplesPerSide - centerX;
          const relativeY = rowIndex - 0.5 + (subRow + 0.5) / subsamplesPerSide - centerY;
          const normalizedX = relativeX / radius;
          const normalizedY = relativeY / radius;
          const squaredDistance = normalizedX * normalizedX + normalizedY * normalizedY;
          if (squaredDistance >= 1) {
            brightnessSum += backgroundBrightness;
            continue;
          }
          const normalizedZ = Math.sqrt(1 - squaredDistance);
          const isLit = normalizedX * sunX + normalizedY * sunY + normalizedZ * sunZ > 0;
          const surfaceBrightness = (isLit ? diskBrightness : shadowBrightness) * albedo(relativeX, relativeY);
          brightnessSum += backgroundBrightness + surfaceBrightness;
        }
      }
      values[rowIndex * width + columnIndex] = brightnessSum / subsamplesPerSide ** 2;
    }
  }
  const blurredImage = gaussianBlurGray({ width, height, values }, blurSigmaPixels);
  if (noiseSigma > 0) {
    const gaussianNoise = createGaussianNoise(randomSeed);
    for (let pixelIndex = 0; pixelIndex < blurredImage.values.length; pixelIndex++) {
      blurredImage.values[pixelIndex] = blurredImage.values[pixelIndex]! + noiseSigma * gaussianNoise();
    }
  }
  return blurredImage;
}

/**
 * Textura sin periodo visible (ondas al azar con espectro ~1/f), en torno a 1, para el albedo
 * o una escena. `highestFrequency` en ciclos por píxel.
 */
export function createWaveTexture(
  seed: number,
  waveCount: number,
  lowestFrequency: number,
  highestFrequency: number,
  relativeAmplitude: number,
): (positionX: number, positionY: number) => number {
  const random = createSeededRandom(seed);
  const waves = Array.from({ length: waveCount }, () => {
    const frequency = lowestFrequency * (highestFrequency / lowestFrequency) ** random();
    const direction = random() * Math.PI;
    return {
      frequencyX: frequency * Math.cos(direction),
      frequencyY: frequency * Math.sin(direction),
      phase: random() * 2 * Math.PI,
      amplitude: (0.5 + random()) * Math.min(1, lowestFrequency * 4 / frequency),
    };
  });
  const amplitudeSum = waves.reduce((sum, wave) => sum + wave.amplitude, 0);
  return (positionX, positionY) => {
    let textureValue = 0;
    for (const wave of waves) {
      textureValue += wave.amplitude * Math.sin(2 * Math.PI * (wave.frequencyX * positionX + wave.frequencyY * positionY) + wave.phase);
    }
    return 1 + (relativeAmplitude * textureValue) / Math.sqrt(amplitudeSum * waveCount / 4);
  };
}
