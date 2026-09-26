import type { AnyInstrumentDefinition, InstrumentSection } from '@/core/instruments/types';

import { applianceCycleInstrument } from './appliance-cycle';
import { audioSpectrumInstrument } from './audio-spectrum';
import { beerWineColorInstrument } from './beer-wine-color';
import { colorHuntInstrument } from './color-hunt';
import { colorimeterInstrument } from './colorimeter';
import { dataSonificationInstrument } from './data-sonification';
import { earTrainerInstrument } from './ear-trainer';
import { escapeLocksInstrument } from './escape-locks';
import { exampleLevelInstrument } from './example-level';
import { gnssSkyInstrument } from './gnss-sky';
import { infiniteTxalapartaInstrument } from './infinite-txalaparta';
import { machineDiagnosisInstrument } from './machine-diagnosis';
import { mainsFrequencyInstrument } from './mains-frequency';
import { metalDetectorInstrument } from './metal-detector';
import { metronomeInstrument } from './metronome';
import { moonInstrument } from './moon';
import { motionMagnifierInstrument } from './motion-magnifier';
import { muonDetectorInstrument } from './muon-detector';
import { phoneModemInstrument } from './phone-modem';
import { pocketSpectrometerInstrument } from './pocket-spectrometer';
import { poolStripsInstrument } from './pool-strips';
import { propellerBalancerInstrument } from './propeller-balancer';
import { resonanceScaleInstrument } from './resonance-scale';
import { rhythmInstrument } from './rhythm';
import { roomAcousticsInstrument } from './room-acoustics';
import { seismicNetworkInstrument } from './seismic-network';
import { seismographInstrument } from './seismograph';
import { sonarInstrument } from './sonar';
import { singTheNoteInstrument } from './sing-the-note';
import { soundLocatorInstrument } from './sound-locator';
import { stepMusicInstrument } from './step-music';
import { superzoomInstrument } from './superzoom';
import { traditionalTunerInstrument } from './traditional-tuner';
import { tachometerInstrument } from './tachometer';
import { trackerHunterInstrument } from './tracker-hunter';
import { wifiMapInstrument } from './wifi-map';

/**
 * Registro de instrumentos, agrupados por para qué sirven. Para añadir uno: crea su carpeta en
 * /instruments y añade aquí una línea en su sección. El orden de las secciones y de cada lista
 * es el de la pantalla de inicio.
 */
export const instrumentSections: readonly InstrumentSection[] = [
  {
    id: 'everyday',
    instruments: [
      resonanceScaleInstrument,
      wifiMapInstrument,
      trackerHunterInstrument,
      metalDetectorInstrument,
      mainsFrequencyInstrument,
      machineDiagnosisInstrument,
      applianceCycleInstrument,
      propellerBalancerInstrument,
      tachometerInstrument,
      superzoomInstrument,
    ],
  },
  {
    id: 'color',
    instruments: [colorimeterInstrument, poolStripsInstrument, beerWineColorInstrument, pocketSpectrometerInstrument],
  },
  {
    id: 'sound',
    instruments: [
      traditionalTunerInstrument,
      metronomeInstrument,
      audioSpectrumInstrument,
      roomAcousticsInstrument,
      sonarInstrument,
      dataSonificationInstrument,
    ],
  },
  {
    id: 'science',
    instruments: [
      muonDetectorInstrument,
      gnssSkyInstrument,
      seismographInstrument,
      motionMagnifierInstrument,
      moonInstrument,
      exampleLevelInstrument,
    ],
  },
  {
    id: 'games',
    instruments: [
      colorHuntInstrument,
      singTheNoteInstrument,
      earTrainerInstrument,
      stepMusicInstrument,
      escapeLocksInstrument,
      rhythmInstrument,
      infiniteTxalapartaInstrument,
      phoneModemInstrument,
      soundLocatorInstrument,
      seismicNetworkInstrument,
    ],
  },
];

export const instrumentRegistry: readonly AnyInstrumentDefinition[] = instrumentSections.flatMap(
  (section) => section.instruments,
);
