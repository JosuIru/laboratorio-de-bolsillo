import type { AnyInstrumentDefinition } from '@/core/instruments/types';

import { exampleLevelInstrument } from './example-level';
import { seismographInstrument } from './seismograph';

/**
 * Registro de instrumentos. Para añadir uno: crea su carpeta en /instruments y añade
 * aquí una línea. El orden de esta lista es el orden en la pantalla de inicio.
 */
export const instrumentRegistry: readonly AnyInstrumentDefinition[] = [
  seismographInstrument,
  exampleLevelInstrument,
];
