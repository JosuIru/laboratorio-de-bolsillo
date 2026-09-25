import type { AnyInstrumentDefinition } from '@/core/instruments/types';

import { audioSpectrumInstrument } from './audio-spectrum';
import { colorHuntInstrument } from './color-hunt';
import { colorimeterInstrument } from './colorimeter';
import { exampleLevelInstrument } from './example-level';
import { machineDiagnosisInstrument } from './machine-diagnosis';
import { metalDetectorInstrument } from './metal-detector';
import { metronomeInstrument } from './metronome';
import { moonInstrument } from './moon';
import { poolStripsInstrument } from './pool-strips';
import { rhythmInstrument } from './rhythm';
import { seismographInstrument } from './seismograph';
import { tachometerInstrument } from './tachometer';

/**
 * Registro de instrumentos. Para añadir uno: crea su carpeta en /instruments y añade
 * aquí una línea. El orden de esta lista es el orden en la pantalla de inicio.
 */
export const instrumentRegistry: readonly AnyInstrumentDefinition[] = [
  audioSpectrumInstrument,
  seismographInstrument,
  tachometerInstrument,
  machineDiagnosisInstrument,
  metalDetectorInstrument,
  rhythmInstrument,
  colorHuntInstrument,
  metronomeInstrument,
  colorimeterInstrument,
  poolStripsInstrument,
  moonInstrument,
  exampleLevelInstrument,
];
