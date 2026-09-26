/**
 * Procesado de las técnicas especiales de la Luna a partir de lo capturado (lógica pura, sin
 * React ni React Native): imagen afortunada con fotogramas de vídeo, superresolución por deriva
 * con el móvil en un trípode y luz cenicienta con dos exposiciones.
 */
import { superResolveByDrift } from '@/processing/image/driftSuperResolution';
import { type GrayImage, grayImageFromRgb } from '@/processing/image/grayImage';
import { estimateExposureRatio, renderEarthshineHdr } from '@/processing/image/earthshineHdr';
import { type FrameSource, stackLuckyFrames } from '@/processing/image/luckyImaging';
import { fitLunarDisk, type LunarDiskFit } from '@/processing/image/lunarDiskFit';
import { chooseCropSize, type FloatRgbImage } from '@/processing/image/lunarStacking';
import { medianValue } from '@/processing/image/lunarPhotoCrops';

import { averageGrayImages, grayImageFromBytes, resampleCenteredSquare } from './moonCapturePlanning';

// ---------------------------------------------------------------------------------------------
// Imagen afortunada
// ---------------------------------------------------------------------------------------------

export interface LuckyStackOutcome {
  /** Apilado sin realzar (luminancia 0-255). */
  stackedImage: GrayImage;
  /** El fotograma más nítido, para comparar. */
  bestSingleImage: GrayImage;
  usedFrameCount: number;
  rejectedSampleFraction: number;
  alignmentPointCount: number;
}

/** Fracción más nítida que se apila de los fotogramas de vídeo. */
export const luckyKeptFraction = 0.25;

/**
 * Apila los fotogramas (luminancia de 8 bits, `side`²) con `stackLuckyFrames`. Se pasan a coma
 * flotante de uno en uno al pedirlos: así en memoria solo están los bytes (1 byte por píxel).
 */
export function stackLuckyRecording(
  grayFrames: readonly Uint8Array[],
  side: number,
  fullDiskRadiusPixels: number,
): LuckyStackOutcome {
  const frameSource: FrameSource = {
    frameCount: grayFrames.length,
    loadFrame: (frameIndex) => grayImageFromBytes(grayFrames[frameIndex]!, side),
  };
  const luckyResult = stackLuckyFrames(frameSource, {
    keptFraction: luckyKeptFraction,
    // La nitidez se mide solo dentro del disco (el cielo es ruido).
    regionOfInterest: { centerX: side / 2, centerY: side / 2, radiusPixels: Math.min(side / 2, fullDiskRadiusPixels) },
    // Los fotogramas ya vienen recentrados en la Luna: basta buscar desplazamientos moderados.
    maximumGlobalShiftPixels: Math.max(8, Math.round(side / 12)),
  });
  return {
    stackedImage: luckyResult.image,
    bestSingleImage: frameSource.loadFrame(luckyResult.usedFrameIndices[0]!),
    usedFrameCount: luckyResult.usedFrameIndices.length,
    rejectedSampleFraction: luckyResult.rejectedSampleFraction,
    alignmentPointCount: luckyResult.alignmentPointCount,
  };
}

// ---------------------------------------------------------------------------------------------
// Superresolución por deriva
// ---------------------------------------------------------------------------------------------

export interface DriftPhoto {
  /** RGB de 8 bits, `side`² píxeles, siempre del mismo recorte fijo. */
  rgbPixels: Uint8Array;
  side: number;
  /** Segundos desde el principio de la captura; null si no se conoce. */
  timestampSeconds: number | null;
}

export interface DriftOutcome {
  superResolvedImage: FloatRgbImage;
  singleFrameImage: FloatRgbImage;
  usedFrameCount: number;
  /** Deriva medida en píxeles de la foto por segundo (null sin marcas de tiempo). */
  driftPixelsPerSecond: number | null;
  /** Recorrido total de la Luna en el recorte, en píxeles de la foto. */
  driftSpanPixels: number;
}

/** Fusiona las fotos del trípode con `superResolveByDrift` (rejilla 2×). */
export function fuseDriftPhotos(driftPhotos: readonly DriftPhoto[]): DriftOutcome {
  const [firstPhoto] = driftPhotos;
  if (!firstPhoto) throw new Error('No hay fotos para fusionar');
  const side = firstPhoto.side;
  const samePhotos = driftPhotos.filter((driftPhoto) => driftPhoto.side === side);
  const hasAllTimestamps = samePhotos.every((driftPhoto) => driftPhoto.timestampSeconds !== null);
  const driftResult = superResolveByDrift(
    samePhotos.map((driftPhoto) => driftPhoto.rgbPixels),
    side,
    hasAllTimestamps ? samePhotos.map((driftPhoto) => driftPhoto.timestampSeconds!) : undefined,
  );
  const usedCenters = driftResult.usedFrameIndices.flatMap((frameIndex) => {
    const diskFit = driftResult.diskFits[frameIndex];
    return diskFit ? [diskFit] : [];
  });
  let driftSpanPixels = 0;
  for (const firstCenter of usedCenters) {
    for (const secondCenter of usedCenters) {
      driftSpanPixels = Math.max(
        driftSpanPixels,
        Math.hypot(firstCenter.centerX - secondCenter.centerX, firstCenter.centerY - secondCenter.centerY),
      );
    }
  }
  const velocity = driftResult.driftVelocityPixelsPerSecond;
  return {
    superResolvedImage: driftResult.image,
    singleFrameImage: driftResult.singleFrameImage,
    usedFrameCount: driftResult.usedFrameIndices.length,
    driftPixelsPerSecond: velocity ? Math.hypot(velocity.velocityX, velocity.velocityY) : null,
    driftSpanPixels,
  };
}

