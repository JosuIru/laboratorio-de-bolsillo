/**
 * Imagen monocroma con solo los píxeles verdes de un RAW (mosaico de Bayer).
 *
 * Para la Luna el verde es el mejor canal: la mitad de los fotositos son verdes (el doble de
 * muestras que rojo o azul), es donde el sensor es más sensible y donde la lente está mejor
 * corregida (la aberración cromática lateral separa rojo y azul, no el verde). Usar solo el verde
 * evita además el «desmosaicado» del móvil, que inventa detalle y colorea los bordes.
 *
 * Dos modos:
 *  - `halfResolution`: una muestra por celda 2×2, la media de sus dos verdes (sin interpolar
 *    nada, la opción más fiel; la imagen sale a mitad de tamaño y la muestra está en el centro
 *    de la celda).
 *  - `fullResolution`: se conservan los verdes y en los sitios rojos y azules (que tienen cuatro
 *    vecinos verdes) se interpola en la dirección del menor gradiente (horizontal o vertical),
 *    o con la media de los cuatro si no hay dirección preferida. Así no se emborronan los bordes.
 *
 * Valores: (crudo − nivel de negro) / (nivel de blanco − nivel de negro), sin recortar por
 * debajo de 0 (el ruido del fondo debe poder ser negativo para no sesgar las medias).
 *
 * Hoy la app no captura RAW; esto queda listo para cuando lo haga. Módulo puro.
 */

import { createGrayImage, type GrayImage } from './grayImage';

/** Orden de la celda 2×2 superior izquierda, leída por filas. */
export type BayerPattern = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG';

export interface GreenExtractionOptions {
  pattern: BayerPattern;
  /** Nivel de negro del sensor (en cuentas crudas). */
  blackLevel: number;
  /** Nivel de saturación (1023 en un RAW de 10 bits). */
  whiteLevel: number;
  mode: 'halfResolution' | 'fullResolution';
}

export const defaultGreenExtractionOptions: GreenExtractionOptions = {
  pattern: 'RGGB',
  blackLevel: 64,
  whiteLevel: 1023,
  mode: 'halfResolution',
};

/** ¿El fotosito (columna, fila) es verde? En todos los patrones los verdes van en diagonal. */
export function isGreenSite(pattern: BayerPattern, columnIndex: number, rowIndex: number): boolean {
  const greenOnEvenDiagonal = pattern === 'GRBG' || pattern === 'GBRG';
  const isEvenDiagonal = (columnIndex + rowIndex) % 2 === 0;
  return greenOnEvenDiagonal ? isEvenDiagonal : !isEvenDiagonal;
}

/** Monocromo verde normalizado 0–1 a partir de un mosaico de Bayer crudo, fila a fila. */
export function extractGreenChannel(
  mosaicValues: Uint16Array | Float32Array | readonly number[],
  width: number,
  height: number,
  partialOptions: Partial<GreenExtractionOptions> = {},
): GrayImage {
  const options = { ...defaultGreenExtractionOptions, ...partialOptions };
  if (mosaicValues.length !== width * height) throw new Error('El tamaño del mosaico no coincide con la imagen');
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('El mosaico de Bayer debe tener lados pares');
  const valueRange = options.whiteLevel - options.blackLevel;
  if (valueRange <= 0) throw new Error('El nivel de blanco debe superar al de negro');
  const normalizedAt = (columnIndex: number, rowIndex: number) =>
    (mosaicValues[rowIndex * width + columnIndex]! - options.blackLevel) / valueRange;

  if (options.mode === 'halfResolution') {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const greenImage = createGrayImage(halfWidth, halfHeight);
    for (let cellRow = 0; cellRow < halfHeight; cellRow++) {
      for (let cellColumn = 0; cellColumn < halfWidth; cellColumn++) {
        const topRow = 2 * cellRow;
        const leftColumn = 2 * cellColumn;
        // Los dos verdes de la celda están en diagonal: (0,0)+(1,1) o (1,0)+(0,1).
        const greenSum = isGreenSite(options.pattern, leftColumn, topRow)
          ? normalizedAt(leftColumn, topRow) + normalizedAt(leftColumn + 1, topRow + 1)
          : normalizedAt(leftColumn + 1, topRow) + normalizedAt(leftColumn, topRow + 1);
        greenImage.values[cellRow * halfWidth + cellColumn] = greenSum / 2;
      }
    }
    return greenImage;
  }

  const greenImage = createGrayImage(width, height);
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      const pixelIndex = rowIndex * width + columnIndex;
      if (isGreenSite(options.pattern, columnIndex, rowIndex)) {
        greenImage.values[pixelIndex] = normalizedAt(columnIndex, rowIndex);
        continue;
      }
      // En el borde falta algún vecino: se refleja (el vecino del otro lado también es verde).
      const leftValue = normalizedAt(columnIndex > 0 ? columnIndex - 1 : columnIndex + 1, rowIndex);
      const rightValue = normalizedAt(columnIndex < width - 1 ? columnIndex + 1 : columnIndex - 1, rowIndex);
      const upperValue = normalizedAt(columnIndex, rowIndex > 0 ? rowIndex - 1 : rowIndex + 1);
      const lowerValue = normalizedAt(columnIndex, rowIndex < height - 1 ? rowIndex + 1 : rowIndex - 1);
      const horizontalGradient = Math.abs(leftValue - rightValue);
      const verticalGradient = Math.abs(upperValue - lowerValue);
      if (horizontalGradient < verticalGradient) greenImage.values[pixelIndex] = (leftValue + rightValue) / 2;
      else if (verticalGradient < horizontalGradient) greenImage.values[pixelIndex] = (upperValue + lowerValue) / 2;
      else greenImage.values[pixelIndex] = (leftValue + rightValue + upperValue + lowerValue) / 4;
    }
  }
  return greenImage;
}
