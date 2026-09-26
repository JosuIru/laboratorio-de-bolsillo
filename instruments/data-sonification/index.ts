import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { dataSonificationSchema, type DataSonificationMeasurementValues } from './schema';
import { dataSonificationInstrumentId, DataSonificationScreen } from './Screen';

export const dataSonificationInstrument = defineInstrument<DataSonificationMeasurementValues>({
  id: dataSonificationInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '♪', accentColor: '#0891B2' },
  category: 'multi',
  requiredSensors: ['accelerometer'],
  optionalSensors: ['gyroscope', 'magnetometer', 'light'],
  Screen: DataSonificationScreen,
  dataSchema: dataSonificationSchema,
  translations: { es, eu },
});
