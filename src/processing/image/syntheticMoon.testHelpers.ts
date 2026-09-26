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
  // Arrays planos y bucle indexado: la textura se evalúa millones de veces en los tests.
  const frequenciesX = Float64Array.from(waves, (wave) => 2 * Math.PI * wave.frequencyX);
  const frequenciesY = Float64Array.from(waves, (wave) => 2 * Math.PI * wave.frequencyY);
  const phases = Float64Array.from(waves, (wave) => wave.phase);
  const amplitudes = Float64Array.from(waves, (wave) => wave.amplitude);
  const normalization = relativeAmplitude / Math.sqrt((amplitudeSum * waveCount) / 4);
  return (positionX, positionY) => {
    let textureValue = 0;
    for (let waveIndex = 0; waveIndex < waveCount; waveIndex++) {
      textureValue +=
        amplitudes[waveIndex]! *
        Math.sin(frequenciesX[waveIndex]! * positionX + frequenciesY[waveIndex]! * positionY + phases[waveIndex]!);
    }
    return 1 + textureValue * normalization;
  };
}

/**
 * Escena precalculada en una rejilla fina y leída con interpolación bilineal: mucho más rápida
 * que evaluar las ondas en cada submuestra (vale para texturas muy por debajo de 1/(2·paso)).
 */
export function createCachedScene(
  scene: (positionX: number, positionY: number) => number,
  minimumCoordinate: number,
  maximumCoordinate: number,
  gridStep: number,
): (positionX: number, positionY: number) => number {
  const gridSide = Math.ceil((maximumCoordinate - minimumCoordinate) / gridStep) + 2;
  const gridValues = new Float32Array(gridSide * gridSide);
  for (let gridRow = 0; gridRow < gridSide; gridRow++) {
    for (let gridColumn = 0; gridColumn < gridSide; gridColumn++) {
      gridValues[gridRow * gridSide + gridColumn] = scene(
        minimumCoordinate + gridColumn * gridStep,
        minimumCoordinate + gridRow * gridStep,
      );
    }
  }
  return (positionX, positionY) => {
    const gridX = Math.min(gridSide - 1.001, Math.max(0, (positionX - minimumCoordinate) / gridStep));
    const gridY = Math.min(gridSide - 1.001, Math.max(0, (positionY - minimumCoordinate) / gridStep));
    const gridColumn = Math.floor(gridX);
    const gridRow = Math.floor(gridY);
    const horizontalWeight = gridX - gridColumn;
    const verticalWeight = gridY - gridRow;
    const topLeftIndex = gridRow * gridSide + gridColumn;
    const topValue = gridValues[topLeftIndex]! + horizontalWeight * (gridValues[topLeftIndex + 1]! - gridValues[topLeftIndex]!);
    const bottomValue =
      gridValues[topLeftIndex + gridSide]! +
      horizontalWeight * (gridValues[topLeftIndex + gridSide + 1]! - gridValues[topLeftIndex + gridSide]!);
    return topValue + verticalWeight * (bottomValue - topValue);
  };
}
