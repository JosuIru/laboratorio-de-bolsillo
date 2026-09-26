/**
 * Superresolución por deriva: con el móvil quieto (en un trípode, o apoyado), la rotación de la
 * Tierra arrastra la Luna ~15″/s, unas 0,2 px/s con la cámara principal sin óptica. En 30-120 s
 * el disco recorre varios píxeles y cada fotograma lo muestrea en una fase subpíxel distinta:
 * juntos llenan una rejilla más fina que la del sensor.
 *
 *  1. Centro de cada fotograma con `fitLunarDisk` (subpíxel, valga la fase que valga).
 *  2. Con marcas de tiempo, se ajusta una recta centro(t) = centro₀ + v·t: la deriva es uniforme,
 *     así que la recta promedia el error de cada ajuste; se descartan los fotogramas que se
 *     apartan (un golpe al trípode).
 *  3. Desplazamientos respecto al fotograma central y fusión en una rejilla 2× con
 *     `mergeFramesToFinerGrid` (la misma de la ráfaga a mano).
 *
 * Los fotogramas deben ser un recorte FIJO del sensor (no recentrado en cada fotograma), o la
 * deriva deja de ser una recta. RGB de 8 bits, `size`² píxeles.
 *
 * Módulo puro: sin React ni React Native.
 */

import {
  type FrameOffset,
  kernelSigmaForFrameCount,
  mergeFramesToFinerGrid,
  upscaleFrameBilinear,
} from './burstSuperResolution';
import { grayImageFromRgb } from './grayImage';
import type { FloatRgbImage } from './lunarStacking';
import { type DiskFitOptions, fitLunarDisk, type LunarDiskFit } from './lunarDiskFit';

export interface LinearDriftFit {
  /** Centro en t = 0. */
  interceptX: number;
  interceptY: number;
  velocityXPixelsPerSecond: number;
  velocityYPixelsPerSecond: number;
  /** Distancia de cada centro medido a la recta, en píxeles. */
  residualsPixels: number[];
}

/** Recta de mínimos cuadrados de los centros frente al tiempo, en x y en y por separado. */
export function fitLinearDrift(
  timestampsSeconds: readonly number[],
  centersX: readonly number[],
  centersY: readonly number[],
): LinearDriftFit | null {
  const sampleCount = timestampsSeconds.length;
  if (sampleCount < 2) return null;
  const meanTime = timestampsSeconds.reduce((sum, time) => sum + time, 0) / sampleCount;
  const meanX = centersX.reduce((sum, value) => sum + value, 0) / sampleCount;
  const meanY = centersY.reduce((sum, value) => sum + value, 0) / sampleCount;
  let timeVariance = 0;
  let timeCovarianceX = 0;
  let timeCovarianceY = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const timeDeviation = timestampsSeconds[sampleIndex]! - meanTime;
    timeVariance += timeDeviation * timeDeviation;
    timeCovarianceX += timeDeviation * (centersX[sampleIndex]! - meanX);
    timeCovarianceY += timeDeviation * (centersY[sampleIndex]! - meanY);
  }
  if (timeVariance === 0) return null;
  const velocityXPixelsPerSecond = timeCovarianceX / timeVariance;
  const velocityYPixelsPerSecond = timeCovarianceY / timeVariance;
  const interceptX = meanX - velocityXPixelsPerSecond * meanTime;
  const interceptY = meanY - velocityYPixelsPerSecond * meanTime;
  const residualsPixels = timestampsSeconds.map((time, sampleIndex) =>
    Math.hypot(
      centersX[sampleIndex]! - (interceptX + velocityXPixelsPerSecond * time),
      centersY[sampleIndex]! - (interceptY + velocityYPixelsPerSecond * time),
    ),
  );
  return { interceptX, interceptY, velocityXPixelsPerSecond, velocityYPixelsPerSecond, residualsPixels };
}

export interface DriftSuperResolutionOptions {
  /** Factor de ampliación de la rejilla de salida. */
  scale: number;
  /** Usar la recta de deriva (requiere marcas de tiempo) en vez de cada centro por separado. */
  useLinearDriftModel: boolean;
  /** Fotogramas cuyo centro se aparta más que esto de la recta se descartan, en píxeles. */
  maximumDriftResidualPixels: number;
  diskFitOptions?: Partial<DiskFitOptions>;
}

export const defaultDriftSuperResolutionOptions: DriftSuperResolutionOptions = {
  scale: 2,
  useLinearDriftModel: true,
  maximumDriftResidualPixels: 0.6,
};

