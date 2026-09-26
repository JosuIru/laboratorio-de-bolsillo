/**
 * Lectura mínima de ficheros DNG (TIFF) sin comprimir: lo justo para sacar el mosaico de Bayer
 * de una zona de la foto RAW, sin cargar el fichero entero (un DNG de 12 MP ocupa ~25 MB).
 *
 * Qué se entiende:
 *  - Cabecera TIFF «II» (little-endian) o «MM» (big-endian), IFD0 y sus SubIFD (etiqueta 330):
 *    la imagen RAW es el IFD con PhotometricInterpretation = 32803 (CFA) y NewSubfileType = 0
 *    (resolución completa). Android (`DngCreator`) la pone en el IFD0 si no hay miniatura.
 *  - Datos en tiras (StripOffsets/RowsPerStrip) o en teselas (TileOffsets), sin comprimir
 *    (Compression = 1), de 8 o 16 bits por muestra. `DngCreator` escribe 16 bits en tiras.
 *  - CFARepeatPatternDim (2×2) y CFAPattern (0 = rojo, 1 = verde, 2 = azul), BlackLevel (uno o
 *    uno por posición del patrón; se promedian), WhiteLevel, ActiveArea y Orientation.
 * Lo que no se entiende (JPEG sin pérdidas, 10/12 bits empaquetados, patrones que no son de
 * Bayer 2×2) se devuelve como un problema con su código, para avisar y volver a JPEG.
 *
 * Módulo puro: sin React ni React Native. La lectura de bytes se inyecta (`DngByteSource`).
 */

import type { BayerPattern } from './greenChannelMono';

/** Acceso aleatorio al fichero: `readBytes(desde, cuántos)`. */
export interface DngByteSource {
  byteLength: number;
  readBytes(offset: number, length: number): Uint8Array;
}

export type DngProblemCode =
  | 'notTiff'
  | 'noRawImage'
  | 'compressed'
  | 'unsupportedBitDepth'
  | 'unsupportedCfaPattern'
  | 'truncated';

export class DngFormatProblem extends Error {
  constructor(
    readonly problemCode: DngProblemCode,
    detail = '',
  ) {
    super(`DNG no admitido (${problemCode})${detail ? `: ${detail}` : ''}`);
    this.name = 'DngFormatProblem';
  }
}

export interface DngRawLayout {
  isLittleEndian: boolean;
  width: number;
  height: number;
  bitsPerSample: 8 | 16;
  /** Tiras o teselas: desplazamiento de cada una en el fichero. */
  segmentOffsets: number[];
  /** Filas por tira (tiras) o lado de la tesela (teselas). */
  rowsPerSegment: number;
  /** Solo con teselas: anchura de la tesela (0 con tiras). */
  tileWidth: number;
  /** Patrón en el origen de la imagen (fila 0, columna 0 de los datos guardados). */
  bayerPattern: BayerPattern;
  blackLevel: number;
  whiteLevel: number;
  /** Orientación TIFF/EXIF (1 = tal cual). */
  orientation: number;
}

// Etiquetas TIFF / DNG usadas.
const tagNewSubfileType = 254;
const tagImageWidth = 256;
const tagImageLength = 257;
const tagBitsPerSample = 258;
const tagCompression = 259;
const tagPhotometricInterpretation = 262;
const tagStripOffsets = 273;
const tagOrientation = 274;
const tagRowsPerStrip = 278;
const tagTileWidth = 322;
const tagTileLength = 323;
const tagTileOffsets = 324;
const tagSubIfds = 330;
const tagCfaRepeatPatternDim = 33421;
const tagCfaPattern = 33422;
const tagBlackLevel = 50714;
const tagWhiteLevel = 50717;
const tagActiveArea = 50829;
const photometricColorFilterArray = 32803;
/** Límite de IFD recorridos (defensa contra ficheros con ciclos). */
const maximumIfdCount = 16;

/** Tamaño en bytes de cada tipo TIFF. */
const tiffTypeByteSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

type IfdEntries = Map<number, number[]>;

class TiffReader {
  constructor(
    private readonly byteSource: DngByteSource,
    readonly isLittleEndian: boolean,
  ) {}

  private bytesAt(offset: number, length: number): DataView {
    if (offset < 0 || offset + length > this.byteSource.byteLength) throw new DngFormatProblem('truncated');
    const bytes = this.byteSource.readBytes(offset, length);
    if (bytes.length < length) throw new DngFormatProblem('truncated');
    return new DataView(bytes.buffer, bytes.byteOffset, length);
  }

