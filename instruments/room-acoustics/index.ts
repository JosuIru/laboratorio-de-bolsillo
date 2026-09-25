import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { roomAcousticsSchema, type RoomAcousticsMeasurementValues } from './schema';
import { roomAcousticsInstrumentId, RoomAcousticsScreen } from './Screen';

export const roomAcousticsInstrument = defineInstrument<RoomAcousticsMeasurementValues>({
  id: roomAcousticsInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◫', accentColor: '#6D28D9' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: RoomAcousticsScreen,
  dataSchema: roomAcousticsSchema,
  translations: { es, eu },
});
