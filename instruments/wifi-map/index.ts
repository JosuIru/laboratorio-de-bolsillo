import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { wifiMapSchema, type WifiMapMeasurementValues } from './schema';
import { WifiMapScreen } from './Screen';
import { wifiMapInstrumentId } from './wifiMapConfiguration';

export const wifiMapInstrument = defineInstrument<WifiMapMeasurementValues>({
  id: wifiMapInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '◉', accentColor: '#15803D' },
  category: 'electromagnetism',
  // No hay un tipo de sensor «wifi» en el núcleo: se exige la ubicación, que Android pide para
  // ver el nombre de la red y las redes vecinas. El RSSI se lee aunque se deniegue.
  requiredSensors: ['location'],
  Screen: WifiMapScreen,
  dataSchema: wifiMapSchema,
  translations: { es, eu },
});
