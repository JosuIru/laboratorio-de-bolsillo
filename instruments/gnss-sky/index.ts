import { defineInstrument } from '@/core/instruments/types';

import { gnssSkyInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { gnssSkySchema, type GnssSkyMeasurementValues } from './schema';
import { GnssSkyScreen } from './Screen';

/**
 * Cielo GNSS: satélites en crudo (constelación, banda, C/N0, posición en el cielo) y detector de
 * interferencias. Solo Android (módulo nativo local `modules/gnss-raw`); en iOS la pantalla
 * explica que no está disponible.
 */
export const gnssSkyInstrument = defineInstrument<GnssSkyMeasurementValues>({
  id: gnssSkyInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '🛰', accentColor: '#0F766E' },
  category: 'electromagnetism',
  requiredSensors: ['location'],
  Screen: GnssSkyScreen,
  dataSchema: gnssSkySchema,
  translations: { es, eu },
});
