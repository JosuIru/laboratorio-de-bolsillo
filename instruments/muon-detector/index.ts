import { defineInstrument } from '@/core/instruments/types';

import { muonDetectorInstrumentId } from './instrumentId';
import es from './locales/es.json';
import eu from './locales/eu.json';
import { type MuonDetectorMeasurementValues, muonDetectorSchema } from './schema';
import { MuonDetectorScreen } from './Screen';

export const muonDetectorInstrument = defineInstrument<MuonDetectorMeasurementValues>({
  id: muonDetectorInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '✳', accentColor: '#0F766E' },
  category: 'multi',
  requiredSensors: ['camera'],
  Screen: MuonDetectorScreen,
  dataSchema: muonDetectorSchema,
  translations: { es, eu },
});
