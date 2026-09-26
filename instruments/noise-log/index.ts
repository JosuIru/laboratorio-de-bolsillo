import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { noiseLogSchema, type NoiseLogMeasurementValues } from './schema';
import { noiseLogInstrumentId, NoiseLogScreen } from './Screen';

// Sin calibración propia: usa la de nivel del analizador de espectro (misma medida de dBFS).
export const noiseLogInstrument = defineInstrument<NoiseLogMeasurementValues>({
  id: noiseLogInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '☾', accentColor: '#4338CA' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: NoiseLogScreen,
  dataSchema: noiseLogSchema,
  translations: { es, eu },
});
