/**
 * Lectura de las fotos RAW (DNG) de la ráfaga: solo la cabecera y las filas de la zona de la
 * Luna, directamente del fichero (un DNG de 12 MP ocupa ~25 MB y no se carga entero).
 */
import { File } from 'expo-file-system';

import {
  clampRectToImage,
  type PixelRect,
  type PixelSize,
  rotatedSize,
  uprightRectToStoredRect,
} from '@/core/camera/photoCropGeometry';
import { type DngByteSource, type DngRawLayout, parseDngRawLayout, readMosaicRegion } from '@/processing/image/dngDecoder';
import { extractGreenChannel } from '@/processing/image/greenChannelMono';
import type { GrayImage } from '@/processing/image/grayImage';
import { exifOrientationToTransform } from '@/processing/image/jpegPhoto';
import { rotateGrayImage } from '@/processing/image/rawGreenStack';

/** Bytes del principio del fichero que se guardan en memoria (cabecera e IFD). */
const headerCacheByteCount = 256 * 1024;

export interface RawMoonFrame {
  /** Verde del mosaico, lineal (0 = negro, 1 = saturado), derecho como la pantalla. */
  greenImage: GrayImage;
  /** Zona leída, en coordenadas del RAW derecho. */
  uprightRegion: PixelRect;
  uprightRawSize: PixelSize;
  layout: DngRawLayout;
  wasMarkedUsable: boolean;
}

/** Acceso por desplazamiento a un fichero, con la cabecera en memoria. Hay que llamar a `close`. */
function openFileByteSource(fileUri: string): { byteSource: DngByteSource; close(): void } {
  const fileHandle = new File(fileUri).open();
  const fileSize = fileHandle.size ?? 0;
  fileHandle.offset = 0;
  const headerBytes = fileHandle.readBytes(Math.min(headerCacheByteCount, fileSize));
  return {
    byteSource: {
      byteLength: fileSize,
      readBytes: (offset, length) => {
        if (offset + length <= headerBytes.length) return headerBytes.subarray(offset, offset + length);
        fileHandle.offset = offset;
        return fileHandle.readBytes(length);
      },
    },
    close: () => fileHandle.close(),
  };
}

/**
 * Lee de un DNG la zona que pide `planRegion` (en el RAW derecho) y devuelve su canal verde,
 * derecho. Lanza `DngFormatProblem` si el DNG no se entiende (comprimido, etc.).
 */
export function readRawMoonFrame(
  fileUri: string,
  planRegion: (uprightRawSize: PixelSize) => PixelRect,
  wasMarkedUsable: boolean,
): RawMoonFrame {
  const openedFile = openFileByteSource(fileUri);
  try {
    const layout = parseDngRawLayout(openedFile.byteSource);
    const orientationTransform = exifOrientationToTransform(layout.orientation);
    const storedSize = { width: layout.width, height: layout.height };
    // Los datos del DNG nunca vienen girados: falta todo el giro de la etiqueta Orientation.
    const uprightRawSize = rotatedSize(storedSize, orientationTransform.clockwiseDegrees);
    const uprightRegion = clampRectToImage(planRegion(uprightRawSize), uprightRawSize);
    // El espejo se aplica después del giro: se deshace antes de traducir la zona.
    const rotatedOnlyRegion = orientationTransform.isMirrored
      ? { ...uprightRegion, left: uprightRawSize.width - uprightRegion.left - uprightRegion.width }
      : uprightRegion;
    const storedRegion = uprightRectToStoredRect(rotatedOnlyRegion, storedSize, orientationTransform.clockwiseDegrees);
    const mosaicRegion = readMosaicRegion(openedFile.byteSource, layout, storedRegion);
    const storedGreen = extractGreenChannel(mosaicRegion.values, mosaicRegion.width, mosaicRegion.height, {
      pattern: mosaicRegion.bayerPattern,
      blackLevel: layout.blackLevel,
      whiteLevel: layout.whiteLevel,
      mode: 'fullResolution',
    });
    return {
      greenImage: rotateGrayImage(storedGreen, orientationTransform.clockwiseDegrees, orientationTransform.isMirrored),
      uprightRegion,
      uprightRawSize,
      layout,
      wasMarkedUsable,
    };
  } finally {
    openedFile.close();
  }
}