export interface DriftSuperResolutionResult {
  /** Sin realzar, `scale` veces más lado que los fotogramas. */
  image: FloatRgbImage;
  /** El fotograma de referencia ampliado sin más, para comparar. */
  singleFrameImage: FloatRgbImage;
  referenceFrameIndex: number;
  /** Fotogramas fusionados (índices en la secuencia recibida). */
  usedFrameIndices: number[];
  /** Desplazamiento de cada fotograma usado respecto a la referencia. */
  frameOffsets: FrameOffset[];
  /** Ajuste del disco de cada fotograma (`null` si falló). */
  diskFits: (LunarDiskFit | null)[];
  /** Deriva medida, si había marcas de tiempo. */
  driftVelocityPixelsPerSecond: { velocityX: number; velocityY: number } | null;
}

/** Proceso completo de superresolución por deriva. */
export function superResolveByDrift(
  frames: readonly Uint8Array[],
  size: number,
  timestampsSeconds?: readonly number[],
  partialOptions: Partial<DriftSuperResolutionOptions> = {},
): DriftSuperResolutionResult {
  const options = { ...defaultDriftSuperResolutionOptions, ...partialOptions };
  if (frames.length === 0) throw new Error('No hay fotogramas para fusionar');
  if (timestampsSeconds && timestampsSeconds.length !== frames.length) {
    throw new Error('Hace falta una marca de tiempo por fotograma');
  }

  const diskFits = frames.map((framePixels) => fitLunarDisk(grayImageFromRgb(framePixels, size, size), options.diskFitOptions));
  let candidateIndices = diskFits.flatMap((diskFit, frameIndex) => (diskFit ? [frameIndex] : []));
  if (candidateIndices.length === 0) throw new Error('No se encontró el disco lunar en ningún fotograma');

  // Centro de cada fotograma: el medido o, con la recta de deriva, el que predice la recta.
  const centerOf = new Map<number, { centerX: number; centerY: number }>();
  let driftVelocityPixelsPerSecond: DriftSuperResolutionResult['driftVelocityPixelsPerSecond'] = null;
  const driftFit =
    options.useLinearDriftModel && timestampsSeconds
      ? fitLinearDrift(
          candidateIndices.map((frameIndex) => timestampsSeconds[frameIndex]!),
          candidateIndices.map((frameIndex) => diskFits[frameIndex]!.centerX),
          candidateIndices.map((frameIndex) => diskFits[frameIndex]!.centerY),
        )
      : null;
  if (driftFit && timestampsSeconds) {
    // Descarta los que se apartan y vuelve a ajustar con los demás.
    const keptIndices = candidateIndices.filter(
      (_frameIndex, candidatePosition) => driftFit.residualsPixels[candidatePosition]! <= options.maximumDriftResidualPixels,
    );
    const refinedFit =
      keptIndices.length >= 2
        ? fitLinearDrift(
            keptIndices.map((frameIndex) => timestampsSeconds[frameIndex]!),
            keptIndices.map((frameIndex) => diskFits[frameIndex]!.centerX),
            keptIndices.map((frameIndex) => diskFits[frameIndex]!.centerY),
          )
        : null;
    if (refinedFit) {
      candidateIndices = keptIndices;
      driftVelocityPixelsPerSecond = {
        velocityX: refinedFit.velocityXPixelsPerSecond,
        velocityY: refinedFit.velocityYPixelsPerSecond,
      };
      for (const frameIndex of candidateIndices) {
        const time = timestampsSeconds[frameIndex]!;
        centerOf.set(frameIndex, {
          centerX: refinedFit.interceptX + refinedFit.velocityXPixelsPerSecond * time,
          centerY: refinedFit.interceptY + refinedFit.velocityYPixelsPerSecond * time,
        });
      }
    }
  }
  if (centerOf.size === 0) {
    for (const frameIndex of candidateIndices) centerOf.set(frameIndex, diskFits[frameIndex]!);
  }

  // Referencia: el fotograma del medio, para que los desplazamientos queden repartidos a los dos lados.
  const referenceFrameIndex = candidateIndices[Math.floor(candidateIndices.length / 2)]!;
  const usedFrameIndices = [referenceFrameIndex, ...candidateIndices.filter((frameIndex) => frameIndex !== referenceFrameIndex)];
  const referenceCenter = centerOf.get(referenceFrameIndex)!;
  const frameOffsets = usedFrameIndices.map((frameIndex) => {
    const frameCenter = centerOf.get(frameIndex)!;
    return { offsetX: frameCenter.centerX - referenceCenter.centerX, offsetY: frameCenter.centerY - referenceCenter.centerY };
  });

  const usedFrames = usedFrameIndices.map((frameIndex) => frames[frameIndex]!);
  return {
    image: mergeFramesToFinerGrid(
      usedFrames,
      frameOffsets,
      usedFrames.map(() => null),
      size,
      { scale: options.scale, kernelSigmaPixels: kernelSigmaForFrameCount(usedFrames.length) },
    ),
    singleFrameImage: upscaleFrameBilinear(frames[referenceFrameIndex]!, size, options.scale),
    referenceFrameIndex,
    usedFrameIndices,
    frameOffsets,
    diskFits,
    driftVelocityPixelsPerSecond,
  };
}
