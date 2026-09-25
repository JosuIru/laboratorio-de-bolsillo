import { reconstructAmplifiedRgba, renderVariationOverlayRgba } from './amplification';
import type { AmplifiedSignal } from './bands';
import {
  clearRegionHistory,
  createRegionHistory,
  type DominantFrequencyEstimate,
  estimateDominantFrequency,
  extractCentralRegion,
  type PixelCombination,
  pushRegionFrame,
  type RegionHistory,
  regionHistoryDurationSeconds,
} from './dominantFrequency';
import { createFrameClock } from './frameTiming';
import { createPixelBandpassFilter, filterPixelFrame, type PixelBandpassFilter } from './pixelBandpass';

/**
 * Motor de la amplificación euleriana en el hilo JS. Recibe, por cada fotograma, la rejilla
 * base (para reconstruir la imagen) y el nivel grueso de la pirámide (ya calculados en el hilo
 * de la cámara); filtra cada valor del nivel en el tiempo, reconstruye la imagen amplificada y
 * guarda la región central filtrada para la medida de frecuencia.
 */

export interface MagnificationSettings {
  lowCutoffHz: number;
  highCutoffHz: number;
  amplifiedSignal: AmplifiedSignal;
  amplificationFactor: number;
  maximumAddedLevels: number;
  measurementWindowSeconds: number;
  pixelCombination: PixelCombination;
}

export interface GridFrame {
  /** Marca de tiempo de la cámara, en su unidad (ns en Android, s en iOS). */
  rawTimestamp: number;
  baseRgb: Uint8Array;
  baseWidth: number;
  baseHeight: number;
  /** Nivel grueso: RGB si se amplifica el color, luminancia si el movimiento. */
  levelPixels: Float32Array;
  levelWidth: number;
  levelHeight: number;
  levelChannelCount: 1 | 3;
}

export type MagnificationStatus =
  /** Aún no se conoce la cadencia de fotogramas: se muestra la imagen sin amplificar. */
  | 'estimatingFrameRate'
  /** Con esta cadencia la banda elegida no cabe por debajo de Nyquist. */
  | 'bandAboveFrameRate'
  | 'running';

export interface ProcessedFrame {
  status: MagnificationStatus;
  framesPerSecond: number | null;
  /** Filtro en uso: su frecuencia superior puede estar recortada por la cadencia. */
  effectiveHighCutoffHz: number | null;
  /** RGBA opaco de baseWidth × baseHeight: el fotograma amplificado. */
  amplifiedRgba: Uint8Array | null;
  /** RGBA sin premultiplicar de levelWidth × levelHeight: el mapa de la variación. */
  overlayRgba: Uint8Array | null;
}

export interface FrameOutputRequest {
  wantsAmplifiedImage: boolean;
  wantsOverlay: boolean;
}

/** Fracción de cada lado de la rejilla que forma la región central de medida. */
export const centralRegionFraction = 1 / 3;
/** Si la cadencia estimada cambia más que esto, se rediseña el filtro. */
const frameRateChangeTolerance = 0.15;
/** Tras (re)crear el filtro, segundos antes de guardar valores para la medida (transitorio). */
const filterSettlingSeconds = 2;
/** Fotogramas por segundo máximos previstos, para dimensionar la historia. */
const maximumExpectedFramesPerSecond = 65;

export interface MagnificationEngine {
  processFrame(gridFrame: GridFrame, outputRequest: FrameOutputRequest): ProcessedFrame;
  setAmplificationFactor(amplificationFactor: number): void;
  estimateFrequency(): DominantFrequencyEstimate | null;
  /** Segundos de historia válida para la medida y los que pide la ventana. */
  measurementProgress(): { storedSeconds: number; windowSeconds: number };
  reset(): void;
}

