import { defineInstrument } from '@/core/instruments/types';

import {
  defaultLevelCalibration,
  type LevelCalibrationParameters,
  validateLevelCalibration,
} from './calibration';
import { LevelCalibrationScreen } from './CalibrationScreen';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { levelMeasurementSchema, type LevelMeasurementValues } from './schema';
import { levelInstrumentId, LevelScreen } from './Screen';

/** Instrumento mínimo de referencia: ver CONTRIBUTING.md. Solo aparece en builds de desarrollo. */
export const exampleLevelInstrument = defineInstrument<LevelMeasurementValues, LevelCalibrationParameters>({
  id: levelInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◎', accentColor: '#1E7B34' },
  category: 'mechanics',
  requiredSensors: ['accelerometer'],
  Screen: LevelScreen,
  dataSchema: levelMeasurementSchema,
  calibration: {
    parametersSchemaVersion: 1,
    CalibrationScreen: LevelCalibrationScreen,
    defaultParameters: defaultLevelCalibration,
    validateParameters: validateLevelCalibration,
  },
  translations: { es, eu },
  isDevelopmentOnly: true,
});
