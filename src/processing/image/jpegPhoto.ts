/**
 * Utilidades puras para las fotos JPEG de la cámara (sin React ni React Native):
 *
 * - `readJpegExifOrientation` lee la etiqueta de orientación EXIF de la cabecera. CameraX guarda
 *   los píxeles tal como salen del sensor (apaisados) y apunta en el EXIF cuánto hay que girarlos.
 * - `exifOrientationToTransform` la traduce a un giro en sentido horario y un espejo.
 * - `rawPixelsToRgb` pasa los píxeles decodificados (RGBA, BGRA, ARGB…) a RGB compacto, el
 *   formato que usan el apilado lunar y la superresolución.
 */

/** Marcadores JPEG que interesan: inicio de imagen, APP1 (EXIF), inicio de datos y fin. */
const startOfImageMarker = 0xd8;
const app1Marker = 0xe1;
const startOfScanMarker = 0xda;
const endOfImageMarker = 0xd9;
const exifOrientationTag = 0x0112;

/** Lee un entero de 16 bits con el orden de bytes indicado; null si se sale del búfer. */
function readUint16(bytes: Uint8Array, offset: number, isLittleEndian: boolean): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return isLittleEndian ? bytes[offset]! | (bytes[offset + 1]! << 8) : (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32(bytes: Uint8Array, offset: number, isLittleEndian: boolean): number | null {
  const firstHalf = readUint16(bytes, offset, isLittleEndian);
  const secondHalf = readUint16(bytes, offset + 2, isLittleEndian);
  if (firstHalf === null || secondHalf === null) return null;
  return isLittleEndian ? firstHalf + secondHalf * 0x10000 : firstHalf * 0x10000 + secondHalf;
}

/** Orientación EXIF (1-8) de un bloque TIFF que empieza en `tiffStart`; null si no la hay. */
function readTiffOrientation(bytes: Uint8Array, tiffStart: number): number | null {
  const byteOrderFirst = bytes[tiffStart];
  const byteOrderSecond = bytes[tiffStart + 1];
  let isLittleEndian: boolean;
  if (byteOrderFirst === 0x49 && byteOrderSecond === 0x49) isLittleEndian = true;
  else if (byteOrderFirst === 0x4d && byteOrderSecond === 0x4d) isLittleEndian = false;
  else return null;
  if (readUint16(bytes, tiffStart + 2, isLittleEndian) !== 42) return null;
  const firstDirectoryOffset = readUint32(bytes, tiffStart + 4, isLittleEndian);
  if (firstDirectoryOffset === null) return null;
  const directoryStart = tiffStart + firstDirectoryOffset;
  const entryCount = readUint16(bytes, directoryStart, isLittleEndian);
  if (entryCount === null) return null;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    const entryStart = directoryStart + 2 + entryIndex * 12;
    const tag = readUint16(bytes, entryStart, isLittleEndian);
    if (tag === null) return null;
    if (tag !== exifOrientationTag) continue;
    // Tipo SHORT: el valor va en los dos primeros bytes del campo de valor.
    const orientation = readUint16(bytes, entryStart + 8, isLittleEndian);
    return orientation !== null && orientation >= 1 && orientation <= 8 ? orientation : null;
  }
  return null;
}

/**
 * Orientación EXIF (1-8) de un JPEG a partir de sus primeros bytes (basta con los primeros
 * 64 KB). Devuelve 1 («ya está derecha») si no es un JPEG o no trae la etiqueta.
 */
export function readJpegExifOrientation(headerBytes: Uint8Array): number {
  if (headerBytes[0] !== 0xff || headerBytes[1] !== startOfImageMarker) return 1;
  let markerOffset = 2;
  while (markerOffset + 4 <= headerBytes.length) {
    if (headerBytes[markerOffset] !== 0xff) return 1;
    const marker = headerBytes[markerOffset + 1]!;
    // Bytes de relleno 0xFF entre segmentos.
    if (marker === 0xff) {
      markerOffset++;
      continue;
    }
    if (marker === startOfScanMarker || marker === endOfImageMarker) return 1;
    const segmentLength = readUint16(headerBytes, markerOffset + 2, false);
    if (segmentLength === null || segmentLength < 2) return 1;
    const segmentDataStart = markerOffset + 4;
    const isExifSegment =
      marker === app1Marker &&
      headerBytes[segmentDataStart] === 0x45 && // E
      headerBytes[segmentDataStart + 1] === 0x78 && // x
      headerBytes[segmentDataStart + 2] === 0x69 && // i
      headerBytes[segmentDataStart + 3] === 0x66 && // f
      headerBytes[segmentDataStart + 4] === 0 &&
      headerBytes[segmentDataStart + 5] === 0;
    if (isExifSegment) return readTiffOrientation(headerBytes, segmentDataStart + 6) ?? 1;
    markerOffset += 2 + segmentLength;
  }
  return 1;
}

