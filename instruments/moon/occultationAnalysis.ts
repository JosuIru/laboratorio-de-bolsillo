/**
 * Experimento «Ocultación»: curva de luz de una estrella junto al limbo, grabada con los
 * fotogramas del vídeo, y el instante en que la Luna la tapa o la destapa.
 * Lógica pura, sin React ni React Native.
 *
 * Tiempos:
 *  - Cada fotograma trae la marca del sensor (nanosegundos, reloj monótono): da los intervalos
 *    entre fotogramas con precisión de microsegundos, pero su origen no es la hora UTC.
 *  - Al recibir cada fotograma se anota también la hora del reloj del móvil. La diferencia
 *    reloj − sensor es la latencia (exposición → entrega) más una constante; la MÍNIMA de toda la
 *    grabación es el fotograma que llegó con menos retraso y es la mejor ancla. Queda un retraso
 *    sistemático de unas decenas de milisegundos que no se puede medir aquí.
 *  - El reloj del móvil puede ir desfasado respecto a UTC: `estimateClockOffsetFromHttpDate`
 *    lo estima con la cabecera Date de un servidor (resolución de ~0,5 s).
 */
import {
  fitOccultationTiming,
  type LightCurveSample,
  measureApertureFlux,
  type OccultationTiming,
} from '@/processing/image/occultationTiming';
import type { GrayImage } from '@/processing/image/grayImage';

export interface StarFrame {
  /** Luminancia de 8 bits, `side`², centrada donde se tocó la estrella. */
  grayPixels: Uint8Array;
  side: number;
  /** Marca de tiempo del sensor, en nanosegundos. */
  sensorTimestampNanoseconds: number;
  /** Hora del reloj del móvil al recibir el fotograma, en milisegundos (Date.now()). */
  wallClockMilliseconds: number;
}

export interface OccultationAnalysis {
  samples: LightCurveSample[];
  timing: OccultationTiming | null;
  /** Hora (reloj del móvil) del instante t = 0 de las muestras. */
  timeOriginWallClockMilliseconds: number;
  /** Instante del evento en el reloj del móvil (sin corregir su desfase), o null. */
  eventWallClockMilliseconds: number | null;
  /** Mediana menos mínima de la latencia: cuánto varía la entrega de fotogramas. */
  deliveryJitterMilliseconds: number;
  framesPerSecond: number;
  /** Centro de la apertura dentro del recorte. */
  starCenter: { x: number; y: number };
}

/** Radio de la apertura por defecto y búsqueda del centroide de la estrella (px del fotograma). */
export const defaultApertureRadiusPixels = 3;
const centroidSearchRadiusPixels = 6;

function grayImageFromFrame(starFrame: StarFrame): GrayImage {
  const values = new Float32Array(starFrame.side * starFrame.side);
  for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) values[pixelIndex] = starFrame.grayPixels[pixelIndex]!;
  return { width: starFrame.side, height: starFrame.side, values };
}

/** Centroide de la estrella cerca del centro, en la media de los fotogramas más brillantes. */
function locateStarCentroid(frames: readonly StarFrame[]): { x: number; y: number } {
  const side = frames[0]!.side;
  const center = (side - 1) / 2;
  const meanValues = new Float32Array(side * side);
  for (const starFrame of frames) {
    for (let pixelIndex = 0; pixelIndex < meanValues.length; pixelIndex++) meanValues[pixelIndex] = meanValues[pixelIndex]! + starFrame.grayPixels[pixelIndex]!;
  }
  const sortedValues = Array.from(meanValues).sort((first, second) => first - second);
  const backgroundLevel = sortedValues[Math.floor(sortedValues.length / 2)]!;
  let weightSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let rowIndex = 0; rowIndex < side; rowIndex++) {
    for (let columnIndex = 0; columnIndex < side; columnIndex++) {
      if (Math.hypot(columnIndex - center, rowIndex - center) > centroidSearchRadiusPixels) continue;
      const weight = Math.max(0, meanValues[rowIndex * side + columnIndex]! - backgroundLevel);
      weightSum += weight;
      weightedX += weight * columnIndex;
      weightedY += weight * rowIndex;
    }
  }
  return weightSum > 0 ? { x: weightedX / weightSum, y: weightedY / weightSum } : { x: center, y: center };
}

/**
 * Factor que pasa las marcas del sensor a nanosegundos. Android las da en nanosegundos; por si
 * otra plataforma las diera en otra unidad, se deduce del intervalo típico entre fotogramas
 * (a 1-240 fotogramas por segundo).
 */
