/**
 * Pinta el espectrograma log-mel que devuelve el modelo (tramas × bandas mel, trama a trama) en
 * un búfer RGBA con el tiempo en horizontal y los graves abajo. La escala de color se ajusta a
 * cada trozo (percentiles), porque los valores log-mel del modelo no están en dB calibrados.
 */

/** Percentiles que marcan el negro y el blanco de la paleta. */
const lowPercentile = 0.05;
const highPercentile = 0.995;

export function percentileRange(values: Float32Array): { minimum: number; maximum: number } {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) return { minimum: 0, maximum: 1 };
  finiteValues.sort();
  const valueAt = (fraction: number) =>
    finiteValues[Math.min(finiteValues.length - 1, Math.max(0, Math.round(fraction * (finiteValues.length - 1))))]!;
  const minimum = valueAt(lowPercentile);
  const maximum = valueAt(highPercentile);
  return { minimum, maximum: maximum > minimum ? maximum : minimum + 1 };
}

/**
 * Rellena `pixels` (RGBA, `frameCount` de ancho × `melBinCount` de alto) con la paleta
 * `colormapLookupTable` (256 colores RGB intercalados).
 */
export function renderMelSpectrogramPixels(
  melSpectrogram: Float32Array,
  frameCount: number,
  melBinCount: number,
  pixels: Uint8Array,
  colormapLookupTable: Uint8Array,
): void {
  const { minimum, maximum } = percentileRange(melSpectrogram);
  const levelsPerUnit = 255 / (maximum - minimum);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    for (let melBinIndex = 0; melBinIndex < melBinCount; melBinIndex++) {
      const melValue = melSpectrogram[frameIndex * melBinCount + melBinIndex] ?? minimum;
      let colorLevel = Math.round((melValue - minimum) * levelsPerUnit);
      colorLevel = !Number.isFinite(colorLevel) || colorLevel < 0 ? 0 : colorLevel > 255 ? 255 : colorLevel;
      const pixelRow = melBinCount - 1 - melBinIndex;
      const pixelOffset = (pixelRow * frameCount + frameIndex) * 4;
      pixels[pixelOffset] = colormapLookupTable[colorLevel * 3]!;
      pixels[pixelOffset + 1] = colormapLookupTable[colorLevel * 3 + 1]!;
      pixels[pixelOffset + 2] = colormapLookupTable[colorLevel * 3 + 2]!;
      pixels[pixelOffset + 3] = 255;
    }
  }
}