// ---------------------------------------------------------------------------------------------
// Luz cenicienta
// ---------------------------------------------------------------------------------------------

export interface EarthshineRegion {
  /** RGB de 8 bits, `width`×`height`. */
  rgbPixels: Uint8Array;
  width: number;
  height: number;
}

export interface EarthshineOutcome {
  /** Fusión con la curva de tono, 0-1. */
  displayImage: GrayImage;
  /** Apilado de la exposición corta (lo que da una foto normal), 0-255. */
  shortExposureImage: GrayImage;
  /** Relación de exposiciones usada: la medida en los datos si es creíble, si no la nominal. */
  exposureRatio: number;
  isRatioMeasured: boolean;
  diskRadiusPixels: number;
  usedShortCount: number;
  usedLongCount: number;
}

interface FittedRegion {
  grayImage: GrayImage;
  diskFit: LunarDiskFit | null;
}

function fitRegions(regions: readonly EarthshineRegion[]): FittedRegion[] {
  return regions.map((region) => {
    const grayImage = grayImageFromRgb(region.rgbPixels, region.width, region.height);
    return { grayImage, diskFit: fitLunarDisk(grayImage) };
  });
}

function medianCircle(fittedRegions: readonly FittedRegion[]) {
  const diskFits = fittedRegions.flatMap((fittedRegion) => (fittedRegion.diskFit ? [fittedRegion.diskFit] : []));
  if (diskFits.length === 0) return null;
  return {
    centerX: medianValue(diskFits.map((diskFit) => diskFit.centerX)),
    centerY: medianValue(diskFits.map((diskFit) => diskFit.centerY)),
    radius: medianValue(diskFits.map((diskFit) => diskFit.radius)),
  };
}

/**
 * Alinea cada foto por el centro de su disco (el limbo es el mismo círculo en las dos
 * exposiciones: en la corta solo se ve la parte iluminada, en la larga el disco entero), apila
 * cada exposición y las fusiona con `renderEarthshineHdr`.
 */
export function fuseEarthshineBursts(
  shortRegions: readonly EarthshineRegion[],
  longRegions: readonly EarthshineRegion[],
  nominalExposureRatio: number,
): EarthshineOutcome {
  if (shortRegions.length === 0 || longRegions.length === 0) throw new Error('Faltan fotos de alguna exposición');
  const fittedShortRegions = fitRegions(shortRegions);
  const fittedLongRegions = fitRegions(longRegions);
  const shortCircle = medianCircle(fittedShortRegions);
  const longCircle = medianCircle(fittedLongRegions);
  // En la larga la parte iluminada satura y se desborda (el radio sale algo mayor, el centro
  // no cambia): el radio se toma de la corta si se pudo ajustar.
  const referenceCircle = shortCircle ?? longCircle;
  if (!referenceCircle) throw new Error('No se encontró el disco lunar');
  const cropSide = chooseCropSize(referenceCircle.radius, 96, 800);
  const alignAndStack = (fittedRegions: readonly FittedRegion[], fallbackCircle: typeof referenceCircle) =>
    averageGrayImages(
      fittedRegions.map((fittedRegion) => {
        // Sin ajuste propio (una foto borrosa), se usa el centro típico: en un trípode apenas se mueve.
        const center = fittedRegion.diskFit ?? fallbackCircle;
        return resampleCenteredSquare(fittedRegion.grayImage, center.centerX, center.centerY, cropSide);
      }),
    );
  const shortExposureImage = alignAndStack(fittedShortRegions, shortCircle ?? referenceCircle);
  const longExposureImage = alignAndStack(fittedLongRegions, longCircle ?? referenceCircle);
  const measuredRatio = estimateExposureRatio(shortExposureImage, longExposureImage);
  // El tiempo que informa el móvil no siempre es exacto, pero una medida muy distinta es un error.
  const isRatioMeasured =
    measuredRatio !== null && measuredRatio > nominalExposureRatio / 3 && measuredRatio < nominalExposureRatio * 3;
  const exposureRatio = isRatioMeasured ? measuredRatio : nominalExposureRatio;
  const earthshineResult = renderEarthshineHdr(shortExposureImage, longExposureImage, { exposureRatio });
  return {
    displayImage: earthshineResult.displayImage,
    shortExposureImage,
    exposureRatio,
    isRatioMeasured,
    diskRadiusPixels: referenceCircle.radius,
    usedShortCount: shortRegions.length,
    usedLongCount: longRegions.length,
  };
}