  uint16(offset: number): number {
    return this.bytesAt(offset, 2).getUint16(0, this.isLittleEndian);
  }

  uint32(offset: number): number {
    return this.bytesAt(offset, 4).getUint32(0, this.isLittleEndian);
  }

  /** Valores de una entrada como números (los racionales, ya divididos). */
  private readValues(fieldType: number, valueCount: number, valueOffset: number): number[] {
    const typeSize = tiffTypeByteSizes[fieldType] ?? 1;
    const view = this.bytesAt(valueOffset, typeSize * valueCount);
    const values: number[] = [];
    for (let valueIndex = 0; valueIndex < valueCount; valueIndex++) {
      const position = valueIndex * typeSize;
      switch (fieldType) {
        case 3:
          values.push(view.getUint16(position, this.isLittleEndian));
          break;
        case 8:
          values.push(view.getInt16(position, this.isLittleEndian));
          break;
        case 4:
        case 13:
          values.push(view.getUint32(position, this.isLittleEndian));
          break;
        case 9:
          values.push(view.getInt32(position, this.isLittleEndian));
          break;
        case 5:
          values.push(view.getUint32(position, this.isLittleEndian) / Math.max(1, view.getUint32(position + 4, this.isLittleEndian)));
          break;
        case 10:
          values.push(view.getInt32(position, this.isLittleEndian) / Math.max(1, view.getInt32(position + 4, this.isLittleEndian)));
          break;
        case 11:
          values.push(view.getFloat32(position, this.isLittleEndian));
          break;
        case 12:
          values.push(view.getFloat64(position, this.isLittleEndian));
          break;
        default:
          values.push(view.getUint8(position));
      }
    }
    return values;
  }

  /** Entradas de un IFD y el desplazamiento del siguiente (0 si no hay). */
  readIfd(ifdOffset: number): { entries: IfdEntries; nextIfdOffset: number } {
    const entryCount = this.uint16(ifdOffset);
    const entries: IfdEntries = new Map();
    for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
      const entryOffset = ifdOffset + 2 + entryIndex * 12;
      const tag = this.uint16(entryOffset);
      const fieldType = this.uint16(entryOffset + 2);
      const valueCount = this.uint32(entryOffset + 4);
      const valueByteLength = (tiffTypeByteSizes[fieldType] ?? 1) * valueCount;
      // Hasta 4 bytes, el valor va dentro de la propia entrada.
      const valueOffset = valueByteLength <= 4 ? entryOffset + 8 : this.uint32(entryOffset + 8);
      // Las tablas enormes que no se usan (p. ej., mapas de ganancia) no se leen.
      if (valueCount > 1_000_000) continue;
      entries.set(tag, this.readValues(fieldType, valueCount, valueOffset));
    }
    return { entries, nextIfdOffset: this.uint32(ifdOffset + 2 + entryCount * 12) };
  }
}

function firstValue(entries: IfdEntries, tag: number, fallback: number): number {
  return entries.get(tag)?.[0] ?? fallback;
}

const bayerPatternsByColorCodes: Record<string, BayerPattern> = {
  '0,1,1,2': 'RGGB',
  '2,1,1,0': 'BGGR',
  '1,0,2,1': 'GRBG',
  '1,2,0,1': 'GBRG',
};

/** Patrón de la celda 2×2 que empieza en (columna, fila), desplazando el del origen. */
export function shiftBayerPattern(originPattern: BayerPattern, columnOffset: number, rowOffset: number): BayerPattern {
  const letters = originPattern.split('');
  const letterAt = (rowIndex: number, columnIndex: number) => letters[(rowIndex % 2) * 2 + (columnIndex % 2)]!;
  const shiftedRow = ((rowOffset % 2) + 2) % 2;
  const shiftedColumn = ((columnOffset % 2) + 2) % 2;
  return (
    letterAt(shiftedRow, shiftedColumn) +
    letterAt(shiftedRow, shiftedColumn + 1) +
    letterAt(shiftedRow + 1, shiftedColumn) +
    letterAt(shiftedRow + 1, shiftedColumn + 1)
  ) as BayerPattern;
}

