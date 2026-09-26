/**
 * Proceso completo del superzoom tras la ráfaga, con sus tiempos:
 *  1. selección, igualado de color, alineado (global y, si se pide, por zonas) y fusión
 *     (`superResolveBurstWithLocalAlignment`);
 *  2. aberración cromática lateral (estimada en la propia imagen, del perfil del móvil o nada),
 *     con la misma corrección para el superzoom y para el fotograma suelto;
 *  3. deconvolución del superzoom en sus tres niveles (la del fotograma suelto se calcula solo si
 *     se llega a mirar, con `deconvolveSingleFrame`).
 *
 * Sin React: se puede probar con ráfagas sintéticas.
 */
import {
  bilinearUpscalePsfSigma,
  deconvolveImageLevels,
  type DeconvolvedVersions,
  devicePsfSigmaForZoom,
  superResolutionPsfSigma,
} from '@/processing/image/burstDeconvolution';
import { defaultSuperResolutionOptions, kernelSigmaForFrameCount } from '@/processing/image/burstSuperResolution';
import { type LocalSuperResolutionResult, superResolveBurstWithLocalAlignment } from '@/processing/image/localBurstAlignment';
import type { FloatRgbImage } from '@/processing/image/lunarStacking';
import {
  correctRadialChromaticAberration,
  estimateRadialChromaticScales,
  motoG57ChromaticProfile,
  opticalCenterInOutput,
  type RadialChromaticScales,
} from '@/processing/image/radialChromaticAberration';

export type ChromaticCorrectionMode = 'auto' | 'profile' | 'off';

export interface SuperzoomProcessingSettings {
  useLocalAlignment: boolean;
  chromaticCorrectionMode: ChromaticCorrectionMode;
  /** Zoom de la cámara al disparar: por encima de ×2 el móvil amplía y la PSF crece. */
  zoomFactor: number;
  /** Tamaño de la foto derecha y dónde empieza el recorte en ella (para situar el centro óptico). */
  photoWidth: number;
  photoHeight: number;
  cropLeft: number;
  cropTop: number;
}

export interface ChromaticCorrectionOutcome {
  mode: ChromaticCorrectionMode;
  scales: RadialChromaticScales;
  /** En modo automático: si la estimación de cada canal fue fiable (si no, ese canal no se toca). */
  isRedReliable: boolean;
  isBlueReliable: boolean;
}

export interface SuperzoomProcessingTimings {
  selectionMilliseconds: number;
  globalAlignmentMilliseconds: number;
  localAlignmentMilliseconds: number;
  mergeMilliseconds: number;
  chromaticMilliseconds: number;
  deconvolutionMilliseconds: number;
  totalMilliseconds: number;
}

export interface SuperzoomProcessingResult {
  merge: LocalSuperResolutionResult;
  /** Fusión con la aberración cromática ya corregida, sin realce. */
  superzoomImage: FloatRgbImage;
  /** Fotograma de referencia ampliado de forma normal, con la misma corrección de color. */
  singleFrameImage: FloatRgbImage;
  chromatic: ChromaticCorrectionOutcome;
  superzoomDeconvolution: DeconvolvedVersions;
  /** PSF (px de la rejilla fina) para deconvolucionar el fotograma suelto si se pide. */
  singleFramePsfSigmaPixels: number;
  timings: SuperzoomProcessingTimings;
}

export function processSuperzoomBurst(
  frames: readonly Uint8Array[],
  cropSizePixels: number,
  settings: SuperzoomProcessingSettings,
  now: () => number = Date.now,
): SuperzoomProcessingResult {
  const processingStartTime = now();
  const { scale } = defaultSuperResolutionOptions;
  const merge = superResolveBurstWithLocalAlignment(
    frames,
    cropSizePixels,
    { ...defaultSuperResolutionOptions, useLocalAlignment: settings.useLocalAlignment, equalizeColorGains: true },
    now,
  );

  const chromaticStartTime = now();
  const opticalCenter = opticalCenterInOutput(settings.photoWidth, settings.photoHeight, settings.cropLeft, settings.cropTop, scale);
  let chromatic: ChromaticCorrectionOutcome = {
    mode: settings.chromaticCorrectionMode,
    scales: { redScale: 1, blueScale: 1 },
    isRedReliable: false,
    isBlueReliable: false,
  };
  if (settings.chromaticCorrectionMode === 'profile') {
    chromatic = { ...chromatic, scales: motoG57ChromaticProfile, isRedReliable: true, isBlueReliable: true };
  } else if (settings.chromaticCorrectionMode === 'auto') {
    const estimate = estimateRadialChromaticScales(merge.image, opticalCenter);
    chromatic = {
      ...chromatic,
      scales: { redScale: estimate.red.scale, blueScale: estimate.blue.scale },
      isRedReliable: estimate.red.isReliable,
      isBlueReliable: estimate.blue.isReliable,
    };
  }
  const hasChromaticCorrection = chromatic.scales.redScale !== 1 || chromatic.scales.blueScale !== 1;
  const superzoomImage = hasChromaticCorrection
    ? correctRadialChromaticAberration(merge.image, chromatic.scales, opticalCenter)
    : merge.image;
  const singleFrameImage = hasChromaticCorrection
    ? correctRadialChromaticAberration(merge.singleFrameImage, chromatic.scales, opticalCenter)
    : merge.singleFrameImage;
  const chromaticMilliseconds = now() - chromaticStartTime;

  const deconvolutionStartTime = now();
  const devicePsfSigma = devicePsfSigmaForZoom(settings.zoomFactor);
  const superzoomPsfSigma = superResolutionPsfSigma(devicePsfSigma, kernelSigmaForFrameCount(merge.usedFrameCount), scale);
  const superzoomDeconvolution = deconvolveImageLevels(superzoomImage, superzoomPsfSigma);
  const deconvolutionMilliseconds = now() - deconvolutionStartTime;

  return {
    merge,
    superzoomImage,
    singleFrameImage,
    chromatic,
    superzoomDeconvolution,
    singleFramePsfSigmaPixels: bilinearUpscalePsfSigma(devicePsfSigma, scale),
    timings: {
      ...merge.stageTimings,
      chromaticMilliseconds,
      deconvolutionMilliseconds,
      totalMilliseconds: now() - processingStartTime,
    },
  };
}

/** Deconvolución del fotograma suelto (para comparar en igualdad), solo cuando se mira. */
export function deconvolveSingleFrame(processingResult: SuperzoomProcessingResult): DeconvolvedVersions {
  return deconvolveImageLevels(processingResult.singleFrameImage, processingResult.singleFramePsfSigmaPixels);
}
