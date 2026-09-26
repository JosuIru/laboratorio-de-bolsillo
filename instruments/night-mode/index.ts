import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { nightModeSchema, type NightModeMeasurementValues } from './schema';
import { nightModeInstrumentId, NightModeScreen } from './Screen';

export const nightModeInstrument = defineInstrument<NightModeMeasurementValues>({
  id: nightModeInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '☾', accentColor: '#4338CA' },
  category: 'optics',
  requiredSensors: ['camera'],
  optionalSensors: ['gyroscope'],
  Screen: NightModeScreen,
  dataSchema: nightModeSchema,
  translations: { es, eu },
});
