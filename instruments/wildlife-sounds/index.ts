import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { wildlifeSoundsSchema, type WildlifeSoundsMeasurementValues } from './schema';
import { wildlifeSoundsInstrumentId, WildlifeSoundsScreen } from './Screen';

// El modelo (Perch 2.0 recortado a Europa, ≈37 MB) se descarga la primera vez: ver modelStore.ts
// y scripts/fauna-model/README.md.
export const wildlifeSoundsInstrument = defineInstrument<WildlifeSoundsMeasurementValues>({
  id: wildlifeSoundsInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '🐦', accentColor: '#2F7D32' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  optionalSensors: ['location'],
  Screen: WildlifeSoundsScreen,
  dataSchema: wildlifeSoundsSchema,
  translations: { es, eu },
});
