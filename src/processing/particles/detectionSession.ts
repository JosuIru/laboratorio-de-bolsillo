/**
 * Recuento de una sesión de detección: recibe el resultado de cada fotograma analizado
 * (`detectParticleEventsInFrame`) y lleva la cuenta de sucesos por forma, los fotogramas
 * descartados, los píxeles que se vuelven calientes durante la medición y el umbral adaptativo.
 *
 * El estado se modifica en el sitio (llegan varios fotogramas por segundo y la lista de sucesos
 * crece durante horas); quien lo usa decide cuándo repintar.
 *
 * Módulo puro: sin React ni React Native.
 */

import {
  adaptThresholdOffset,
  defaultThresholdAdaptationOptions,
  mergeHotPixelIndices,
  neighbourhoodPixelIndices,
  registerEventPeak,
} from './darkCalibration';
import type { FrameDetectionResult, ParticleShape } from './darkFrameEvents';
import { countingRate, type CountingRate } from './countingStatistics';
import type { BrightnessThumbnail } from './thumbnailRendering';

export interface AcceptedParticleEvent {
  eventId: number;
  shape: ParticleShape;
  detectedAtMilliseconds: number;
  peakPixelIndex: number;
  pixelCount: number;
  lengthPixels: number;
  peakBrightness: number;
  totalExcessBrightness: number;
  thumbnail: BrightnessThumbnail;
}

export interface DetectionSessionOptions {
  /** Veces que un mismo píxel (o un vecino) puede dar suceso antes de pasar a la máscara. */
  hotPixelRepeatLimit: number;
  /** Con más sucesos que estos en un fotograma, es un fogonazo de ruido: se descarta entero. */
  maximumEventsPerFrame: number;
  /** Fotogramas de cada tanda para decidir si se sube el umbral. */
  adaptationWindowFrames: number;
}

export const defaultDetectionSessionOptions: DetectionSessionOptions = {
  hotPixelRepeatLimit: 3,
  maximumEventsPerFrame: 6,
  adaptationWindowFrames: 150,
};

export interface DetectionSessionState {
  frameWidth: number;
  frameHeight: number;
  thresholdOffset: number;
  /** Máscara (ordenada): la de la calibración más los píxeles que se han calentado después. */
  hotPixelIndices: Int32Array;
  analyzedFrameCount: number;
  lightLeakFrameCount: number;
  /** Fotogramas con demasiadas semillas o sucesos: ruido, no partículas. */
  noisyFrameCount: number;
  darkLevelSum: number;
  acceptedEvents: AcceptedParticleEvent[];
  /** Sucesos retirados porque su píxel resultó estar caliente. */
  discardedHotEventCount: number;
  /** Sucesos demasiado grandes (luz que se cuela), que no cuentan. */
  oversizedEventCount: number;
  addedHotPixelCount: number;
  thresholdRaiseCount: number;
  peakOccurrenceCounts: Map<number, number>;
  adaptationWindowFrameCount: number;
  adaptationWindowClusterCount: number;
  nextEventId: number;
}

export function createDetectionSession(
  frameWidth: number,
  frameHeight: number,
  thresholdOffset: number,
  hotPixelIndices: Int32Array,
): DetectionSessionState {
  return {
    frameWidth,
    frameHeight,
    thresholdOffset,
    hotPixelIndices,
    analyzedFrameCount: 0,
    lightLeakFrameCount: 0,
    noisyFrameCount: 0,
    darkLevelSum: 0,
    acceptedEvents: [],
    discardedHotEventCount: 0,
    oversizedEventCount: 0,
    addedHotPixelCount: 0,
    thresholdRaiseCount: 0,
    peakOccurrenceCounts: new Map(),
    adaptationWindowFrameCount: 0,
    adaptationWindowClusterCount: 0,
    nextEventId: 1,
  };
}

export interface FrameApplicationOutcome {
  /** La máscara o el umbral han cambiado: hay que pasárselos al hilo de la cámara. */
  hasDetectionSettingsChanged: boolean;
  newEventCount: number;
}

/** Retira los sucesos aceptados cuyo píxel más brillante está en `pixelIndices`. */
function discardEventsAtPixels(sessionState: DetectionSessionState, pixelIndices: readonly number[]): void {
  const discardedPixelSet = new Set(pixelIndices);
  const keptEvents = sessionState.acceptedEvents.filter(
    (acceptedEvent) => !discardedPixelSet.has(acceptedEvent.peakPixelIndex),
  );
  sessionState.discardedHotEventCount += sessionState.acceptedEvents.length - keptEvents.length;
  sessionState.acceptedEvents = keptEvents;
}

