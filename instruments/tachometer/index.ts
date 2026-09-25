import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { tachometerSchema, type TachometerMeasurementValues } from './schema';
import { tachometerInstrumentId, TachometerScreen } from './Screen';

export const tachometerInstrument = defineInstrument<TachometerMeasurementValues>({
  id: tachometerInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⟳', accentColor: '#0E7490' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: TachometerScreen,
  dataSchema: tachometerSchema,
  translations: { es, eu },
});
