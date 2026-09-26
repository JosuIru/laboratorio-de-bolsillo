import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { rvLevelerInstrumentId } from './rvLevelerInstrumentId';
import { rvLevelerSchema, type RvLevelerMeasurementValues } from './schema';
import { RvLevelerScreen } from './Screen';

/** Nivelación de autocaravanas y caravanas: cuántos cm calzar cada rueda. */
export const rvLevelerInstrument = defineInstrument<RvLevelerMeasurementValues>({
  id: rvLevelerInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⊥', accentColor: '#0369A1' },
  category: 'mechanics',
  requiredSensors: ['accelerometer'],
  Screen: RvLevelerScreen,
  dataSchema: rvLevelerSchema,
  translations: { es, eu },
});
