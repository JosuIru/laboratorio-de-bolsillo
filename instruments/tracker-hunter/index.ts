import { defineInstrument } from '@/core/instruments/types';

import { trackerHunterInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { trackerHunterSchema, type TrackerHunterMeasurementValues } from './schema';
import { TrackerHunterScreen } from './Screen';

export const trackerHunterInstrument = defineInstrument<TrackerHunterMeasurementValues>({
  id: trackerHunterInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⌬', accentColor: '#7C3AED' },
  category: 'electromagnetism',
  // El núcleo aún no tiene un tipo de sensor «bluetooth»: la pantalla comprueba el Bluetooth y
  // su permiso por su cuenta. El altavoz (siempre disponible) es para los pitidos del modo buscar.
  requiredSensors: ['bluetooth'],
  optionalSensors: ['speaker'],
  Screen: TrackerHunterScreen,
  dataSchema: trackerHunterSchema,
  translations: { es, eu },
});