/** Busca la imagen RAW (CFA) del DNG y describe cómo leerla. Lanza `DngFormatProblem` si no puede. */
export function parseDngRawLayout(byteSource: DngByteSource): DngRawLayout {
  if (byteSource.byteLength < 16) throw new DngFormatProblem('notTiff');
  const signature = byteSource.readBytes(0, 4);
  const isLittleEndian = signature[0] === 0x49 && signature[1] === 0x49;
  const isBigEndian = signature[0] === 0x4d && signature[1] === 0x4d;
  if (!isLittleEndian && !isBigEndian) throw new DngFormatProblem('notTiff');
  const tiffReader = new TiffReader(byteSource, isLittleEndian);
  if (tiffReader.uint16(2) !== 42) throw new DngFormatProblem('notTiff');

  // Recorre IFD0, los siguientes y sus SubIFD (en anchura), hasta un límite.
  const pendingIfdOffsets = [tiffReader.uint32(4)];
  const visitedOffsets = new Set<number>();
  let orientation = 1;
  let rawEntries: IfdEntries | null = null;
  while (pendingIfdOffsets.length > 0 && visitedOffsets.size < maximumIfdCount) {
    const ifdOffset = pendingIfdOffsets.shift()!;
    if (ifdOffset === 0 || visitedOffsets.has(ifdOffset)) continue;
    visitedOffsets.add(ifdOffset);
    const { entries, nextIfdOffset } = tiffReader.readIfd(ifdOffset);
    if (visitedOffsets.size === 1) orientation = firstValue(entries, tagOrientation, 1);
    const isFullResolution = firstValue(entries, tagNewSubfileType, 0) === 0;
    if (firstValue(entries, tagPhotometricInterpretation, 0) === photometricColorFilterArray && isFullResolution) {
      rawEntries = entries;
      break;
    }
    pendingIfdOffsets.push(...(entries.get(tagSubIfds) ?? []), nextIfdOffset);
  }
  if (!rawEntries) throw new DngFormatProblem('noRawImage');

  const compression = firstValue(rawEntries, tagCompression, 1);
  if (compression !== 1) throw new DngFormatProblem('compressed', `Compression = ${compression}`);
  const bitsPerSample = firstValue(rawEntries, tagBitsPerSample, 0);
  if (bitsPerSample !== 8 && bitsPerSample !== 16) throw new DngFormatProblem('unsupportedBitDepth', `${bitsPerSample} bits`);
  const width = firstValue(rawEntries, tagImageWidth, 0);
  const height = firstValue(rawEntries, tagImageLength, 0);
  if (width <= 0 || height <= 0) throw new DngFormatProblem('noRawImage');

  const repeatDimensions = rawEntries.get(tagCfaRepeatPatternDim) ?? [2, 2];
  const colorCodes = rawEntries.get(tagCfaPattern) ?? [];
  const originPatternName = bayerPatternsByColorCodes[colorCodes.join(',')];
  if (repeatDimensions[0] !== 2 || repeatDimensions[1] !== 2 || !originPatternName) {
    throw new DngFormatProblem('unsupportedCfaPattern', colorCodes.join(','));
  }
  // El patrón del DNG se refiere a la esquina del área activa (ActiveArea: arriba, izquierda…).
  const activeArea = rawEntries.get(tagActiveArea) ?? [0, 0];
  const bayerPattern = shiftBayerPattern(originPatternName, -(activeArea[1] ?? 0), -(activeArea[0] ?? 0));

  const blackLevels = rawEntries.get(tagBlackLevel) ?? [0];
  const blackLevel = blackLevels.reduce((sum, value) => sum + value, 0) / Math.max(1, blackLevels.length);
  const whiteLevel = firstValue(rawEntries, tagWhiteLevel, 2 ** bitsPerSample - 1);

  const tileOffsets = rawEntries.get(tagTileOffsets);
  const layoutBase = { isLittleEndian, width, height, bitsPerSample: bitsPerSample as 8 | 16, bayerPattern, blackLevel, whiteLevel, orientation };
  if (tileOffsets) {
    return {
      ...layoutBase,
      segmentOffsets: tileOffsets,
      rowsPerSegment: firstValue(rawEntries, tagTileLength, 0),
      tileWidth: firstValue(rawEntries, tagTileWidth, 0),
    };
  }
  const stripOffsets = rawEntries.get(tagStripOffsets);
  if (!stripOffsets || stripOffsets.length === 0) throw new DngFormatProblem('noRawImage');
  return {
    ...layoutBase,
    segmentOffsets: stripOffsets,
    rowsPerSegment: Math.min(height, firstValue(rawEntries, tagRowsPerStrip, height)),
    tileWidth: 0,
  };
}

