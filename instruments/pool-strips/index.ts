import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { poolStripsSchema, type PoolStripsMeasurementValues } from './schema';
import { PoolStripsScreen } from './Screen';
import { poolStripsInstrumentId } from './stripPresets';

export const poolStripsInstrument = defineInstrument<PoolStripsMeasurementValues>({
  id: poolStripsInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '▥', accentColor: '#0284C7' },
  category: 'optics',
  requiredSensors: ['camera'],
  Screen: PoolStripsScreen,
  dataSchema: poolStripsSchema,
  translations: { es, eu },
});
