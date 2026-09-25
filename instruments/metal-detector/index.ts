import { defineInstrument } from '@/core/instruments/types';

import { type MetalDetectorCalibrationParameters, validateMetalDetectorCalibration } from './calibration';
import { MetalDetectorCalibrationScreen } from './CalibrationScreen';
import { metalDetectorInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { metalDetectorSchema, type MetalDetectorMeasurementValues } from './schema';
import { MetalDetectorScreen } from './Screen';

export const metalDetectorInstrument = defineInstrument<MetalDetectorMeasurementValues, MetalDetectorCalibrationParameters>({
  id: metalDetectorInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⌖', accentColor: '#475569' },
  category: 'electromagnetism',
  requiredSensors: ['magnetometer'],
  Screen: MetalDetectorScreen,
  dataSchema: metalDetectorSchema,
  // Sin valores por defecto: sin calibrar se usa el campo bruto (la desviación funciona igual).
  calibration: {
    parametersSchemaVersion: 1,
    CalibrationScreen: MetalDetectorCalibrationScreen,
    validateParameters: validateMetalDetectorCalibration,
  },
  translations: { es, eu },
});
