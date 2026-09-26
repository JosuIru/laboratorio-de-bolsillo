/**
 * Decisiones de captura del cielo estrellado (sin React): zona de la foto, ISO, exposición y
 * conversiones de píxeles para mostrar los resultados.
 */
import type { PixelRect, PixelSize } from '@/core/camera/photoCropGeometry';
import { centeredSquareCrop } from '@/core/camera/photoCropGeometry';
import type { GrayImage } from '@/processing/image/grayImage';
import type { FrameSource } from '@/processing/image/luckyImaging';

export type SkyMode = 'stack' | 'trails' | 'meteors';
export const skyModes: readonly SkyMode[] = ['stack', 'trails', 'meteors'];

/** Zona de cada foto: el campo entero reducido o el centro a resolución completa. */
export type SkyFieldChoice = 'whole' | 'center';
export const skyFieldChoices: readonly SkyFieldChoice[] = ['whole', 'center'];

/** Lado mayor del campo entero tras reducirlo: 1280 px ≈ 1,2 MP por foto, asumible en el hilo JS. */
export const wholeFieldMaximumSide = 1280;
/** Lado del recorte central a resolución completa. */
export const centerCropSide = 1024;

export const isoChoices: readonly number[] = [1600, 3200, 6400];
export const defaultIsoChoice = 3200;
export const stackFrameCountChoices: readonly number[] = [16, 32, 48];
export const defaultStackFrameCount = 32;
/** Fotos por tanda: se decodifican y se pasan a gris antes de la siguiente para no llenar la memoria. */
export const photosPerBurstChunk = 8;
/**
 * Exposición más larga que se pide. Casi todos los móviles se quedan por debajo (185 ms en
 * muchos Android); con más de 2 s las estrellas ya dejan trazo con un gran angular.
 */
export const longestUsefulExposureSeconds = 2;

export interface CaptureRegion {
  cropRect: PixelRect;
  /** Reducción en nativo hasta este lado (undefined: sin reducir). */
  maximumOutputSide: number | undefined;
}

export function captureRegionFor(fieldChoice: SkyFieldChoice, uprightPhotoSize: PixelSize): CaptureRegion {
  if (fieldChoice === 'center') {
    return { cropRect: centeredSquareCrop(uprightPhotoSize, centerCropSide), maximumOutputSide: undefined };
  }
  return {
    cropRect: { left: 0, top: 0, width: uprightPhotoSize.width, height: uprightPhotoSize.height },
    maximumOutputSide: wholeFieldMaximumSide,
  };
}

/** ISO pedido dentro de lo que admite el sensor. */
export function clampIso(requestedIso: number, minimumIso: number, maximumIso: number): number {
  if (maximumIso <= 0) return requestedIso;
  return Math.round(Math.min(maximumIso, Math.max(minimumIso, requestedIso)));
}

/** La exposición más larga que permite el móvil, sin pasar de la útil. */
export function nightExposureSeconds(maximumExposureSeconds: number): number {
  return Math.min(maximumExposureSeconds, longestUsefulExposureSeconds);
}

/** Luminancia de 8 bits de un RGB entrelazado. */
export function grayBytesFromRgb(rgbPixels: Uint8Array, pixelCount: number): Uint8Array {
  const grayBytes = new Uint8Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const pixelOffset = pixelIndex * 3;
    grayBytes[pixelIndex] = Math.round(
      0.299 * rgbPixels[pixelOffset]! + 0.587 * rgbPixels[pixelOffset + 1]! + 0.114 * rgbPixels[pixelOffset + 2]!,
    );
  }
  return grayBytes;
}

/** RGBA opaco (para Skia) a partir de gris o de RGB entrelazado. */
export function bytesToRgba(pixelBytes: Uint8Array, pixelCount: number, channelCount: 1 | 3): Uint8Array {
  const rgbaPixels = new Uint8Array(pixelCount * 4);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const outputOffset = pixelIndex * 4;
    if (channelCount === 1) {
      const grayValue = pixelBytes[pixelIndex]!;
      rgbaPixels[outputOffset] = grayValue;
      rgbaPixels[outputOffset + 1] = grayValue;
      rgbaPixels[outputOffset + 2] = grayValue;
    } else {
      rgbaPixels[outputOffset] = pixelBytes[pixelIndex * 3]!;
      rgbaPixels[outputOffset + 1] = pixelBytes[pixelIndex * 3 + 1]!;
      rgbaPixels[outputOffset + 2] = pixelBytes[pixelIndex * 3 + 2]!;
    }
    rgbaPixels[outputOffset + 3] = 255;
  }
  return rgbaPixels;
}

export interface StoredGrayFrame {
  grayBytes: Uint8Array;
  width: number;
  height: number;
}

/** Fuente de fotogramas para el apilado: se pasan a coma flotante al pedirlos. */
export function frameSourceFromGrayFrames(storedFrames: readonly StoredGrayFrame[]): FrameSource {
  return {
    frameCount: storedFrames.length,
    loadFrame: (frameIndex): GrayImage => {
      const storedFrame = storedFrames[frameIndex]!;
      return { width: storedFrame.width, height: storedFrame.height, values: Float32Array.from(storedFrame.grayBytes) };
    },
  };
}

/** Duración legible «h:mm:ss» o «m:ss». */
export function formatElapsedTime(elapsedMilliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMilliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedSeconds = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`;
}
