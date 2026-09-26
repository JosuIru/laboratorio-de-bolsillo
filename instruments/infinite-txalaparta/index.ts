import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { infiniteTxalapartaSchema, type InfiniteTxalapartaMeasurementValues } from './schema';
import { infiniteTxalapartaInstrumentId, InfiniteTxalapartaScreen } from './Screen';

export const infiniteTxalapartaInstrument = defineInstrument<InfiniteTxalapartaMeasurementValues>({
  id: infiniteTxalapartaInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⫼', accentColor: '#92400E' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: InfiniteTxalapartaScreen,
  dataSchema: infiniteTxalapartaSchema,
  translations: { es, eu },
});
