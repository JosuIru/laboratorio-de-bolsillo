import type { AnyInstrumentDefinition } from '@/core/instruments/types';

import { audioSpectrumInstrument } from './audio-spectrum';
import { beerWineColorInstrument } from './beer-wine-color';
import { colorHuntInstrument } from './color-hunt';
import { colorimeterInstrument } from './colorimeter';
import { exampleLevelInstrument } from './example-level';
import { gnssSkyInstrument } from './gnss-sky';
import { machineDiagnosisInstrument } from './machine-diagnosis';
import { metalDetectorInstrument } from './metal-detector';
import { metronomeInstrument } from './metronome';
import { moonInstrument } from './moon';
import { motionMagnifierInstrument } from './motion-magnifier';
import { muonDetectorInstrument } from './muon-detector';
import { poolStripsInstrument } from './pool-strips';
import { resonanceScaleInstrument } from './resonance-scale';
import { rhythmInstrument } from './rhythm';
import { seismicNetworkInstrument } from './seismic-network';
import { seismographInstrument } from './seismograph';
import { sonarInstrument } from './sonar';
import { soundLocatorInstrument } from './sound-locator';
import { superzoomInstrument } from './superzoom';
import { traditionalTunerInstrument } from './traditional-tuner';
import { tachometerInstrument } from './tachometer';
import { trackerHunterInstrument } from './tracker-hunter';
import { wifiMapInstrument } from './wifi-map';

/**
 * Registro de instrumentos. Para añadir uno: crea su carpeta en /instruments y añade
 * aquí una línea. El orden de esta lista es el orden en la pantalla de inicio.
 */
export const instrumentRegistry: readonly AnyInstrumentDefinition[] = [
  audioSpectrumInstrument,
  seismographInstrument,
  seismicNetworkInstrument,
  tachometerInstrument,
  machineDiagnosisInstrument,
  metalDetectorInstrument,
  resonanceScaleInstrument,
  gnssSkyInstrument,
  sonarInstrument,
  soundLocatorInstrument,
  rhythmInstrument,
  colorHuntInstrument,
  metronomeInstrument,
  traditionalTunerInstrument,
  colorimeterInstrument,
  poolStripsInstrument,
  beerWineColorInstrument,
  moonInstrument,
  superzoomInstrument,
  motionMagnifierInstrument,
  trackerHunterInstrument,
  wifiMapInstrument,
  muonDetectorInstrument,
  exampleLevelInstrument,
];
