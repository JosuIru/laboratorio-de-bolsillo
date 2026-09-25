import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { seismographSchema, type SeismographMeasurementValues } from './schema';
import { seismographInstrumentId, SeismographScreen } from './Screen';

export const seismographInstrument = defineInstrument<SeismographMeasurementValues>({
  id: seismographInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '∿', accentColor: '#C2410C' },
  category: 'mechanics',
  requiredSensors: ['accelerometer'],
  Screen: SeismographScreen,
  dataSchema: seismographSchema,
  translations: { es, eu },
});
