import { defineInstrument } from '@/core/instruments/types';

import { type ResonanceScaleCalibrationParameters, validateResonanceScaleCalibration } from './calibration';
import { ResonanceScaleCalibrationScreen } from './CalibrationScreen';
import { resonanceScaleInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { resonanceScaleSchema, type ResonanceScaleMeasurementValues } from './schema';
import { ResonanceScaleScreen } from './Screen';

export const resonanceScaleInstrument = defineInstrument<
  ResonanceScaleMeasurementValues,
  ResonanceScaleCalibrationParameters
>({
  id: resonanceScaleInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⚖', accentColor: '#B45309' },
  category: 'mechanics',
  requiredSensors: ['accelerometer'],
  Screen: ResonanceScaleScreen,
  dataSchema: resonanceScaleSchema,
  // Sin valores por defecto: la respuesta depende del móvil y, sobre todo, de la superficie.
  calibration: {
    parametersSchemaVersion: 1,
    CalibrationScreen: ResonanceScaleCalibrationScreen,
    validateParameters: validateResonanceScaleCalibration,
  },
  translations: { es, eu },
});
