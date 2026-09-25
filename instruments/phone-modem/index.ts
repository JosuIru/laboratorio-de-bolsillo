import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { phoneModemInstrumentId } from './modemConfiguration';
import { phoneModemSchema, type PhoneModemMeasurementValues } from './schema';
import { PhoneModemScreen } from './Screen';

export const phoneModemInstrument = defineInstrument<PhoneModemMeasurementValues>({
  id: phoneModemInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '✉', accentColor: '#7C3AED' },
  category: 'multi',
  // Enviar por la pantalla no necesita nada; el micrófono y la cámara se piden al usarlos.
  requiredSensors: ['speaker'],
  optionalSensors: ['microphone', 'camera'],
  Screen: PhoneModemScreen,
  dataSchema: phoneModemSchema,
  translations: { es, eu },
});
