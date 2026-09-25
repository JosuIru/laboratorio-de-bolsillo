import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { sonarSchema, type SonarMeasurementValues } from './schema';
import { SonarScreen } from './Screen';
import { sonarInstrumentId } from './sonarConfiguration';

export const sonarInstrument = defineInstrument<SonarMeasurementValues>({
  id: sonarInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◠', accentColor: '#0E7490' },
  category: 'acoustics',
  requiredSensors: ['speaker', 'microphone'],
  Screen: SonarScreen,
  dataSchema: sonarSchema,
  translations: { es, eu },
});
