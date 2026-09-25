/**
 * Espectrograma en cascada: historial de filas (una por trama de espectro), cada una reducida
 * a `columnCount` columnas en escala de frecuencia lineal o logarítmica, y su conversión a
 * píxeles RGBA para dibujarlo como una imagen (mucho más barato que miles de rectángulos).
 */

export type FrequencyScale = 'linear' | 'logarithmic';

export interface SpectrogramHistory {
  rowCount: number;
  columnCount: number;
  /** Filas en dB, una detrás de otra; `newestRowIndex` es la última escrita. */
  decibelRows: Float32Array;
  newestRowIndex: number;
  storedRowCount: number;
}

export interface ColumnBinMapping {
  /** Para cada columna, rango de bins [first, last] que representa. */
  firstBinByColumn: Uint32Array;
  lastBinByColumn: Uint32Array;
  minimumFrequencyHz: number;
  maximumFrequencyHz: number;
  scale: FrequencyScale;
}

export function createSpectrogramHistory(rowCount: number, columnCount: number, floorDecibels = -160): SpectrogramHistory {
  const decibelRows = new Float32Array(rowCount * columnCount).fill(floorDecibels);
  return { rowCount, columnCount, decibelRows, newestRowIndex: -1, storedRowCount: 0 };
}

/** Frecuencia del borde izquierdo de una columna (fracción 0-1 del ancho). */
export function columnFractionToFrequency(
  columnFraction: number,
  minimumFrequencyHz: number,
  maximumFrequencyHz: number,
  scale: FrequencyScale,
): number {
  if (scale === 'linear') return minimumFrequencyHz + columnFraction * (maximumFrequencyHz - minimumFrequencyHz);
  return minimumFrequencyHz * (maximumFrequencyHz / minimumFrequencyHz) ** columnFraction;
}

/**
 * Precalcula qué bins de la FFT caen en cada columna. En escala logarítmica las columnas de
 * graves abarcan menos de un bin; entonces se repite el bin más cercano.
 */
export function createColumnBinMapping(
  columnCount: number,
  sampleRateHz: number,
  fftSize: number,
  minimumFrequencyHz: number,
  maximumFrequencyHz: number,
  scale: FrequencyScale,
): ColumnBinMapping {
  if (scale === 'logarithmic' && !(minimumFrequencyHz > 0)) {
    throw new RangeError('La escala logarítmica necesita una frecuencia mínima positiva');
  }
  const binResolutionHz = sampleRateHz / fftSize;
  const lastValidBin = fftSize / 2;
  const firstBinByColumn = new Uint32Array(columnCount);
  const lastBinByColumn = new Uint32Array(columnCount);
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
    const startFrequencyHz = columnFractionToFrequency(columnIndex / columnCount, minimumFrequencyHz, maximumFrequencyHz, scale);
    const endFrequencyHz = columnFractionToFrequency((columnIndex + 1) / columnCount, minimumFrequencyHz, maximumFrequencyHz, scale);
    const firstBin = Math.min(lastValidBin, Math.max(0, Math.round(startFrequencyHz / binResolutionHz)));
    const lastBin = Math.min(lastValidBin, Math.max(firstBin, Math.round(endFrequencyHz / binResolutionHz) - 1));
    firstBinByColumn[columnIndex] = firstBin;
    lastBinByColumn[columnIndex] = lastBin;
  }
  return { firstBinByColumn, lastBinByColumn, minimumFrequencyHz, maximumFrequencyHz, scale };
}

/** Añade una fila: cada columna toma el máximo en dB de sus bins (así no se pierden picos estrechos). */
export function pushSpectrumRow(
  history: SpectrogramHistory,
  decibelSpectrum: ArrayLike<number>,
  columnMapping: ColumnBinMapping,
): void {
  'worklet';
  const nextRowIndex = (history.newestRowIndex + 1) % history.rowCount;
  const rowOffset = nextRowIndex * history.columnCount;
  for (let columnIndex = 0; columnIndex < history.columnCount; columnIndex++) {
    let columnMaximum = -Infinity;
    const lastBin = columnMapping.lastBinByColumn[columnIndex]!;
    for (let binIndex = columnMapping.firstBinByColumn[columnIndex]!; binIndex <= lastBin; binIndex++) {
      const binDecibels = decibelSpectrum[binIndex] ?? -Infinity;
      if (binDecibels > columnMaximum) columnMaximum = binDecibels;
    }
    history.decibelRows[rowOffset + columnIndex] = Number.isFinite(columnMaximum) ? columnMaximum : -160;
  }
  history.newestRowIndex = nextRowIndex;
  if (history.storedRowCount < history.rowCount) history.storedRowCount++;
}

