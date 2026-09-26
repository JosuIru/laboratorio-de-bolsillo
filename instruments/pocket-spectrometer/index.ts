import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { pocketSpectrometerSchema, type PocketSpectrometerMeasurementValues } from './schema';
import { pocketSpectrometerInstrumentId, PocketSpectrometerScreen } from './Screen';

export const pocketSpectrometerInstrument = defineInstrument<PocketSpectrometerMeasurementValues>({
  id: pocketSpectrometerInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '▦', accentColor: '#9333EA' },
  category: 'optics',
  requiredSensors: ['camera'],
  Screen: PocketSpectrometerScreen,
  dataSchema: pocketSpectrometerSchema,
  translations: { es, eu },
});
