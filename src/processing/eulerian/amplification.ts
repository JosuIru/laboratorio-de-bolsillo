/**
 * Amplificación (Wu et al., 2012): a cada fotograma se le suma su variación
 * filtrada multiplicada por α. La variación se calcula en un nivel grueso de la pirámide y se
 * amplía aquí a la rejilla base con interpolación bilineal.
 */

/** Muestra bilineal de un canal de una imagen de coma flotante con canales intercalados. */
function sampleBilinear(
  imagePixels: Float32Array,
  imageWidth: number,
  imageHeight: number,
  channelCount: number,
  channelIndex: number,
  sampleX: number,
  sampleY: number,
): number {
  const clampedX = Math.min(imageWidth - 1, Math.max(0, sampleX));
  const clampedY = Math.min(imageHeight - 1, Math.max(0, sampleY));
  const leftColumn = Math.floor(clampedX);
  const topRow = Math.floor(clampedY);
  const rightColumn = Math.min(imageWidth - 1, leftColumn + 1);
  const bottomRow = Math.min(imageHeight - 1, topRow + 1);
  const horizontalWeight = clampedX - leftColumn;
  const verticalWeight = clampedY - topRow;
  const topLeftValue = imagePixels[(topRow * imageWidth + leftColumn) * channelCount + channelIndex]!;
  const topRightValue = imagePixels[(topRow * imageWidth + rightColumn) * channelCount + channelIndex]!;
  const bottomLeftValue = imagePixels[(bottomRow * imageWidth + leftColumn) * channelCount + channelIndex]!;
  const bottomRightValue = imagePixels[(bottomRow * imageWidth + rightColumn) * channelCount + channelIndex]!;
  const topValue = topLeftValue + (topRightValue - topLeftValue) * horizontalWeight;
  const bottomValue = bottomLeftValue + (bottomRightValue - bottomLeftValue) * horizontalWeight;
  return topValue * (1 - verticalWeight) + bottomValue * verticalWeight;
}

/** Coordenada en el nivel grueso del centro de un píxel de la rejilla base (centros alineados). */
function mapToLevelCoordinate(baseCoordinate: number, baseSize: number, levelSize: number): number {
  return ((baseCoordinate + 0.5) * levelSize) / baseSize - 0.5;
}

export interface AmplificationOptions {
  amplificationFactor: number;
  /** Tope de lo que se suma a cada canal, en niveles (0-255): evita que el ruido amplificado lo tape todo. */
  maximumAddedLevels: number;
}

/**
 * Reconstruye el fotograma amplificado: `base + α · variación` (con la variación ampliada a la
 * rejilla base). Si la variación tiene un solo canal (luminancia), se suma igual a R, G y B.
 * Escribe RGBA opaco en `outputRgba` (base.width × base.height × 4).
 */
export function reconstructAmplifiedRgba(
  baseRgb: Uint8Array,
  baseWidth: number,
  baseHeight: number,
  filteredLevel: Float32Array,
  levelWidth: number,
  levelHeight: number,
  levelChannelCount: 1 | 3,
  options: AmplificationOptions,
  outputRgba: Uint8Array,
): void {
  const { amplificationFactor, maximumAddedLevels } = options;
  for (let baseRow = 0; baseRow < baseHeight; baseRow++) {
    const levelY = mapToLevelCoordinate(baseRow, baseHeight, levelHeight);
    for (let baseColumn = 0; baseColumn < baseWidth; baseColumn++) {
      const levelX = mapToLevelCoordinate(baseColumn, baseWidth, levelWidth);
      const basePixelIndex = baseRow * baseWidth + baseColumn;
      for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        const variation = sampleBilinear(
          filteredLevel,
          levelWidth,
          levelHeight,
          levelChannelCount,
          levelChannelCount === 1 ? 0 : channelIndex,
          levelX,
          levelY,
        );
        const addedLevels = Math.max(-maximumAddedLevels, Math.min(maximumAddedLevels, amplificationFactor * variation));
        const outputValue = Math.round(baseRgb[basePixelIndex * 3 + channelIndex]! + addedLevels);
        outputRgba[basePixelIndex * 4 + channelIndex] = outputValue < 0 ? 0 : outputValue > 255 ? 255 : outputValue;
      }
      outputRgba[basePixelIndex * 4 + 3] = 255;
    }
  }
}
