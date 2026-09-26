/**
 * Puntuación de enfoque de una escena cualquiera (no la Luna) para la horquilla de enfoque del
 * superzoom: Tenengrad, la media del cuadrado del gradiente de Sobel, sobre la luminancia del
 * recuadro, dividida por el brillo medio al cuadrado (así un cambio leve de exposición entre fotos
 * no cambia el orden). Antes se suaviza un poco para que el ruido no cuente como detalle.
 *
 * Tenengrad y la varianza del laplaciano (la de `luckyImaging`) ordenan igual las fotos de una
 * serie; Tenengrad responde algo mejor cerca del enfoque óptimo en escenas con bordes marcados.
 * La mejor posición de una serie se estima con `estimateBestFocus` de `focusBracketing`.
 *
 * Módulo puro: sin React ni React Native.
 */

import { type BestFocusEstimate, estimateBestFocus } from './focusBracketing';
import { gaussianBlurGray, grayImageFromRgb } from './grayImage';

/** Suavizado previo (px): quita el ruido de píxel sin tocar el detalle de 2-3 px. */
const smoothingSigmaPixels = 0.7;

export function measureSceneFocusScore(rgbPixels: Uint8Array, width: number, height: number): number {
  const smoothed = gaussianBlurGray(grayImageFromRgb(rgbPixels, width, height), smoothingSigmaPixels);
  const { values } = smoothed;
  let squaredGradientSum = 0;
  let brightnessSum = 0;
  let sampleCount = 0;
  for (let rowIndex = 1; rowIndex < height - 1; rowIndex++) {
    for (let columnIndex = 1; columnIndex < width - 1; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      const aboveIndex = pixelIndex - width;
      const belowIndex = pixelIndex + width;
      const sobelX =
        values[aboveIndex + 1]! + 2 * values[pixelIndex + 1]! + values[belowIndex + 1]! -
        values[aboveIndex - 1]! - 2 * values[pixelIndex - 1]! - values[belowIndex - 1]!;
      const sobelY =
        values[belowIndex - 1]! + 2 * values[belowIndex]! + values[belowIndex + 1]! -
        values[aboveIndex - 1]! - 2 * values[aboveIndex]! - values[aboveIndex + 1]!;
      squaredGradientSum += sobelX * sobelX + sobelY * sobelY;
      brightnessSum += values[pixelIndex]!;
      sampleCount++;
    }
  }
  if (sampleCount === 0) return 0;
  const meanBrightness = brightnessSum / sampleCount;
  return meanBrightness > 0 ? squaredGradientSum / sampleCount / (meanBrightness * meanBrightness) : 0;
}

/**
 * Posiciones de la horquilla: `stepCount` posiciones (impar) centradas en la actual, separadas
 * `stepSize`, dentro de 0…1 (la escala de `setFocusLocked` de VisionCamera).
 */
export function focusBracketPositions(currentPosition: number, stepSize: number, stepCount: number): number[] {
  const halfCount = Math.floor(stepCount / 2);
  const positions = Array.from({ length: 2 * halfCount + 1 }, (_unused, stepIndex) =>
    Math.min(1, Math.max(0, currentPosition + (stepIndex - halfCount) * stepSize)),
  );
  return positions.filter((position, positionIndex) => positions.indexOf(position) === positionIndex);
}

/** Mejor posición de enfoque de una horquilla ya puntuada, o `null` si ninguna puntuación vale. */
export function chooseBestFocusPosition(positions: readonly number[], scores: readonly number[]): BestFocusEstimate | null {
  return estimateBestFocus(positions.map((focusPosition, positionIndex) => ({ focusPosition, score: scores[positionIndex] ?? 0 })));
}
