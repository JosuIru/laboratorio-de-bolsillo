import { defineInstrument } from '@/core/instruments/types';

import { moonInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { moonSchema, type MoonMeasurementValues } from './schema';
import { MoonScreen } from './Screen';

export const moonInstrument = defineInstrument<MoonMeasurementValues>({
  id: moonInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '☾', accentColor: '#4338CA' },
  category: 'optics',
  requiredSensors: ['camera'],
  optionalSensors: ['location'],
  Screen: MoonScreen,
  dataSchema: moonSchema,
  translations: { es, eu },
});
