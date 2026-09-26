import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { focusStackSchema, type FocusStackMeasurementValues } from './schema';
import { focusStackInstrumentId, FocusStackScreen } from './Screen';

export const focusStackInstrument = defineInstrument<FocusStackMeasurementValues>({
  id: focusStackInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◎', accentColor: '#0EA5E9' },
  category: 'optics',
  requiredSensors: ['camera'],
  Screen: FocusStackScreen,
  dataSchema: focusStackSchema,
  translations: { es, eu },
});
