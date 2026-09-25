import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { seismicNetworkSchema, type SeismicNetworkMeasurementValues } from './schema';
import { seismicNetworkInstrumentId, SeismicNetworkScreen } from './Screen';

export const seismicNetworkInstrument = defineInstrument<SeismicNetworkMeasurementValues>({
  id: seismicNetworkInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◎', accentColor: '#B45309' },
  category: 'mechanics',
  requiredSensors: ['accelerometer'],
  Screen: SeismicNetworkScreen,
  dataSchema: seismicNetworkSchema,
  translations: { es, eu },
});
