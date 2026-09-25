import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { beerWineColorSchema, type BeerWineColorMeasurementValues } from './schema';
import { beerWineColorInstrumentId, BeerWineColorScreen } from './Screen';

export const beerWineColorInstrument = defineInstrument<BeerWineColorMeasurementValues>({
  id: beerWineColorInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⛉', accentColor: '#B45309' },
  category: 'optics',
  requiredSensors: ['camera'],
  Screen: BeerWineColorScreen,
  dataSchema: beerWineColorSchema,
  translations: { es, eu },
});
