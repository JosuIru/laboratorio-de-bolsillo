import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface AudioSpectrumMeasurementValues {
  sampleRateHz: number;
  fftSize: number;
  levelDecibelsFullScale: number;
  /** Solo si hay calibración de nivel activa. */
  soundPressureLevelDecibels?: number;
  dominantFrequencyHz?: number;
  dominantToneDecibelsFullScale?: number;
  /** Espectro en dB por bin, de 0 Hz a Nyquist (resolución = sampleRateHz / fftSize). */
  spectrumDecibels: number[];
}

export const audioSpectrumSchema = defineMeasurementSchema<AudioSpectrumMeasurementValues>(1, [
  { key: 'dominantFrequencyHz', labelKey: 'fields.dominantFrequency', type: 'number', unit: 'Hz', optional: true },
  { key: 'levelDecibelsFullScale', labelKey: 'fields.level', type: 'number', unit: 'dBFS' },
  { key: 'soundPressureLevelDecibels', labelKey: 'fields.soundPressureLevel', type: 'number', unit: 'dB', optional: true },
  { key: 'dominantToneDecibelsFullScale', labelKey: 'fields.toneLevel', type: 'number', unit: 'dBFS', optional: true },
  { key: 'sampleRateHz', labelKey: 'fields.sampleRate', type: 'number', unit: 'Hz' },
  { key: 'fftSize', labelKey: 'fields.fftSize', type: 'number' },
  { key: 'spectrumDecibels', labelKey: 'fields.spectrum', type: 'numberArray', unit: 'dB' },
]);
