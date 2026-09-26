import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { applianceCycleSchema, type ApplianceCycleMeasurementValues } from './schema';
import { applianceCycleInstrumentId, ApplianceCycleScreen } from './Screen';

export const applianceCycleInstrument = defineInstrument<ApplianceCycleMeasurementValues>({
  id: applianceCycleInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◴', accentColor: '#2563EB' },
  category: 'mechanics',
  requiredSensors: ['accelerometer'],
  Screen: ApplianceCycleScreen,
  dataSchema: applianceCycleSchema,
  translations: { es, eu },
});
