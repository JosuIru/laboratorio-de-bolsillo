/**
 * Desenfoques baratos de un plano (un canal en coma flotante, `width × height`, fila a fila) para
 * el apilado de enfoque y el modo noche. En Hermes (sin JIT) un núcleo gaussiano ancho cuesta
 * mucho por píxel; aquí:
 *  - `smoothWithBinomial3`: núcleo 1-2-1 (σ ≈ 0,7 px), para quitar el ruido de píxel;
 *  - `boxBlurPlane`: media en una caja con suma acumulada (coste fijo por píxel sea cual sea el radio);
 *  - `approximateGaussianBlurPlane`: tres cajas seguidas, que se parecen mucho a una gaussiana.
 * Los bordes se repiten. Módulo puro: sin React ni React Native.
 */

/** Núcleo 1-2-1 en las dos direcciones. */
export function smoothWithBinomial3(values: Float32Array, width: number, height: number): Float32Array {
  const horizontalPass = new Float32Array(width * height);
  const lastColumn = width - 1;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const rowStart = rowIndex * width;
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const leftColumn = columnIndex > 0 ? columnIndex - 1 : 0;
      const rightColumn = columnIndex < lastColumn ? columnIndex + 1 : lastColumn;
      horizontalPass[rowStart + columnIndex] =
        0.25 * values[rowStart + leftColumn]! + 0.5 * values[rowStart + columnIndex]! + 0.25 * values[rowStart + rightColumn]!;
    }
  }
  const smoothedValues = new Float32Array(width * height);
  const lastRow = height - 1;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const aboveStart = (rowIndex > 0 ? rowIndex - 1 : 0) * width;
    const rowStart = rowIndex * width;
    const belowStart = (rowIndex < lastRow ? rowIndex + 1 : lastRow) * width;
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      smoothedValues[rowStart + columnIndex] =
        0.25 * horizontalPass[aboveStart + columnIndex]! +
        0.5 * horizontalPass[rowStart + columnIndex]! +
        0.25 * horizontalPass[belowStart + columnIndex]!;
    }
  }
  return smoothedValues;
}

/** Media en una caja de lado `2·radius + 1`, con sumas acumuladas (bordes repetidos). */
export function boxBlurPlane(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return values.slice();
  const boxWidth = 2 * radius + 1;
  const horizontalPass = new Float32Array(width * height);
  const lastColumn = width - 1;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const rowStart = rowIndex * width;
    let windowSum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sourceColumn = offset < 0 ? 0 : offset > lastColumn ? lastColumn : offset;
      windowSum += values[rowStart + sourceColumn]!;
    }
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      horizontalPass[rowStart + columnIndex] = windowSum / boxWidth;
      const enteringColumn = columnIndex + radius + 1;
      const leavingColumn = columnIndex - radius;
      windowSum +=
        values[rowStart + (enteringColumn > lastColumn ? lastColumn : enteringColumn)]! -
        values[rowStart + (leavingColumn < 0 ? 0 : leavingColumn)]!;
    }
  }
  const blurredValues = new Float32Array(width * height);
  const lastRow = height - 1;
  for (let columnIndex = 0; columnIndex < width; columnIndex++) {
    let windowSum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const sourceRow = offset < 0 ? 0 : offset > lastRow ? lastRow : offset;
      windowSum += horizontalPass[sourceRow * width + columnIndex]!;
    }
    for (let rowIndex = 0; rowIndex < height; rowIndex++) {
      blurredValues[rowIndex * width + columnIndex] = windowSum / boxWidth;
      const enteringRow = rowIndex + radius + 1;
      const leavingRow = rowIndex - radius;
      windowSum +=
        horizontalPass[(enteringRow > lastRow ? lastRow : enteringRow) * width + columnIndex]! -
        horizontalPass[(leavingRow < 0 ? 0 : leavingRow) * width + columnIndex]!;
    }
  }
  return blurredValues;
}

/**
 * Radio de caja tal que tres cajas seguidas tengan la varianza de una gaussiana de σ
 * (cada caja de radio r aporta ((2r + 1)² − 1) / 12).
 */
export function boxRadiusForGaussianSigma(sigmaPixels: number): number {
  return Math.max(1, Math.round((Math.sqrt(4 * sigmaPixels * sigmaPixels + 1) - 1) / 2));
}

/** Casi gaussiana de σ con tres cajas; por debajo de 0,9 px, el núcleo 1-2-1. */
export function approximateGaussianBlurPlane(values: Float32Array, width: number, height: number, sigmaPixels: number): Float32Array {
  if (sigmaPixels <= 0) return values.slice();
  if (sigmaPixels < 0.9) return smoothWithBinomial3(values, width, height);
  const boxRadius = boxRadiusForGaussianSigma(sigmaPixels);
  return boxBlurPlane(boxBlurPlane(boxBlurPlane(values, width, height, boxRadius), width, height, boxRadius), width, height, boxRadius);
}
