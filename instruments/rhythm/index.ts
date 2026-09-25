import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { rhythmSchema, type RhythmMeasurementValues } from './schema';
import { rhythmInstrumentId, RhythmScreen } from './Screen';

export const rhythmInstrument = defineInstrument<RhythmMeasurementValues>({
  id: rhythmInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '♩', accentColor: '#A16207' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: RhythmScreen,
  dataSchema: rhythmSchema,
  translations: { es, eu },
});
