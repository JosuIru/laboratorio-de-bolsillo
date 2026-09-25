import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { metronomeSchema, type MetronomeMeasurementValues } from './schema';
import { metronomeInstrumentId, MetronomeScreen } from './Screen';

export const metronomeInstrument = defineInstrument<MetronomeMeasurementValues>({
  id: metronomeInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '♪', accentColor: '#0F766E' },
  category: 'acoustics',
  requiredSensors: ['speaker'],
  Screen: MetronomeScreen,
  dataSchema: metronomeSchema,
  translations: { es, eu },
});
