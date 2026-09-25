import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { colorHuntSchema, type ColorHuntMeasurementValues } from './schema';
import { colorHuntInstrumentId, ColorHuntScreen } from './Screen';

export const colorHuntInstrument = defineInstrument<ColorHuntMeasurementValues>({
  id: colorHuntInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◎', accentColor: '#C2410C' },
  category: 'optics',
  requiredSensors: ['camera'],
  Screen: ColorHuntScreen,
  dataSchema: colorHuntSchema,
  translations: { es, eu },
});
