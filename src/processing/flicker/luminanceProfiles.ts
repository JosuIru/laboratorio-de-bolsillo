/**
 * Perfiles de luminancia de un fotograma: la media de cada fila y la de cada columna.
 *
 * Con obturador rodante, cada fila del sensor se expone en un instante distinto; si la luz
 * parpadea, la media por fila es una señal muestreada en el tiempo (una muestra por fila). Se
 * calculan también las columnas porque no se sabe con certeza en qué eje del búfer lee el sensor:
 * el análisis se queda con el eje que muestre bandas.
 *
 * Todo es 'worklet': se ejecuta en el hilo de la cámara y solo viajan al hilo JS los perfiles.
 */

/** Umbral (0-255) a partir del cual un canal se considera saturado. */
export const saturatedChannelLevel = 250;

export interface LuminanceProfileResult {
  /** Fracción de píxeles muestreados con algún canal saturado (recorta la modulación). */
  saturatedFraction: number;
  /** Luminancia lineal media del fotograma (0-3: suma de los tres canales lineales). */
  meanLuminance: number;
}

/**
 * Acumula en `rowProfile` (longitud ⌈alto/paso⌉) y `columnProfile` (⌈ancho/paso⌉) la luminancia
 * lineal media (R+G+B linealizados con `srgbToLinearTable`). Los tres primeros bytes de cada
 * píxel son siempre los de color (RGB, RGBA o BGRA), y su suma no depende del orden.
 * `sampleStride` salta píxeles en los dos ejes para ir más rápido.
 */
export function computeLuminanceProfiles(
  pixels: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  bytesPerRow: number,
  bytesPerPixel: number,
  srgbToLinearTable: Float64Array,
  sampleStride: number,
  rowProfile: Float64Array,
  columnProfile: Float64Array,
): LuminanceProfileResult {
  'worklet';
  const sampledRowCount = rowProfile.length;
  const sampledColumnCount = columnProfile.length;
  columnProfile.fill(0);
  let saturatedPixelCount = 0;
  let totalLuminance = 0;
  for (let sampledRowIndex = 0; sampledRowIndex < sampledRowCount; sampledRowIndex++) {
    const rowStart = sampledRowIndex * sampleStride * bytesPerRow;
    let rowLuminanceSum = 0;
    for (let sampledColumnIndex = 0; sampledColumnIndex < sampledColumnCount; sampledColumnIndex++) {
      const pixelStart = rowStart + sampledColumnIndex * sampleStride * bytesPerPixel;
      const firstChannel = pixels[pixelStart]!;
      const secondChannel = pixels[pixelStart + 1]!;
      const thirdChannel = pixels[pixelStart + 2]!;
      if (
        firstChannel >= saturatedChannelLevel ||
        secondChannel >= saturatedChannelLevel ||
        thirdChannel >= saturatedChannelLevel
      ) {
        saturatedPixelCount++;
      }
      const pixelLuminance =
        srgbToLinearTable[firstChannel]! + srgbToLinearTable[secondChannel]! + srgbToLinearTable[thirdChannel]!;
      rowLuminanceSum += pixelLuminance;
      columnProfile[sampledColumnIndex] = columnProfile[sampledColumnIndex]! + pixelLuminance;
    }
    rowProfile[sampledRowIndex] = rowLuminanceSum / sampledColumnCount;
    totalLuminance += rowLuminanceSum;
  }
  for (let sampledColumnIndex = 0; sampledColumnIndex < sampledColumnCount; sampledColumnIndex++) {
    columnProfile[sampledColumnIndex] = columnProfile[sampledColumnIndex]! / sampledRowCount;
  }
  const sampledPixelCount = sampledRowCount * sampledColumnCount;
  return {
    saturatedFraction: sampledPixelCount > 0 ? saturatedPixelCount / sampledPixelCount : 0,
    meanLuminance: sampledPixelCount > 0 ? totalLuminance / sampledPixelCount : 0,
  };
}

/** Número de muestras de un perfil a lo largo de un eje de `axisLength` píxeles. */
export function sampledProfileLength(axisLength: number, sampleStride: number): number {
  'worklet';
  return Math.ceil(axisLength / sampleStride);
}
