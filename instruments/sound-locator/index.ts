import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { soundLocatorInstrumentId } from './locatorConfiguration';
import { soundLocatorSchema, type SoundLocatorMeasurementValues } from './schema';
import { SoundLocatorScreen } from './Screen';

export const soundLocatorInstrument = defineInstrument<SoundLocatorMeasurementValues>({
  id: soundLocatorInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⌖', accentColor: '#B45309' },
  category: 'acoustics',
  requiredSensors: ['speaker', 'microphone'],
  Screen: SoundLocatorScreen,
  dataSchema: soundLocatorSchema,
  translations: { es, eu },
});
