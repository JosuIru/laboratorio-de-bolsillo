import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { propellerBalancerSchema, type PropellerBalancerMeasurementValues } from './schema';
import { propellerBalancerInstrumentId, PropellerBalancerScreen } from './Screen';

export const propellerBalancerInstrument = defineInstrument<PropellerBalancerMeasurementValues>({
  id: propellerBalancerInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '✢', accentColor: '#0369A1' },
  category: 'mechanics',
  requiredSensors: ['accelerometer'],
  Screen: PropellerBalancerScreen,
  dataSchema: propellerBalancerSchema,
  translations: { es, eu },
});