export interface MosaicRegion {
  /** Valores crudos fila a fila, `width × height`. */
  values: Uint16Array;
  width: number;
  height: number;
  /** Patrón de Bayer en la esquina de la zona. */
  bayerPattern: BayerPattern;
}

/**
 * Lee una zona rectangular del mosaico (en coordenadas de la imagen guardada, sin girar). La
 * zona se ajusta a la imagen y a coordenadas pares, para que el patrón no cambie. Solo se leen
 * los bytes de la zona (una lectura por fila y tira o tesela).
 */
export function readMosaicRegion(
  byteSource: DngByteSource,
  layout: DngRawLayout,
  requestedRegion: { left: number; top: number; width: number; height: number },
): MosaicRegion {
  const evenLeft = Math.max(0, Math.min(layout.width - 2, Math.floor(requestedRegion.left / 2) * 2));
  const evenTop = Math.max(0, Math.min(layout.height - 2, Math.floor(requestedRegion.top / 2) * 2));
  const regionWidth = Math.max(2, Math.floor(Math.min(requestedRegion.width, layout.width - evenLeft) / 2) * 2);
  const regionHeight = Math.max(2, Math.floor(Math.min(requestedRegion.height, layout.height - evenTop) / 2) * 2);
  const bytesPerSample = layout.bitsPerSample / 8;
  const values = new Uint16Array(regionWidth * regionHeight);

  const copySamples = (fileOffset: number, sampleCount: number, targetIndex: number) => {
    if (fileOffset + sampleCount * bytesPerSample > byteSource.byteLength) throw new DngFormatProblem('truncated');
    const bytes = byteSource.readBytes(fileOffset, sampleCount * bytesPerSample);
    if (bytes.length < sampleCount * bytesPerSample) throw new DngFormatProblem('truncated');
    if (bytesPerSample === 1) {
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) values[targetIndex + sampleIndex] = bytes[sampleIndex]!;
      return;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      values[targetIndex + sampleIndex] = view.getUint16(sampleIndex * 2, layout.isLittleEndian);
    }
  };

  for (let regionRow = 0; regionRow < regionHeight; regionRow++) {
    const imageRow = evenTop + regionRow;
    if (layout.tileWidth === 0) {
      const stripIndex = Math.floor(imageRow / layout.rowsPerSegment);
      const stripOffset = layout.segmentOffsets[stripIndex];
      if (stripOffset === undefined) throw new DngFormatProblem('truncated');
      const rowInStrip = imageRow - stripIndex * layout.rowsPerSegment;
      copySamples(stripOffset + (rowInStrip * layout.width + evenLeft) * bytesPerSample, regionWidth, regionRow * regionWidth);
      continue;
    }
    // Teselas: la fila cruza varias; se copia el trozo de cada una.
    const tilesAcross = Math.ceil(layout.width / layout.tileWidth);
    const tileRow = Math.floor(imageRow / layout.rowsPerSegment);
    const rowInTile = imageRow - tileRow * layout.rowsPerSegment;
    let copiedColumns = 0;
    while (copiedColumns < regionWidth) {
      const imageColumn = evenLeft + copiedColumns;
      const tileColumn = Math.floor(imageColumn / layout.tileWidth);
      const columnInTile = imageColumn - tileColumn * layout.tileWidth;
      const runLength = Math.min(regionWidth - copiedColumns, layout.tileWidth - columnInTile);
      const tileOffset = layout.segmentOffsets[tileRow * tilesAcross + tileColumn];
      if (tileOffset === undefined) throw new DngFormatProblem('truncated');
      copySamples(
        tileOffset + (rowInTile * layout.tileWidth + columnInTile) * bytesPerSample,
        runLength,
        regionRow * regionWidth + copiedColumns,
      );
      copiedColumns += runLength;
    }
  }
  return {
    values,
    width: regionWidth,
    height: regionHeight,
    bayerPattern: shiftBayerPattern(layout.bayerPattern, evenLeft, evenTop),
  };
}

/** Byte source sobre un buffer en memoria (tests, o ficheros pequeños ya leídos). */
export function byteSourceFromBytes(fileBytes: Uint8Array): DngByteSource {
  return {
    byteLength: fileBytes.length,
    readBytes: (offset, length) => fileBytes.subarray(offset, Math.min(fileBytes.length, offset + length)),
  };
}
