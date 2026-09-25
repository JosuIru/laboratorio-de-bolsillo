import { defineInstrument } from '@/core/instruments/types';

import { ColorimeterCalibrationScreen } from './CalibrationScreen';
import es from './locales/es.json';
import eu from './locales/eu.json';
import {
  type ColorimeterCalibrationParameters,
  defaultReferenceCard,
  validateColorimeterCalibration,
} from './referenceCards';
import { colorimeterInstrumentId } from './ScaleEditor';
import { colorimeterSchema, type ColorimeterMeasurementValues } from './schema';
import { ColorimeterScreen } from './Screen';

export const colorimeterInstrument = defineInstrument<ColorimeterMeasurementValues, ColorimeterCalibrationParameters>({
  id: colorimeterInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◐', accentColor: '#0E7490' },
  category: 'optics',
  requiredSensors: ['camera'],
  Screen: ColorimeterScreen,
  dataSchema: colorimeterSchema,
  calibration: {
    parametersSchemaVersion: 1,
    CalibrationScreen: ColorimeterCalibrationScreen,
    defaultParameters: { card: defaultReferenceCard },
    validateParameters: validateColorimeterCalibration,
  },
  translations: { es, eu },
});
