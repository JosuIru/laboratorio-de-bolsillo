import { defineInstrument } from '@/core/instruments/types';

import { mainsFrequencyInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { mainsFrequencySchema, type MainsFrequencyMeasurementValues } from './schema';
import { MainsFrequencyScreen } from './Screen';

export const mainsFrequencyInstrument = defineInstrument<MainsFrequencyMeasurementValues>({
  id: mainsFrequencyInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⌁', accentColor: '#CA8A04' },
  category: 'electromagnetism',
  requiredSensors: ['camera'],
  Screen: MainsFrequencyScreen,
  dataSchema: mainsFrequencySchema,
  translations: { es, eu },
});
