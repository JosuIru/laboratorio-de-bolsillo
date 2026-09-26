import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { earTrainerSchema, type EarTrainerMeasurementValues } from './schema';
import { earTrainerInstrumentId, EarTrainerScreen } from './Screen';

export const earTrainerInstrument = defineInstrument<EarTrainerMeasurementValues>({
  id: earTrainerInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '𝄞', accentColor: '#7C3AED' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: EarTrainerScreen,
  dataSchema: earTrainerSchema,
  translations: { es, eu },
});
