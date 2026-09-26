import { reconstructAmplifiedRgba } from './amplification';
import type { AmplifiedSignal } from './bands';
import {
  clearRegionHistory,
  createRegionHistory,
  type DominantFrequencyEstimate,
  estimateDominantFrequency,
  extractRegion,
  type PixelCombination,
  pushRegionFrame,
  type RegionHistory,
  regionHistoryDurationSeconds,
} from './dominantFrequency';
import { createFrameClock } from './frameTiming';
import {
  centeredMeasurementRegion,
  type MeasurementRegion,
  placeMeasurementRegion,
  regionCellBounds,
} from './measurementRegion';
import {
  amplitudeTimeConstantSeconds,
  createMotionMapState,
  type MotionMapState,
  renderHeatMapRgba,
  renderPhaseMapRgba,
  resetMotionMapState,
  setLockInFrequency,
  updateMotionMaps,
} from './motionMaps';
import { createPixelBandpassFilter, filterPixelFrame, type PixelBandpassFilter } from './pixelBandpass';

/**
 * Motor de la amplificación euleriana en el hilo JS. Recibe, por cada fotograma, la rejilla
 * base (para reconstruir la imagen) y el nivel grueso de la pirámide (ya calculados en el hilo
 * de la cámara); filtra cada valor del nivel en el tiempo, reconstruye la imagen amplificada,
 * actualiza los mapas de calor y de fase y guarda la zona de medida filtrada para la medida de
 * frecuencia.
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
  /** RGBA sin premultiplicar de levelWidth × levelHeight: amplitud del movimiento (inferno). */
  heatMapRgba: Uint8Array | null;
  /** RGBA sin premultiplicar de levelWidth × levelHeight: fase a f0; null si aún no hay f0. */
  phaseMapRgba: Uint8Array | null;
  /**
   * Media de la señal filtrada en la zona de medida (canal medido), para el monitor en vivo.
   * Null mientras el filtro se asienta.
   */
  regionFilteredMean: number | null;
}

