import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { stepMusicSchema, type StepMusicMeasurementValues } from './schema';
import { stepMusicInstrumentId, StepMusicScreen } from './Screen';

export const stepMusicInstrument = defineInstrument<StepMusicMeasurementValues>({
  id: stepMusicInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⚘', accentColor: '#EA580C' },
  category: 'multi',
  requiredSensors: ['accelerometer'],
  Screen: StepMusicScreen,
  dataSchema: stepMusicSchema,
  translations: { es, eu },
});
