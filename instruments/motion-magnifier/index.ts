import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { motionMagnifierSchema, type MotionMagnifierMeasurementValues } from './schema';
import { motionMagnifierInstrumentId, MotionMagnifierScreen } from './Screen';

export const motionMagnifierInstrument = defineInstrument<MotionMagnifierMeasurementValues>({
  id: motionMagnifierInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '≋', accentColor: '#DB2777' },
  category: 'optics',
  requiredSensors: ['camera'],
  optionalSensors: ['gyroscope'],
  Screen: MotionMagnifierScreen,
  dataSchema: motionMagnifierSchema,
  translations: { es, eu },
});
