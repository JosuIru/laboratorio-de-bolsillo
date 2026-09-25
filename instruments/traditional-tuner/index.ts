import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { traditionalTunerSchema, type TraditionalTunerMeasurementValues } from './schema';
import { traditionalTunerInstrumentId, TraditionalTunerScreen } from './Screen';

export const traditionalTunerInstrument = defineInstrument<TraditionalTunerMeasurementValues>({
  id: traditionalTunerInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '♮', accentColor: '#15803D' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: TraditionalTunerScreen,
  dataSchema: traditionalTunerSchema,
  translations: { es, eu },
});