export function applyFrameDetection(
  sessionState: DetectionSessionState,
  detection: FrameDetectionResult,
  detectedAtMilliseconds: number,
  options: DetectionSessionOptions = defaultDetectionSessionOptions,
): FrameApplicationOutcome {
  const outcome: FrameApplicationOutcome = { hasDetectionSettingsChanged: false, newEventCount: 0 };
  if (detection.isLightLeak) {
    sessionState.lightLeakFrameCount++;
    return outcome;
  }
  sessionState.analyzedFrameCount++;
  sessionState.darkLevelSum += detection.darkLevel;
  sessionState.oversizedEventCount += detection.oversizedClusterCount;
  sessionState.adaptationWindowFrameCount++;
  sessionState.adaptationWindowClusterCount += detection.isOverflowing
    ? options.maximumEventsPerFrame + 1
    : detection.clusterCount;

  if (detection.isOverflowing || detection.clusterCount > options.maximumEventsPerFrame) {
    sessionState.noisyFrameCount++;
  } else {
    for (const detectedEvent of detection.events) {
      const isNowHot = registerEventPeak(
        sessionState.peakOccurrenceCounts,
        detectedEvent.peakPixelIndex,
        sessionState.frameWidth,
        sessionState.frameHeight,
        options.hotPixelRepeatLimit,
      );
      if (isNowHot) {
        const hotNeighbourhood = neighbourhoodPixelIndices(
          detectedEvent.peakPixelIndex,
          sessionState.frameWidth,
          sessionState.frameHeight,
        );
        discardEventsAtPixels(sessionState, hotNeighbourhood);
        sessionState.discardedHotEventCount++;
        const previousMaskSize = sessionState.hotPixelIndices.length;
        sessionState.hotPixelIndices = mergeHotPixelIndices(sessionState.hotPixelIndices, hotNeighbourhood);
        sessionState.addedHotPixelCount += sessionState.hotPixelIndices.length - previousMaskSize;
        outcome.hasDetectionSettingsChanged = true;
        continue;
      }
      sessionState.acceptedEvents.push({
        eventId: sessionState.nextEventId++,
        shape: detectedEvent.shape,
        detectedAtMilliseconds,
        peakPixelIndex: detectedEvent.peakPixelIndex,
        pixelCount: detectedEvent.pixelCount,
        lengthPixels: detectedEvent.lengthPixels,
        peakBrightness: detectedEvent.peakBrightness,
        totalExcessBrightness: detectedEvent.totalExcessBrightness,
        thumbnail: { pixels: detectedEvent.thumbnailPixels, side: detectedEvent.thumbnailSide },
      });
      outcome.newEventCount++;
    }
  }

  if (sessionState.adaptationWindowFrameCount >= options.adaptationWindowFrames) {
    const adaptedOffset = adaptThresholdOffset(
      sessionState.thresholdOffset,
      sessionState.adaptationWindowClusterCount,
      sessionState.adaptationWindowFrameCount,
      defaultThresholdAdaptationOptions,
    );
    if (adaptedOffset !== sessionState.thresholdOffset) {
      sessionState.thresholdOffset = adaptedOffset;
      sessionState.thresholdRaiseCount++;
      outcome.hasDetectionSettingsChanged = true;
    }
    sessionState.adaptationWindowFrameCount = 0;
    sessionState.adaptationWindowClusterCount = 0;
  }
  return outcome;
}

export interface DetectionSessionSummary {
  eventCount: number;
  spotCount: number;
  wormCount: number;
  trackCount: number;
  allEventsRate: CountingRate | null;
  trackRate: CountingRate | null;
  meanDarkLevel: number;
}

export function summarizeDetectionSession(
  sessionState: DetectionSessionState,
  durationMinutes: number,
): DetectionSessionSummary {
  const countByShape: Record<ParticleShape, number> = { spot: 0, worm: 0, track: 0 };
  for (const acceptedEvent of sessionState.acceptedEvents) countByShape[acceptedEvent.shape]++;
  const eventCount = sessionState.acceptedEvents.length;
  return {
    eventCount,
    spotCount: countByShape.spot,
    wormCount: countByShape.worm,
    trackCount: countByShape.track,
    allEventsRate: countingRate(eventCount, durationMinutes),
    trackRate: countingRate(countByShape.track, durationMinutes),
    meanDarkLevel: sessionState.analyzedFrameCount > 0 ? sessionState.darkLevelSum / sessionState.analyzedFrameCount : 0,
  };
}

/**
 * Fracción de los fotogramas que da la cámara que se han llegado a analizar (el resto se pierden
 * mientras se procesa el anterior). Aproximada: supone que la cámara mantiene `framesPerSecond`.
 */
export function analyzedFrameFraction(
  processedFrameCount: number,
  elapsedSeconds: number,
  framesPerSecond: number | undefined,
): number | null {
  if (!framesPerSecond || framesPerSecond <= 0 || elapsedSeconds <= 0) return null;
  return Math.min(1, processedFrameCount / (elapsedSeconds * framesPerSecond));
}

/**
 * Minutos en los que el detector estuvo mirando de verdad. Las partículas que llegan durante los
 * fotogramas descartados (luz, fogonazos de ruido) no cuentan, así que dividir entre el tiempo de
 * reloj daría una tasa más baja de la real. Se descuentan siempre esos fotogramas. Los que la
 * cámara dio pero no llegaron a analizarse solo se descuentan si se conoce la cadencia real
 * (`framesPerSecond`, con la exposición fijada): con exposición automática, a oscuras la cámara
 * puede bajar la cadencia por su cuenta y la corrección inflaría la tasa.
 */
export function liveObservationMinutes({
  elapsedSeconds,
  processedFrameCount,
  cleanFrameCount,
  framesPerSecond,
}: {
  elapsedSeconds: number;
  /** Fotogramas analizados, incluidos los descartados por luz o ruido. */
  processedFrameCount: number;
  cleanFrameCount: number;
  framesPerSecond: number | undefined;
}): number {
  const elapsedMinutes = Math.max(0, elapsedSeconds) / 60;
  if (processedFrameCount <= 0) return 0;
  const cleanFraction = Math.min(1, Math.max(0, cleanFrameCount) / processedFrameCount);
  const processedFraction = analyzedFrameFraction(processedFrameCount, elapsedSeconds, framesPerSecond) ?? 1;
  return elapsedMinutes * cleanFraction * processedFraction;
}