export function createMagnificationEngine(initialSettings: MagnificationSettings): MagnificationEngine {
  const settings = { ...initialSettings };
  const frameClock = createFrameClock();
  let bandpassFilter: PixelBandpassFilter | null = null;
  let filteredLevel: Float32Array | null = null;
  let filterCreationTimeSeconds = 0;
  let regionHistory: RegionHistory | null = null;
  let isBandAboveFrameRate = false;

  function ensureFilter(gridFrame: GridFrame, framesPerSecond: number, currentTimeSeconds: number) {
    const valueCount = gridFrame.levelWidth * gridFrame.levelHeight * gridFrame.levelChannelCount;
    const isFilterStale =
      !bandpassFilter ||
      bandpassFilter.valueCount !== valueCount ||
      Math.abs(bandpassFilter.sampleRateHz - framesPerSecond) / bandpassFilter.sampleRateHz > frameRateChangeTolerance;
    if (!isFilterStale) return;
    try {
      bandpassFilter = createPixelBandpassFilter(valueCount, settings.lowCutoffHz, settings.highCutoffHz, framesPerSecond);
      isBandAboveFrameRate = false;
    } catch {
      bandpassFilter = null;
      isBandAboveFrameRate = true;
      return;
    }
    filteredLevel = new Float32Array(valueCount);
    filterCreationTimeSeconds = currentTimeSeconds;
    if (regionHistory) clearRegionHistory(regionHistory);
  }

  return {
    processFrame(gridFrame, outputRequest) {
      const currentTimeSeconds = frameClock.toSeconds(gridFrame.rawTimestamp);
      const framesPerSecond = frameClock.estimatedFramesPerSecond();
      const amplificationOptions = {
        amplificationFactor: settings.amplificationFactor,
        maximumAddedLevels: settings.maximumAddedLevels,
      };

      if (currentTimeSeconds !== null && framesPerSecond !== null) {
        ensureFilter(gridFrame, framesPerSecond, currentTimeSeconds);
      }
      if (currentTimeSeconds === null || framesPerSecond === null || !bandpassFilter || !filteredLevel) {
        // Sin filtro: la imagen tal cual (α = 0) para que la vista no se quede en negro.
        const unamplifiedRgba = outputRequest.wantsAmplifiedImage
          ? new Uint8Array(gridFrame.baseWidth * gridFrame.baseHeight * 4)
          : null;
        if (unamplifiedRgba) {
          reconstructAmplifiedRgba(
            gridFrame.baseRgb,
            gridFrame.baseWidth,
            gridFrame.baseHeight,
            new Float32Array(gridFrame.levelWidth * gridFrame.levelHeight * gridFrame.levelChannelCount),
            gridFrame.levelWidth,
            gridFrame.levelHeight,
            gridFrame.levelChannelCount,
            { amplificationFactor: 0, maximumAddedLevels: 0 },
            unamplifiedRgba,
          );
        }
        return {
          status: isBandAboveFrameRate ? 'bandAboveFrameRate' : 'estimatingFrameRate',
          framesPerSecond,
          effectiveHighCutoffHz: null,
          amplifiedRgba: unamplifiedRgba,
          overlayRgba: null,
        };
      }

      filterPixelFrame(bandpassFilter, gridFrame.levelPixels, filteredLevel);

      if (currentTimeSeconds - filterCreationTimeSeconds >= filterSettlingSeconds) {
        const measuredChannelIndex = gridFrame.levelChannelCount === 3 ? 1 : 0;
        const centralValues = extractCentralRegion(
          filteredLevel,
          gridFrame.levelWidth,
          gridFrame.levelHeight,
          gridFrame.levelChannelCount,
          measuredChannelIndex,
          centralRegionFraction,
        );
        if (!regionHistory || regionHistory.valuesPerFrame !== centralValues.length) {
          regionHistory = createRegionHistory(
            Math.ceil(settings.measurementWindowSeconds * maximumExpectedFramesPerSecond),
            centralValues.length,
          );
        }
        pushRegionFrame(regionHistory, currentTimeSeconds, centralValues);
      }

      let amplifiedRgba: Uint8Array | null = null;
      if (outputRequest.wantsAmplifiedImage) {
        amplifiedRgba = new Uint8Array(gridFrame.baseWidth * gridFrame.baseHeight * 4);
        reconstructAmplifiedRgba(
          gridFrame.baseRgb,
          gridFrame.baseWidth,
          gridFrame.baseHeight,
          filteredLevel,
          gridFrame.levelWidth,
          gridFrame.levelHeight,
          gridFrame.levelChannelCount,
          amplificationOptions,
          amplifiedRgba,
        );
      }
      let overlayRgba: Uint8Array | null = null;
      if (outputRequest.wantsOverlay) {
        overlayRgba = new Uint8Array(gridFrame.levelWidth * gridFrame.levelHeight * 4);
        renderVariationOverlayRgba(
          filteredLevel,
          gridFrame.levelWidth,
          gridFrame.levelHeight,
          gridFrame.levelChannelCount,
          amplificationOptions,
          overlayRgba,
        );
      }
      return {
        status: 'running',
        framesPerSecond,
        effectiveHighCutoffHz: bandpassFilter.highCutoffHz,
        amplifiedRgba,
        overlayRgba,
      };
    },

    setAmplificationFactor(amplificationFactor) {
      settings.amplificationFactor = amplificationFactor;
    },

    estimateFrequency() {
      if (!regionHistory || !bandpassFilter) return null;
      // Con menos de media ventana (o de dos periodos de la frecuencia más baja) no se mide.
      const minimumStoredSeconds = Math.min(
        settings.measurementWindowSeconds,
        Math.max(2 / settings.lowCutoffHz, settings.measurementWindowSeconds / 2),
      );
      if (regionHistoryDurationSeconds(regionHistory) < minimumStoredSeconds) return null;
      // Solo la ventana pedida: la historia tiene sitio para más a baja cadencia.
      return estimateDominantFrequency(regionHistory, {
        minimumFrequencyHz: settings.lowCutoffHz,
        maximumFrequencyHz: bandpassFilter.highCutoffHz,
        combination: settings.pixelCombination,
        windowSeconds: settings.measurementWindowSeconds,
      });
    },

    measurementProgress() {
      return {
        storedSeconds: Math.min(
          settings.measurementWindowSeconds,
          regionHistory ? regionHistoryDurationSeconds(regionHistory) : 0,
        ),
        windowSeconds: settings.measurementWindowSeconds,
      };
    },

    reset() {
      frameClock.reset();
      bandpassFilter = null;
      filteredLevel = null;
      isBandAboveFrameRate = false;
      if (regionHistory) clearRegionHistory(regionHistory);
    },
  };
}
