/**
 * Campos de estrellas sintéticos para las pruebas: estrellas gaussianas sobre un fondo con
 * gradiente, ruido gaussiano con semilla y, si se pide, píxeles calientes.
 */
import { applyRigidTransform, type RigidTransform, type StarPosition } from '../astronomy/starFieldAlignment';

import { createSeededRandom, type GrayImage } from './grayImage';

export interface SyntheticStar extends StarPosition {
  /** Flujo total (niveles × píxel). */
  flux: number;
}

export interface SyntheticFieldOptions {
  width: number;
  height: number;
  stars: readonly SyntheticStar[];
  psfSigmaPixels?: number;
  backgroundLevel?: number;
  /** Aumento del fondo de izquierda a derecha y de arriba abajo (niveles en toda la imagen). */
  horizontalGradientLevels?: number;
  verticalGradientLevels?: number;
  noiseSigma?: number;
  seed?: number;
  /** Transformación aplicada a las posiciones de las estrellas (el giro del cielo). */
  transform?: RigidTransform;
  hotPixels?: readonly { x: number; y: number; excess: number }[];
  /** Redondear y recortar a 0-255, como un JPEG de 8 bits. */
  quantize?: boolean;
}

/** Normal estándar por Box-Muller. */
export function createGaussianRandom(seed: number): () => number {
  const uniformRandom = createSeededRandom(seed);
  return () => {
    const firstUniform = Math.max(1e-12, uniformRandom());
    const secondUniform = uniformRandom();
    return Math.sqrt(-2 * Math.log(firstUniform)) * Math.cos(2 * Math.PI * secondUniform);
  };
}

/** Estrellas al azar (sin acercarse al borde), con flujos repartidos entre dos valores. */
export function randomStars(
  starCount: number,
  width: number,
  height: number,
  seed: number,
  minimumFlux: number,
  maximumFlux: number,
  borderMargin = 8,
): SyntheticStar[] {
  const uniformRandom = createSeededRandom(seed);
  const stars: SyntheticStar[] = [];
  let attemptCount = 0;
  while (stars.length < starCount && attemptCount < starCount * 50) {
    attemptCount++;
    const candidateStar = {
      x: borderMargin + uniformRandom() * (width - 2 * borderMargin),
      y: borderMargin + uniformRandom() * (height - 2 * borderMargin),
      // Reparto logarítmico: muchas débiles y pocas brillantes, como en el cielo.
      flux: minimumFlux * (maximumFlux / minimumFlux) ** uniformRandom(),
    };
    // Separadas para que la prueba mida la detección, no la separación de estrellas dobles.
    if (stars.some((star) => Math.hypot(star.x - candidateStar.x, star.y - candidateStar.y) < 6)) continue;
    stars.push(candidateStar);
  }
  return stars;
}

export function renderStarField(options: SyntheticFieldOptions): GrayImage {
  const { width, height } = options;
  const psfSigma = options.psfSigmaPixels ?? 1.2;
  const values = new Float32Array(width * height);
  const backgroundLevel = options.backgroundLevel ?? 20;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      values[rowIndex * width + columnIndex] =
        backgroundLevel +
        ((options.horizontalGradientLevels ?? 0) * columnIndex) / width +
        ((options.verticalGradientLevels ?? 0) * rowIndex) / height;
    }
  }
  const renderRadius = Math.ceil(psfSigma * 4);
  const normalization = 1 / (2 * Math.PI * psfSigma * psfSigma);
  for (const star of options.stars) {
    const position = options.transform ? applyRigidTransform(options.transform, star) : star;
    const centerColumn = Math.round(position.x);
    const centerRow = Math.round(position.y);
    for (let rowIndex = centerRow - renderRadius; rowIndex <= centerRow + renderRadius; rowIndex++) {
      if (rowIndex < 0 || rowIndex >= height) continue;
      for (let columnIndex = centerColumn - renderRadius; columnIndex <= centerColumn + renderRadius; columnIndex++) {
        if (columnIndex < 0 || columnIndex >= width) continue;
        // Integral del gaussiano en el píxel aproximada por su valor en el centro (σ ≥ 1).
        const squaredDistance = (columnIndex - position.x) ** 2 + (rowIndex - position.y) ** 2;
        values[rowIndex * width + columnIndex] =
          values[rowIndex * width + columnIndex]! + star.flux * normalization * Math.exp(-squaredDistance / (2 * psfSigma * psfSigma));
      }
    }
  }
  for (const hotPixel of options.hotPixels ?? []) {
    values[hotPixel.y * width + hotPixel.x] = values[hotPixel.y * width + hotPixel.x]! + hotPixel.excess;
  }
  const noiseSigma = options.noiseSigma ?? 0;
  if (noiseSigma > 0) {
    const gaussianRandom = createGaussianRandom(options.seed ?? 1);
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      values[pixelIndex] = values[pixelIndex]! + noiseSigma * gaussianRandom();
    }
  }
  if (options.quantize) {
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) {
      values[pixelIndex] = Math.max(0, Math.min(255, Math.round(values[pixelIndex]!)));
    }
  }
  return { width, height, values };
}

export function grayImageToBytes(image: GrayImage): Uint8Array {
  const bytes = new Uint8Array(image.values.length);
  for (let pixelIndex = 0; pixelIndex < bytes.length; pixelIndex++) {
    bytes[pixelIndex] = Math.max(0, Math.min(255, Math.round(image.values[pixelIndex]!)));
  }
  return bytes;
}

/** Giro del cielo alrededor de un punto (el polo) en `rotationDegrees`. */
export function rotationAboutPoint(rotationDegrees: number, pivotX: number, pivotY: number): RigidTransform {
  const rotationRadians = (rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(rotationRadians);
  const sine = Math.sin(rotationRadians);
  return {
    rotationRadians,
    translationX: pivotX - (cosine * pivotX - sine * pivotY),
    translationY: pivotY - (sine * pivotX + cosine * pivotY),
  };
}