export function sensorTimestampScaleToNanoseconds(sortedTimestamps: readonly number[]): number {
  const intervals = sortedTimestamps.slice(1).map((timestamp, intervalIndex) => timestamp - sortedTimestamps[intervalIndex]!);
  if (intervals.length === 0) return 1;
  intervals.sort((first, second) => first - second);
  const medianInterval = intervals[Math.floor(intervals.length / 2)]!;
  if (medianInterval >= 1e5) return 1;
  if (medianInterval >= 100) return 1e3;
  if (medianInterval >= 0.1) return 1e6;
  return 1e9;
}

/** Curva de luz y ajuste del instante. `exposureSeconds`: duración de cada fotograma (si se conoce). */
export function analyzeOccultationRecording(
  frames: readonly StarFrame[],
  options: { apertureRadiusPixels?: number; exposureSeconds?: number } = {},
): OccultationAnalysis | null {
  if (frames.length < 6) return null;
  const timestampOrderedFrames = [...frames].sort((first, second) => first.sensorTimestampNanoseconds - second.sensorTimestampNanoseconds);
  const timestampScale = sensorTimestampScaleToNanoseconds(timestampOrderedFrames.map((starFrame) => starFrame.sensorTimestampNanoseconds));
  const sortedFrames = timestampOrderedFrames.map((starFrame) => ({
    ...starFrame,
    sensorTimestampNanoseconds: starFrame.sensorTimestampNanoseconds * timestampScale,
  }));
  const apertureRadiusPixels = options.apertureRadiusPixels ?? defaultApertureRadiusPixels;
  const firstTimestamp = sortedFrames[0]!.sensorTimestampNanoseconds;
  const starCenter = locateStarCentroid(sortedFrames);
  const skyOuterRadius = Math.min((sortedFrames[0]!.side - 1) / 2, apertureRadiusPixels * 4);
  const samples: LightCurveSample[] = sortedFrames.map((starFrame) => {
    const apertureFlux = measureApertureFlux(
      grayImageFromFrame(starFrame),
      starCenter.x,
      starCenter.y,
      apertureRadiusPixels,
      apertureRadiusPixels * 2,
      skyOuterRadius,
    );
    return {
      timeSeconds: (starFrame.sensorTimestampNanoseconds - firstTimestamp) / 1e9,
      flux: apertureFlux.flux,
      fluxUncertainty: apertureFlux.fluxUncertainty > 0 ? apertureFlux.fluxUncertainty : undefined,
    };
  });
  const deliveryOffsets = sortedFrames.map((starFrame) => starFrame.wallClockMilliseconds - starFrame.sensorTimestampNanoseconds / 1e6);
  const sortedOffsets = [...deliveryOffsets].sort((first, second) => first - second);
  const minimumOffset = sortedOffsets[0]!;
  const medianOffset = sortedOffsets[Math.floor(sortedOffsets.length / 2)]!;
  const timeOriginWallClockMilliseconds = firstTimestamp / 1e6 + minimumOffset;
  const timing = fitOccultationTiming(samples, { model: 'step', eventType: 'auto', exposureSeconds: options.exposureSeconds ?? 0 });
  const durationSeconds = samples[samples.length - 1]!.timeSeconds;
  return {
    samples,
    timing,
    timeOriginWallClockMilliseconds,
    eventWallClockMilliseconds: timing ? timeOriginWallClockMilliseconds + timing.eventTimeSeconds * 1000 : null,
    deliveryJitterMilliseconds: medianOffset - minimumOffset,
    framesPerSecond: durationSeconds > 0 ? (samples.length - 1) / durationSeconds : 0,
    starCenter,
  };
}

export interface ClockOffsetEstimate {
  /** Hora del servidor menos la del móvil (positivo: el móvil va retrasado). */
  offsetMilliseconds: number;
  uncertaintyMilliseconds: number;
}

/**
 * Desfase del reloj del móvil a partir de la cabecera HTTP `Date` (resolución de 1 s: se toma la
 * mitad del segundo) y de la hora de envío y de llegada de la respuesta. `null` si no se entiende.
 */
export function estimateClockOffsetFromHttpDate(
  requestStartMilliseconds: number,
  responseEndMilliseconds: number,
  dateHeader: string | null,
): ClockOffsetEstimate | null {
  if (!dateHeader) return null;
  const serverSecondStart = Date.parse(dateHeader);
  if (!Number.isFinite(serverSecondStart)) return null;
  const roundTripMilliseconds = Math.max(0, responseEndMilliseconds - requestStartMilliseconds);
  return {
    offsetMilliseconds: serverSecondStart + 500 - (requestStartMilliseconds + responseEndMilliseconds) / 2,
    uncertaintyMilliseconds: 500 + roundTripMilliseconds / 2,
  };
}

/** «2026-09-26 21:34:05.123 UTC». */
export function formatUtcWithMilliseconds(timeMilliseconds: number): string {
  return `${new Date(Math.round(timeMilliseconds)).toISOString().replace('T', ' ').replace('Z', '')} UTC`;
}