/**
 * Paleta perceptualmente uniforme (aproximación de "inferno" de matplotlib, CC0) para que un
 * mismo salto de dB se vea igual en todo el rango. 9 paradas, interpoladas linealmente.
 */
const colormapStops: readonly (readonly [number, number, number])[] = [
  [0, 0, 4],
  [31, 12, 72],
  [85, 15, 109],
  [136, 34, 106],
  [186, 54, 85],
  [227, 89, 51],
  [249, 140, 10],
  [249, 201, 50],
  [252, 255, 164],
];

export function colormapColor(normalizedValue: number): [number, number, number] {
  'worklet';
  const clampedValue = Math.min(1, Math.max(0, Number.isFinite(normalizedValue) ? normalizedValue : 0));
  const scaledPosition = clampedValue * (colormapStops.length - 1);
  const lowerStopIndex = Math.min(colormapStops.length - 2, Math.floor(scaledPosition));
  const interpolationFraction = scaledPosition - lowerStopIndex;
  const lowerStop = colormapStops[lowerStopIndex]!;
  const upperStop = colormapStops[lowerStopIndex + 1]!;
  return [
    Math.round(lowerStop[0] + interpolationFraction * (upperStop[0] - lowerStop[0])),
    Math.round(lowerStop[1] + interpolationFraction * (upperStop[1] - lowerStop[1])),
    Math.round(lowerStop[2] + interpolationFraction * (upperStop[2] - lowerStop[2])),
  ];
}

/** Paleta precalculada en 256 niveles (RGB intercalado), para no interpolar en cada píxel. */
export function createColormapLookupTable(): Uint8Array {
  const lookupTable = new Uint8Array(256 * 3);
  for (let levelIndex = 0; levelIndex < 256; levelIndex++) {
    const [red, green, blue] = colormapColor(levelIndex / 255);
    lookupTable[levelIndex * 3] = red;
    lookupTable[levelIndex * 3 + 1] = green;
    lookupTable[levelIndex * 3 + 2] = blue;
  }
  return lookupTable;
}

/**
 * Pinta el historial en `pixels` (RGBA, `columnCount` × `rowCount`), con la fila más reciente
 * arriba. Las filas aún vacías quedan del color más oscuro.
 */
export function renderSpectrogramPixels(
  history: SpectrogramHistory,
  pixels: Uint8Array,
  minimumDecibels: number,
  maximumDecibels: number,
  colormapLookupTable: Uint8Array = createColormapLookupTable(),
): void {
  'worklet';
  const levelsPerDecibel = 255 / (maximumDecibels - minimumDecibels || 1);
  for (let displayRow = 0; displayRow < history.rowCount; displayRow++) {
    const hasData = displayRow < history.storedRowCount;
    const sourceRow = (history.newestRowIndex - displayRow + history.rowCount) % history.rowCount;
    for (let columnIndex = 0; columnIndex < history.columnCount; columnIndex++) {
      let colorLevel = 0;
      if (hasData) {
        const decibelValue = history.decibelRows[sourceRow * history.columnCount + columnIndex]!;
        colorLevel = Math.round((decibelValue - minimumDecibels) * levelsPerDecibel);
        colorLevel = colorLevel < 0 || !Number.isFinite(colorLevel) ? 0 : colorLevel > 255 ? 255 : colorLevel;
      }
      const pixelOffset = (displayRow * history.columnCount + columnIndex) * 4;
      pixels[pixelOffset] = colormapLookupTable[colorLevel * 3]!;
      pixels[pixelOffset + 1] = colormapLookupTable[colorLevel * 3 + 1]!;
      pixels[pixelOffset + 2] = colormapLookupTable[colorLevel * 3 + 2]!;
      pixels[pixelOffset + 3] = 255;
    }
  }
}
