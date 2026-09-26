import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface MuonDetectorMeasurementValues {
  durationMinutes: number;
  /** Minutos de observación útil (fotogramas limpios analizados); las tasas se calculan con este. */
  liveMinutes?: number;
  /** Fotogramas analizados sin luz ni fogonazos de ruido. */
  analyzedFrameCount: number;
  /** Fracción aproximada de los fotogramas de la cámara que se llegaron a analizar. */
  analyzedFramePercent?: number;
  frameWidthPixels: number;
  frameHeightPixels: number;
  eventCount: number;
  spotCount: number;
  wormCount: number;
  trackCount: number;
  eventsPerMinute: number;
  /** Incertidumbre de Poisson √N / T. */
  eventsPerMinuteUncertainty: number;
  /** Intervalo exacto (Garwood) al 68 %. */
  eventsPerMinuteLower: number;
  eventsPerMinuteUpper: number;
  tracksPerMinute: number;
  tracksPerMinuteUncertainty: number;
  calibrationHotPixelCount: number;
  /** Píxeles que se volvieron calientes durante la medición (el sensor se calienta). */
  addedHotPixelCount: number;
  discardedHotEventCount: number;
  initialThresholdOffset: number;
  finalThresholdOffset: number;
  meanDarkLevel: number;
  lightLeakFrameCount: number;
  noisyFrameCount: number;
}

export const muonDetectorSchema = defineMeasurementSchema<MuonDetectorMeasurementValues>(1, [
  { key: 'durationMinutes', labelKey: 'fields.duration', type: 'number', unit: 'min' },
  { key: 'liveMinutes', labelKey: 'fields.liveTime', type: 'number', unit: 'min', optional: true },
  { key: 'analyzedFrameCount', labelKey: 'fields.analyzedFrames', type: 'number' },
  { key: 'analyzedFramePercent', labelKey: 'fields.analyzedFramePercent', type: 'number', unit: '%', optional: true },
  { key: 'frameWidthPixels', labelKey: 'fields.frameWidth', type: 'number', unit: 'px' },
  { key: 'frameHeightPixels', labelKey: 'fields.frameHeight', type: 'number', unit: 'px' },
  { key: 'eventCount', labelKey: 'fields.eventCount', type: 'number' },
  { key: 'spotCount', labelKey: 'fields.spotCount', type: 'number' },
  { key: 'wormCount', labelKey: 'fields.wormCount', type: 'number' },
  { key: 'trackCount', labelKey: 'fields.trackCount', type: 'number' },
  { key: 'eventsPerMinute', labelKey: 'fields.eventsPerMinute', type: 'number', unit: '1/min' },
  { key: 'eventsPerMinuteUncertainty', labelKey: 'fields.eventsPerMinuteUncertainty', type: 'number', unit: '1/min' },
  { key: 'eventsPerMinuteLower', labelKey: 'fields.eventsPerMinuteLower', type: 'number', unit: '1/min' },
  { key: 'eventsPerMinuteUpper', labelKey: 'fields.eventsPerMinuteUpper', type: 'number', unit: '1/min' },
  { key: 'tracksPerMinute', labelKey: 'fields.tracksPerMinute', type: 'number', unit: '1/min' },
  { key: 'tracksPerMinuteUncertainty', labelKey: 'fields.tracksPerMinuteUncertainty', type: 'number', unit: '1/min' },
  { key: 'calibrationHotPixelCount', labelKey: 'fields.calibrationHotPixels', type: 'number' },
  { key: 'addedHotPixelCount', labelKey: 'fields.addedHotPixels', type: 'number' },
  { key: 'discardedHotEventCount', labelKey: 'fields.discardedHotEvents', type: 'number' },
  { key: 'initialThresholdOffset', labelKey: 'fields.initialThreshold', type: 'number' },
  { key: 'finalThresholdOffset', labelKey: 'fields.finalThreshold', type: 'number' },
  { key: 'meanDarkLevel', labelKey: 'fields.meanDarkLevel', type: 'number' },
  { key: 'lightLeakFrameCount', labelKey: 'fields.lightLeakFrames', type: 'number' },
  { key: 'noisyFrameCount', labelKey: 'fields.noisyFrames', type: 'number' },
]);
