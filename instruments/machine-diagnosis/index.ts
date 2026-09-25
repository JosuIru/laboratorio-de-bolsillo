import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { machineDiagnosisSchema, type MachineDiagnosisMeasurementValues } from './schema';
import { machineDiagnosisInstrumentId, MachineDiagnosisScreen } from './Screen';

export const machineDiagnosisInstrument = defineInstrument<MachineDiagnosisMeasurementValues>({
  id: machineDiagnosisInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '⚙', accentColor: '#4D7C0F' },
  category: 'multi',
  requiredSensors: ['microphone', 'accelerometer'],
  Screen: MachineDiagnosisScreen,
  dataSchema: machineDiagnosisSchema,
  translations: { es, eu },
});
