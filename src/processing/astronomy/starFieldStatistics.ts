/**
 * Geometría y estadística de un campo de estrellas fotografiado con el móvil.
 *
 * - Escala de píxel y ángulo sólido del campo a partir de la focal equivalente en 35 mm (la que
 *   da la cámara) y del tamaño de la foto.
 * - Magnitud límite aproximada por recuento: el número de estrellas más brillantes que una
 *   magnitud m en todo el cielo es bien conocido (≈ ×3 por magnitud). Si en un campo de A grados
 *   cuadrados se detectan N estrellas, la densidad N/A corresponde a una magnitud límite. Es una
 *   media de todo el cielo: cerca de la Vía Láctea hay hasta ~3 veces más estrellas (la
 *   estimación sale ~1 magnitud más optimista) y lejos de ella, menos.
 * - Deriva sideral: cuánto se mueve una estrella por la imagen en un segundo.
 *
 * Módulo puro: sin React ni React Native.
 */

/** Diagonal del fotograma de 35 mm (36 × 24 mm). */
const fullFrameDiagonalMillimeters = Math.hypot(36, 24);
const squareDegreesInSky = 41_252.96;
const radiansToDegrees = 180 / Math.PI;
/** Velocidad angular del cielo en el ecuador celeste, en segundos de arco por segundo de tiempo. */
export const siderealRateArcsecondsPerSecond = 15.041;
/** Focal equivalente típica de la cámara principal de un móvil, si la cámara no la da. */
export const typicalPhoneFocalLength35mm = 26;

/**
 * Estrellas más brillantes que cada magnitud visual en todo el cielo (valores aproximados de
 * Allen, «Astrophysical Quantities», redondeados).
 */
const cumulativeStarCountsBySkyMagnitude: readonly { magnitude: number; starCount: number }[] = [
  { magnitude: 0, starCount: 4 },
  { magnitude: 1, starCount: 15 },
  { magnitude: 2, starCount: 48 },
  { magnitude: 3, starCount: 171 },
  { magnitude: 4, starCount: 513 },
  { magnitude: 5, starCount: 1_602 },
  { magnitude: 6, starCount: 4_800 },
  { magnitude: 7, starCount: 14_000 },
  { magnitude: 8, starCount: 41_000 },
  { magnitude: 9, starCount: 117_000 },
  { magnitude: 10, starCount: 324_000 },
  { magnitude: 11, starCount: 870_000 },
  { magnitude: 12, starCount: 2_270_000 },
];

export interface FieldOfViewInput {
  /** Focal equivalente en 35 mm de la cámara (sin zoom). */
  focalLength35mm: number;
  /** Tamaño de la foto completa, en píxeles. */
  photoWidthPixels: number;
  photoHeightPixels: number;
  /** Zona analizada, en píxeles de la foto (centrada en el eje). */
  regionWidthPixels: number;
  regionHeightPixels: number;
  /** Zoom digital o de la cámara aplicado (1 = sin zoom). */
  zoomFactor?: number;
}

export interface FieldOfView {
  /** Escala en el centro, en segundos de arco por píxel de la foto. */
  pixelScaleArcseconds: number;
  /** Ancho y alto angulares de la zona, en grados. */
  widthDegrees: number;
  heightDegrees: number;
  /** Ángulo sólido de la zona, en grados cuadrados. */
  solidAngleSquareDegrees: number;
}

/**
 * Campo de visión de una zona centrada de la foto, en proyección gnomónica (la de un objetivo
 * rectilíneo). El ángulo sólido de una pirámide rectangular de semiángulos a y b es
 * 4·arcsen(sen a · sen b).
 */