export interface FrameOutputRequest {
  wantsAmplifiedImage: boolean;
  wantsHeatMap?: boolean;
  wantsPhaseMap?: boolean;
}
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
  /**
   * Vacía la ventana de medida (p. ej. si el móvil se ha movido) sin tocar la vista amplificada:
   * se vuelve a esperar a que el filtro se asiente antes de guardar valores.
   */
  restartMeasurementWindow(): void;
  /**
   * Mueve la zona de medida (centro en fracciones del fotograma). Vacía la historia de la medida,
   * que era de otra zona, pero no la vista ni los mapas.
   */
  setMeasurementRegionCenter(centerXFraction: number, centerYFraction: number): void;
  measurementRegion(): MeasurementRegion;
  /** Frecuencia del lock-in del mapa de fase (la dominante medida); null la olvida. */
  setLockInFrequency(lockInFrequencyHz: number | null): void;
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
  /** El próximo fotograma cuenta como el de creación del filtro (transitorio del movimiento). */
  let isMeasurementRestartPending = false;
  let measurementRegion: MeasurementRegion = centeredMeasurementRegion;
  let motionMapState: MotionMapState | null = null;
  let lockInFrequencyHz: number | null = null;
  let previousRunningTimeSeconds: number | null = null;
  let regionValuesBuffer: Float32Array | undefined;

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
    previousRunningTimeSeconds = null;
    if (regionHistory) clearRegionHistory(regionHistory);
    // Los mapas empiezan de cero con el filtro nuevo (su transitorio los ensuciaría).
    if (motionMapState?.gridWidth === gridFrame.levelWidth && motionMapState.gridHeight === gridFrame.levelHeight) {
      resetMotionMapState(motionMapState);
    } else {
      motionMapState = createMotionMapState(gridFrame.levelWidth, gridFrame.levelHeight);
    }
    setLockInFrequency(motionMapState, lockInFrequencyHz);
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
          heatMapRgba: null,
          phaseMapRgba: null,
          regionFilteredMean: null,
        };
      }

      filterPixelFrame(bandpassFilter, gridFrame.levelPixels, filteredLevel);

      if (isMeasurementRestartPending) {
        isMeasurementRestartPending = false;
        filterCreationTimeSeconds = currentTimeSeconds;
        if (regionHistory) clearRegionHistory(regionHistory);
      }

      // Con tres canales (pulso) se mide el verde, el que más cambia con la sangre.
      const measuredChannelIndex = gridFrame.levelChannelCount === 3 ? 1 : 0;
      const isFilterSettled = currentTimeSeconds - filterCreationTimeSeconds >= filterSettlingSeconds;
      let regionFilteredMean: number | null = null;
      if (isFilterSettled) {
        const regionValues = extractRegion(
          filteredLevel,
          gridFrame.levelWidth,
          gridFrame.levelHeight,
          gridFrame.levelChannelCount,
          measuredChannelIndex,
          measurementRegion,
          regionValuesBuffer,
        );
        regionValuesBuffer = regionValues;
        if (!regionHistory || regionHistory.valuesPerFrame !== regionValues.length) {
          regionHistory = createRegionHistory(
            Math.ceil(settings.measurementWindowSeconds * maximumExpectedFramesPerSecond),
            regionValues.length,
          );
        }
        pushRegionFrame(regionHistory, currentTimeSeconds, regionValues);
        let regionSum = 0;
        for (let valueIndex = 0; valueIndex < regionValues.length; valueIndex++) regionSum += regionValues[valueIndex]!;
        regionFilteredMean = regionSum / regionValues.length;
      }

      // Mapas: se actualizan en cada fotograma (son baratos) para que estén listos al elegirlos.
      const stepSeconds =
        previousRunningTimeSeconds === null
          ? 1 / framesPerSecond
          : Math.min(0.5, Math.max(0, currentTimeSeconds - previousRunningTimeSeconds));
      previousRunningTimeSeconds = currentTimeSeconds;
      let heatMapRgba: Uint8Array | null = null;
      let phaseMapRgba: Uint8Array | null = null;
      if (motionMapState && isFilterSettled) {
        updateMotionMaps(
          motionMapState,
          filteredLevel,
          gridFrame.levelChannelCount,
          measuredChannelIndex,
          currentTimeSeconds,
          stepSeconds,
          amplitudeTimeConstantSeconds(settings.lowCutoffHz, bandpassFilter.highCutoffHz),
        );
        const mapByteCount = gridFrame.levelWidth * gridFrame.levelHeight * 4;
        if (outputRequest.wantsHeatMap) {
          heatMapRgba = new Uint8Array(mapByteCount);
          renderHeatMapRgba(motionMapState, stepSeconds, heatMapRgba);
        }
        if (outputRequest.wantsPhaseMap) {
          const candidatePhaseMap = new Uint8Array(mapByteCount);
          const hasPhaseMap = renderPhaseMapRgba(
            motionMapState,
            regionCellBounds(gridFrame.levelWidth, gridFrame.levelHeight, measurementRegion),
            stepSeconds,
            candidatePhaseMap,
          );
          phaseMapRgba = hasPhaseMap ? candidatePhaseMap : null;
        }
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
      return {
        status: 'running',
        framesPerSecond,
        effectiveHighCutoffHz: bandpassFilter.highCutoffHz,
        amplifiedRgba,
        heatMapRgba,
        phaseMapRgba,
        regionFilteredMean,
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

    restartMeasurementWindow() {
      isMeasurementRestartPending = true;
      if (regionHistory) clearRegionHistory(regionHistory);
    },

    setMeasurementRegionCenter(centerXFraction, centerYFraction) {
      measurementRegion = placeMeasurementRegion(centerXFraction, centerYFraction, measurementRegion.sizeFraction);
      if (regionHistory) clearRegionHistory(regionHistory);
    },

    measurementRegion() {
      return measurementRegion;
    },

    setLockInFrequency(nextLockInFrequencyHz) {
      lockInFrequencyHz = nextLockInFrequencyHz;
      if (motionMapState) setLockInFrequency(motionMapState, nextLockInFrequencyHz);
    },

    reset() {
      isMeasurementRestartPending = false;
      previousRunningTimeSeconds = null;
      if (motionMapState) resetMotionMapState(motionMapState);
      frameClock.reset();
      bandpassFilter = null;
      filteredLevel = null;
      isBandAboveFrameRate = false;
      if (regionHistory) clearRegionHistory(regionHistory);
    },
  };
}
