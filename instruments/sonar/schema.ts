import { defineMeasurementSchema } from '@/core/measurements/schema';

/** Distancia al eco más fuerte, con lo necesario para repetir o revisar la medida. */
export interface SonarMeasurementValues {
  distanceMeters: number;
  echoDelayMilliseconds: number;
  temperatureCelsius: number;
  speedOfSoundMetersPerSecond: number;
  /** Nivel del eco respecto al acoplamiento directo altavoz → micrófono. */
  relativeEchoLevelDecibels: number;
  /** Cuánto sobresale el eco del ruido del perfil (en dispersiones). */
  signalToNoiseRatio: number;
  bandLowFrequencyHz: number;
  bandHighFrequencyHz: number;
  sampleRateHz: number;
  averagedPulseCount: number;
  isBackgroundSubtracted: boolean;
  /** Perfil de ecos en dB, de 0 m a 3 m en columnas iguales. */
  echoProfileDecibels: number[];
}

export const sonarSchema = defineMeasurementSchema<SonarMeasurementValues>(1, [
  { key: 'distanceMeters', labelKey: 'fields.distance', type: 'number', unit: 'm' },
  { key: 'echoDelayMilliseconds', labelKey: 'fields.echoDelay', type: 'number', unit: 'ms' },
  { key: 'temperatureCelsius', labelKey: 'fields.temperature', type: 'number', unit: '°C' },
  { key: 'speedOfSoundMetersPerSecond', labelKey: 'fields.speedOfSound', type: 'number', unit: 'm/s' },
  { key: 'relativeEchoLevelDecibels', labelKey: 'fields.echoLevel', type: 'number', unit: 'dB' },
  { key: 'signalToNoiseRatio', labelKey: 'fields.signalToNoise', type: 'number' },
  { key: 'bandLowFrequencyHz', labelKey: 'fields.bandLow', type: 'number', unit: 'Hz' },
  { key: 'bandHighFrequencyHz', labelKey: 'fields.bandHigh', type: 'number', unit: 'Hz' },
  { key: 'sampleRateHz', labelKey: 'fields.sampleRate', type: 'number', unit: 'Hz' },
  { key: 'averagedPulseCount', labelKey: 'fields.averagedPulses', type: 'number' },
  { key: 'isBackgroundSubtracted', labelKey: 'fields.backgroundSubtracted', type: 'boolean' },
  { key: 'echoProfileDecibels', labelKey: 'fields.echoProfile', type: 'numberArray', unit: 'dB' },
]);
