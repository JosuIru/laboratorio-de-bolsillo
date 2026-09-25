import { defineInstrument } from '@/core/instruments/types';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { singTheNoteSchema, type SingTheNoteMeasurementValues } from './schema';
import { singTheNoteInstrumentId, SingTheNoteScreen } from './Screen';

export const singTheNoteInstrument = defineInstrument<SingTheNoteMeasurementValues>({
  id: singTheNoteInstrumentId,
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '♬', accentColor: '#DB2777' },
  category: 'acoustics',
  requiredSensors: ['microphone'],
  Screen: SingTheNoteScreen,
  dataSchema: singTheNoteSchema,
  translations: { es, eu },
});