export function fieldOfViewForRegion(input: FieldOfViewInput): FieldOfView {
  const effectiveFocalLength = input.focalLength35mm * (input.zoomFactor ?? 1);
  const photoDiagonalPixels = Math.hypot(input.photoWidthPixels, input.photoHeightPixels);
  // Focal expresada en píxeles de la foto.
  const focalLengthPixels = (effectiveFocalLength / fullFrameDiagonalMillimeters) * photoDiagonalPixels;
  const halfWidthRadians = Math.atan(input.regionWidthPixels / 2 / focalLengthPixels);
  const halfHeightRadians = Math.atan(input.regionHeightPixels / 2 / focalLengthPixels);
  const solidAngleSteradians = 4 * Math.asin(Math.sin(halfWidthRadians) * Math.sin(halfHeightRadians));
  return {
    pixelScaleArcseconds: (1 / focalLengthPixels) * radiansToDegrees * 3600,
    widthDegrees: 2 * halfWidthRadians * radiansToDegrees,
    heightDegrees: 2 * halfHeightRadians * radiansToDegrees,
    solidAngleSquareDegrees: solidAngleSteradians * radiansToDegrees * radiansToDegrees,
  };
}

/** Estrellas más brillantes que `magnitude` en todo el cielo (interpolación logarítmica). */
export function skyStarCountBrighterThan(magnitude: number): number {
  const table = cumulativeStarCountsBySkyMagnitude;
  const firstEntry = table[0]!;
  const lastEntry = table[table.length - 1]!;
  const clampedMagnitude = Math.min(lastEntry.magnitude, Math.max(firstEntry.magnitude, magnitude));
  const lowerIndex = Math.min(table.length - 2, Math.floor(clampedMagnitude - firstEntry.magnitude));
  const lowerEntry = table[lowerIndex]!;
  const upperEntry = table[lowerIndex + 1]!;
  const fraction = (clampedMagnitude - lowerEntry.magnitude) / (upperEntry.magnitude - lowerEntry.magnitude);
  return 10 ** (Math.log10(lowerEntry.starCount) + fraction * (Math.log10(upperEntry.starCount) - Math.log10(lowerEntry.starCount)));
}

/**
 * Magnitud límite que corresponde a detectar `detectedStarCount` estrellas en un campo de
 * `solidAngleSquareDegrees`. null si hay tan pocas que no dice nada (< 3).
 */
export function limitingMagnitudeFromStarCount(detectedStarCount: number, solidAngleSquareDegrees: number): number | null {
  if (detectedStarCount < 3 || solidAngleSquareDegrees <= 0) return null;
  const skyEquivalentCount = (detectedStarCount / solidAngleSquareDegrees) * squareDegreesInSky;
  const table = cumulativeStarCountsBySkyMagnitude;
  const logCount = Math.log10(skyEquivalentCount);
  for (let entryIndex = 0; entryIndex < table.length - 1; entryIndex++) {
    const lowerEntry = table[entryIndex]!;
    const upperEntry = table[entryIndex + 1]!;
    const lowerLog = Math.log10(lowerEntry.starCount);
    const upperLog = Math.log10(upperEntry.starCount);
    if (logCount <= upperLog || entryIndex === table.length - 2) {
      const fraction = (logCount - lowerLog) / (upperLog - lowerLog);
      return Math.min(upperEntry.magnitude, Math.max(table[0]!.magnitude, lowerEntry.magnitude + fraction));
    }
  }
  return null;
}

/** Diferencia de magnitudes entre dos flujos: 2,5·log₁₀(brillante / débil). */
export function magnitudeDifference(brighterFlux: number, fainterFlux: number): number {
  if (brighterFlux <= 0 || fainterFlux <= 0) return 0;
  return 2.5 * Math.log10(brighterFlux / fainterFlux);
}

/**
 * Ganancia teórica en magnitud límite al apilar N fotogramas iguales con el ruido dominado por el
 * fondo: la relación señal/ruido crece como √N, es decir 2,5·log₁₀(√N) magnitudes.
 */
export function expectedStackingGainMagnitudes(frameCount: number): number {
  return frameCount > 1 ? 1.25 * Math.log10(frameCount) : 0;
}

/** Píxeles por segundo que se mueve una estrella de declinación dada por la rotación del cielo. */
export function siderealDriftPixelsPerSecond(pixelScaleArcseconds: number, declinationDegrees = 0): number {
  if (pixelScaleArcseconds <= 0) return 0;
  return (siderealRateArcsecondsPerSecond * Math.cos((declinationDegrees * Math.PI) / 180)) / pixelScaleArcseconds;
}