export type ClockwiseRotationDegrees = 0 | 90 | 180 | 270;

export interface ImageTransform {
  /** Giro en sentido horario que hay que aplicar a los píxeles guardados para verlos derechos. */
  clockwiseDegrees: ClockwiseRotationDegrees;
  /** Si además hay que reflejarlos en horizontal (después de girar). Solo en la cámara frontal. */
  isMirrored: boolean;
}

/** Giro y espejo que corresponden a una orientación EXIF (1-8). */
export function exifOrientationToTransform(exifOrientation: number): ImageTransform {
  switch (exifOrientation) {
    case 2:
      return { clockwiseDegrees: 0, isMirrored: true };
    case 3:
      return { clockwiseDegrees: 180, isMirrored: false };
    case 4:
      return { clockwiseDegrees: 180, isMirrored: true };
    case 5:
      return { clockwiseDegrees: 90, isMirrored: true };
    case 6:
      return { clockwiseDegrees: 90, isMirrored: false };
    case 7:
      return { clockwiseDegrees: 270, isMirrored: true };
    case 8:
      return { clockwiseDegrees: 270, isMirrored: false };
    default:
      return { clockwiseDegrees: 0, isMirrored: false };
  }
}

/** Formatos de píxel de 3 o 4 bytes que puede entregar el decodificador. */
export type DecodedPixelFormat = 'RGBA' | 'RGBX' | 'BGRA' | 'BGRX' | 'ARGB' | 'XRGB' | 'ABGR' | 'XBGR' | 'RGB' | 'BGR';

/** Posición de rojo, verde y azul dentro de cada píxel, y bytes por píxel. */
const channelLayouts: Record<DecodedPixelFormat, { red: number; green: number; blue: number; bytesPerPixel: number }> = {
  RGBA: { red: 0, green: 1, blue: 2, bytesPerPixel: 4 },
  RGBX: { red: 0, green: 1, blue: 2, bytesPerPixel: 4 },
  BGRA: { red: 2, green: 1, blue: 0, bytesPerPixel: 4 },
  BGRX: { red: 2, green: 1, blue: 0, bytesPerPixel: 4 },
  ARGB: { red: 1, green: 2, blue: 3, bytesPerPixel: 4 },
  XRGB: { red: 1, green: 2, blue: 3, bytesPerPixel: 4 },
  ABGR: { red: 3, green: 2, blue: 1, bytesPerPixel: 4 },
  XBGR: { red: 3, green: 2, blue: 1, bytesPerPixel: 4 },
  RGB: { red: 0, green: 1, blue: 2, bytesPerPixel: 3 },
  BGR: { red: 2, green: 1, blue: 0, bytesPerPixel: 3 },
};

export function isSupportedPixelFormat(pixelFormat: string): pixelFormat is DecodedPixelFormat {
  return pixelFormat in channelLayouts;
}

/**
 * Pasa píxeles decodificados a RGB compacto (`width`×`height`×3). `bytesPerRow` puede ser mayor
 * que `width`×bytes por píxel (relleno al final de cada fila).
 */
export function rawPixelsToRgb(
  pixels: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  pixelFormat: DecodedPixelFormat,
): Uint8Array {
  const { red, green, blue, bytesPerPixel } = channelLayouts[pixelFormat];
  if (bytesPerRow < width * bytesPerPixel || pixels.length < bytesPerRow * (height - 1) + width * bytesPerPixel) {
    throw new Error(`Búfer de píxeles demasiado pequeño (${pixels.length} bytes para ${width}×${height} ${pixelFormat})`);
  }
  const rgbPixels = new Uint8Array(width * height * 3);
  let targetOffset = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    let sourceOffset = rowIndex * bytesPerRow;
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      rgbPixels[targetOffset] = pixels[sourceOffset + red]!;
      rgbPixels[targetOffset + 1] = pixels[sourceOffset + green]!;
      rgbPixels[targetOffset + 2] = pixels[sourceOffset + blue]!;
      targetOffset += 3;
      sourceOffset += bytesPerPixel;
    }
  }
  return rgbPixels;
}
