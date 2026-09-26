import { defineInstrument } from '@/core/instruments/types';

import { starSkyInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { starSkySchema, type StarSkyMeasurementValues } from './schema';
import { StarSkyScreen } from './Screen';

export const starSkyInstrument = defineInstrument<StarSkyMeasurementValues>({
  id: starSkyInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '✶', accentColor: '#1E3A8A' },
  category: 'optics',
  requiredSensors: ['camera'],
  optionalSensors: ['location'],
  Screen: StarSkyScreen,
  dataSchema: starSkySchema,
  translations: { es, eu },
});
