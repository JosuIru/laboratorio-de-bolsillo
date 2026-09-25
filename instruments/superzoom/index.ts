import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { superzoomSchema, type SuperzoomMeasurementValues } from './schema';
import { superzoomInstrumentId, SuperzoomScreen } from './Screen';

export const superzoomInstrument = defineInstrument<SuperzoomMeasurementValues>({
  id: superzoomInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⊕', accentColor: '#9333EA' },
  category: 'optics',
  requiredSensors: ['camera'],
  optionalSensors: ['gyroscope'],
  Screen: SuperzoomScreen,
  dataSchema: superzoomSchema,
  translations: { es, eu },
});
