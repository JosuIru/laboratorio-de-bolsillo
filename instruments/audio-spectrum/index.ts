import { defineInstrument } from '@/core/instruments/types';

import { type SoundLevelCalibrationParameters, validateSoundLevelCalibration } from './calibration';
import { AudioSpectrumCalibrationScreen } from './CalibrationScreen';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { audioSpectrumSchema, type AudioSpectrumMeasurementValues } from './schema';
import { audioSpectrumInstrumentId, AudioSpectrumScreen } from './Screen';

export const audioSpectrumInstrument = defineInstrument<AudioSpectrumMeasurementValues, SoundLevelCalibrationParameters>({
  id: audioSpectrumInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '♫', accentColor: '#7A4FD1' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: AudioSpectrumScreen,
  dataSchema: audioSpectrumSchema,
  // Sin valores por defecto: sin calibrar, la app muestra dBFS en lugar de inventar dB SPL.
  calibration: {
    parametersSchemaVersion: 1,
    CalibrationScreen: AudioSpectrumCalibrationScreen,
    validateParameters: validateSoundLevelCalibration,
  },
  translations: { es, eu },
});
