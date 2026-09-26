import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { escapeLocksSchema, type EscapeLocksMeasurementValues } from './schema';
import { escapeLocksInstrumentId, EscapeLocksScreen } from './Screen';

export const escapeLocksInstrument = defineInstrument<EscapeLocksMeasurementValues>({
  id: escapeLocksInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⚿', accentColor: '#B91C1C' },
  category: 'multi',
  requiredSensors: ['accelerometer'],
  optionalSensors: ['microphone', 'magnetometer'],
  Screen: EscapeLocksScreen,
  dataSchema: escapeLocksSchema,
  translations: { es, eu },
});
