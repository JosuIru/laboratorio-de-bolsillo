import { createFrameCollector, type ErrorCorrection, type FrameCollector, type ReceivedFrame } from './frameCodec';

/**
 * Capa física por sonido: FSK de fase continua con 2 o 4 tonos (1 o 2 bits por símbolo).
 *
 * Emisión: preámbulo (código de Barker de 13 símbolos con el tono más grave y el más agudo)
 * seguido de los bits de la trama, sin saltos de fase entre símbolos ni al empezar o acabar
 * (fundidos), para que el cambio de tono no suene como un clic audible.
 *
 * Recepción: cada octavo de símbolo se mide la energía de cada tono (Goertzel con ventana de
 * Hann) en una ventana del 60 % del símbolo. El preámbulo se busca comparando esas energías con
 * el patrón conocido, normalizadas (no depende del volumen); se toma el centro de la meseta de
 * máxima coincidencia como sincronía. Luego cada símbolo es el tono con más energía, y un lazo
 * «adelanto-retraso» corrige la deriva entre los relojes de los dos móviles.
 */

export type AcousticBandPreset = 'ultrasonic' | 'audible';
export type AcousticSpeedPreset = 'slow' | 'normal' | 'fast';

/** Tonos de cada banda. La casi ultrasónica no la oyen la mayoría de adultos (sí niños y mascotas). */
export const acousticBandTonesHz: Record<AcousticBandPreset, readonly number[]> = {
  ultrasonic: [17700, 18300, 18900, 19500],
  audible: [1500, 1900, 2300, 2700],
};

export const acousticSymbolDurationsSeconds: Record<AcousticSpeedPreset, number> = {
  slow: 0.06,
  normal: 0.03,
  fast: 0.015,
};

export interface AcousticModemConfiguration {
  /** 2 o 4 tonos, de grave a agudo. */
  toneFrequenciesHz: readonly number[];
  symbolDurationSeconds: number;
}

export function acousticConfigurationFor(
  bandPreset: AcousticBandPreset,
  speedPreset: AcousticSpeedPreset,
): AcousticModemConfiguration {
  return {
    toneFrequenciesHz: acousticBandTonesHz[bandPreset],
    symbolDurationSeconds: acousticSymbolDurationsSeconds[speedPreset],
  };
}

/** Código de Barker de 13: su autocorrelación tiene lóbulos laterales mínimos. */
export const barkerThirteenBits: readonly number[] = [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1];

export function bitsPerAcousticSymbol(configuration: AcousticModemConfiguration): number {
  return Math.round(Math.log2(configuration.toneFrequenciesHz.length));
}

/** Velocidad bruta del canal (sin contar preámbulo ni corrección de errores). */
export function acousticRawBitRate(configuration: AcousticModemConfiguration): number {
  return bitsPerAcousticSymbol(configuration) / configuration.symbolDurationSeconds;
}

/** El tono más agudo debe quedar 500 Hz por debajo de la frecuencia de Nyquist. */
export function isAcousticConfigurationSupported(
  configuration: AcousticModemConfiguration,
  sampleRateHz: number,
): boolean {
  return Math.max(...configuration.toneFrequenciesHz) <= sampleRateHz / 2 - 500;
}

function preambleToneIndices(configuration: AcousticModemConfiguration): number[] {
  const highestToneIndex = configuration.toneFrequenciesHz.length - 1;
  return barkerThirteenBits.map((barkerBit) => (barkerBit ? highestToneIndex : 0));
}

/** Código Gray: tonos vecinos difieren en un solo bit (el error más probable cuesta un bit). */
function grayEncode(value: number): number {
  return value ^ (value >> 1);
}

function grayDecode(grayValue: number): number {
  let value = grayValue;
  for (let shiftedValue = grayValue >> 1; shiftedValue > 0; shiftedValue >>= 1) value ^= shiftedValue;
  return value;
}

/** Convierte bits en índices de tono (rellena con ceros el último símbolo). */
export function bitsToToneIndices(bits: readonly number[], configuration: AcousticModemConfiguration): number[] {
  const bitsPerSymbol = bitsPerAcousticSymbol(configuration);
  const toneIndices: number[] = [];
  for (let startIndex = 0; startIndex < bits.length; startIndex += bitsPerSymbol) {
    let symbolValue = 0;
    for (let bitOffset = 0; bitOffset < bitsPerSymbol; bitOffset++) {
      symbolValue = (symbolValue << 1) | ((bits[startIndex + bitOffset] ?? 0) & 1);
    }
    toneIndices.push(grayEncode(symbolValue));
  }
  return toneIndices;
}

export interface AcousticModulationOptions {
  /** Silencio antes y después, en segundos. */
  leadInSeconds?: number;
  tailSeconds?: number;
  /** Amplitud máxima (0-1). */
  amplitude?: number;
}

const fadeDurationSeconds = 0.005;
/** Parte del símbolo en la que la frecuencia se desliza hacia la nueva (suaviza el espectro). */
const frequencyGlideFraction = 0.08;

/** Duración total de la emisión de `channelBitCount` bits (con preámbulo y silencios). */
export function acousticTransmissionDurationSeconds(
  channelBitCount: number,
  configuration: AcousticModemConfiguration,
  { leadInSeconds = 0.05, tailSeconds = 0.05 }: AcousticModulationOptions = {},
): number {
  const symbolCount = barkerThirteenBits.length + Math.ceil(channelBitCount / bitsPerAcousticSymbol(configuration));
  return leadInSeconds + symbolCount * configuration.symbolDurationSeconds + tailSeconds;
}

/** Genera la señal de audio de una trama (preámbulo + bits), lista para el altavoz. */
export function modulateAcousticFrame(
  channelBits: readonly number[],
  configuration: AcousticModemConfiguration,
  sampleRateHz: number,
  { leadInSeconds = 0.05, tailSeconds = 0.05, amplitude = 0.9 }: AcousticModulationOptions = {},
): Float32Array<ArrayBuffer> {
  const toneIndices = [...preambleToneIndices(configuration), ...bitsToToneIndices(channelBits, configuration)];
  const symbolSampleCount = configuration.symbolDurationSeconds * sampleRateHz;
  const leadInSampleCount = Math.round(leadInSeconds * sampleRateHz);
  const signalSampleCount = Math.round(toneIndices.length * symbolSampleCount);
  const totalSampleCount = leadInSampleCount + signalSampleCount + Math.round(tailSeconds * sampleRateHz);
  const samples = new Float32Array(totalSampleCount);
  const fadeSampleCount = Math.max(1, Math.round(fadeDurationSeconds * sampleRateHz));
  const glideSampleCount = Math.max(1, Math.round(frequencyGlideFraction * symbolSampleCount));

  let phaseRadians = 0;
  let previousFrequencyHz = configuration.toneFrequenciesHz[toneIndices[0]!]!;
  for (let symbolIndex = 0; symbolIndex < toneIndices.length; symbolIndex++) {
    const symbolStartSample = Math.round(symbolIndex * symbolSampleCount);
    const symbolEndSample = Math.round((symbolIndex + 1) * symbolSampleCount);
    const targetFrequencyHz = configuration.toneFrequenciesHz[toneIndices[symbolIndex]!]!;
    for (let sampleOffset = 0; sampleOffset < symbolEndSample - symbolStartSample; sampleOffset++) {
      const glideProgress = Math.min(1, (sampleOffset + 1) / glideSampleCount);
      const frequencyHz = previousFrequencyHz + (targetFrequencyHz - previousFrequencyHz) * glideProgress;
      phaseRadians += (2 * Math.PI * frequencyHz) / sampleRateHz;
      if (phaseRadians > 2 * Math.PI) phaseRadians -= 2 * Math.PI;
      const signalSampleIndex = symbolStartSample + sampleOffset;
      const envelope = Math.min(
        1,
        (signalSampleIndex + 1) / fadeSampleCount,
        (signalSampleCount - signalSampleIndex) / fadeSampleCount,
      );
      samples[leadInSampleCount + signalSampleIndex] = amplitude * envelope * Math.sin(phaseRadians);
    }
    previousFrequencyHz = targetFrequencyHz;
  }
  return samples;
}

// ─── Receptor ────────────────────────────────────────────────────────────────

export const hopsPerSymbol = 8;
const analysisWindowFraction = 0.6;
const energyRowCapacity = 256;
/** Símbolos seguidos con muy poca energía que dan la trama por perdida. */
const lostSignalSymbolCount = 6;
/** Energía, respecto a la del preámbulo, por debajo de la cual se considera que no hay señal. */
const lostSignalEnergyRatio = 1e-3;
const timingCorrectionThreshold = 0.25;

export interface LinkQuality {
  /** 0-1: fracción media de la energía que se lleva el tono ganador en cada símbolo. */
  meanSymbolPurity: number;
  /** Relación (dB) entre el tono ganador y la media de los demás. */
  toneContrastDecibels: number;
  /** 0 (azar) – 1 (perfecto), a partir de la pureza. */
  qualityScore: number;
  /** Sincronía movida por el lazo de deriva, en octavos de símbolo. */
  timingCorrectionHops: number;
}

export type AcousticReceiverEvent =
  | { type: 'preambleDetected'; preambleScore: number }
  | { type: 'frameReceived'; frame: ReceivedFrame; linkQuality: LinkQuality }
  | { type: 'frameLost'; reason: 'invalidHeader' | 'signalLost'; linkQuality: LinkQuality };

export interface AcousticReceiverStatus {
  phase: 'searching' | 'receiving';
  collectedBitCount: number;
  expectedBitCount: number | null;
  /** Nivel RMS de la última entrada, en dBFS. */
  inputLevelDecibels: number;
  /** Energía relativa (0-1) de cada tono en la última medida: para dibujar barras. */
  latestTonePurities: number[];
}

export interface AcousticReceiverOptions {
  sampleRateHz: number;
  configuration: AcousticModemConfiguration;
  errorCorrection: ErrorCorrection;
}

export interface AcousticReceiver {
  pushSamples(samples: ArrayLike<number>): AcousticReceiverEvent[];
  readonly status: AcousticReceiverStatus;
  reset(): void;
}

/** Umbral de coincidencia con el preámbulo: el azar da 1/M; se exige bastante más. */
export function preambleScoreThreshold(toneCount: number): number {
  return (1 + 1 / toneCount) / 2 + 0.1;
}

export function createAcousticReceiver({
  sampleRateHz,
  configuration,
  errorCorrection,
}: AcousticReceiverOptions): AcousticReceiver {
  const toneCount = configuration.toneFrequenciesHz.length;
  const bitsPerSymbol = bitsPerAcousticSymbol(configuration);
  const symbolSampleCount = configuration.symbolDurationSeconds * sampleRateHz;
  const hopSampleCount = symbolSampleCount / hopsPerSymbol;
  const windowSampleCount = Math.max(16, Math.round(analysisWindowFraction * symbolSampleCount));
  const preambleTones = preambleToneIndices(configuration);
  const preambleSpanHops = (preambleTones.length - 1) * hopsPerSymbol;
  const scoreThreshold = preambleScoreThreshold(toneCount);

  const hannWindow = new Float64Array(windowSampleCount);
  for (let sampleIndex = 0; sampleIndex < windowSampleCount; sampleIndex++) {
    hannWindow[sampleIndex] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (sampleIndex + 0.5)) / windowSampleCount);
  }
  const goertzelCoefficients = configuration.toneFrequenciesHz.map(
    (frequencyHz) => 2 * Math.cos((2 * Math.PI * frequencyHz) / sampleRateHz),
  );
  // Suelo absoluto para no dividir por cero en silencio digital (≈ −140 dBFS).
  const energyFloor = 1e-14 * windowSampleCount * windowSampleCount;

  let sampleRingCapacity = 1;
  while (sampleRingCapacity < windowSampleCount + 1) sampleRingCapacity <<= 1;
  const sampleRing = new Float64Array(sampleRingCapacity);
  const sampleRingMask = sampleRingCapacity - 1;
  const energyRows = new Float64Array(energyRowCapacity * toneCount);
  const rowTotals = new Float64Array(energyRowCapacity);

  let totalSampleCount = 0;
  let nextHopIndex = 0;
  let nextHopEndSample = windowSampleCount;

  type ReceiverState =
    | { phase: 'searching'; candidateHopScores: { hopIndex: number; score: number }[] }
    | {
        phase: 'receiving';
        nextDataHop: number;
        frameCollector: FrameCollector;
        preambleMeanEnergy: number;
        weakSymbolCount: number;
        timingErrorAverage: number;
        timingCorrectionHops: number;
        puritySum: number;
        contrastDecibelsSum: number;
        decodedSymbolCount: number;
      };
  let receiverState: ReceiverState = { phase: 'searching', candidateHopScores: [] };
  let inputLevelDecibels = -120;
  const latestTonePurities = new Array<number>(toneCount).fill(0);

  const rowOffset = (hopIndex: number) => (((hopIndex % energyRowCapacity) + energyRowCapacity) % energyRowCapacity) * toneCount;
  const toneEnergy = (hopIndex: number, toneIndex: number) => energyRows[rowOffset(hopIndex) + toneIndex]!;
  const rowTotal = (hopIndex: number) =>
    rowTotals[((hopIndex % energyRowCapacity) + energyRowCapacity) % energyRowCapacity]!;
  const tonePurity = (hopIndex: number, toneIndex: number) =>
    toneEnergy(hopIndex, toneIndex) / (rowTotal(hopIndex) + energyFloor);

  function measureHop(hopIndex: number) {
    const windowStartSample = totalSampleCount - windowSampleCount;
    const targetOffset = rowOffset(hopIndex);
    let energyTotal = 0;
    for (let toneIndex = 0; toneIndex < toneCount; toneIndex++) {
      const coefficient = goertzelCoefficients[toneIndex]!;
      let previousState = 0;
      let stateBeforePrevious = 0;
      for (let sampleOffset = 0; sampleOffset < windowSampleCount; sampleOffset++) {
        const windowedSample =
          sampleRing[(windowStartSample + sampleOffset) & sampleRingMask]! * hannWindow[sampleOffset]!;
        const currentState = windowedSample + coefficient * previousState - stateBeforePrevious;
        stateBeforePrevious = previousState;
        previousState = currentState;
      }
      const energy = Math.max(
        0,
        previousState * previousState +
          stateBeforePrevious * stateBeforePrevious -
          coefficient * previousState * stateBeforePrevious,
      );
      energyRows[targetOffset + toneIndex] = energy;
      energyTotal += energy;
    }
    rowTotals[((hopIndex % energyRowCapacity) + energyRowCapacity) % energyRowCapacity] = energyTotal;
    for (let toneIndex = 0; toneIndex < toneCount; toneIndex++) {
      latestTonePurities[toneIndex] = energyRows[targetOffset + toneIndex]! / (energyTotal + energyFloor);
    }
  }

  function preambleScoreEndingAt(lastSymbolHop: number): number {
    let purityTotal = 0;
    for (let preambleIndex = 0; preambleIndex < preambleTones.length; preambleIndex++) {
      const symbolHop = lastSymbolHop - (preambleTones.length - 1 - preambleIndex) * hopsPerSymbol;
      purityTotal += tonePurity(symbolHop, preambleTones[preambleIndex]!);
    }
    return purityTotal / preambleTones.length;
  }

  function currentLinkQuality(): LinkQuality {
    if (receiverState.phase !== 'receiving' || receiverState.decodedSymbolCount === 0) {
      return { meanSymbolPurity: 0, toneContrastDecibels: 0, qualityScore: 0, timingCorrectionHops: 0 };
    }
    const meanSymbolPurity = receiverState.puritySum / receiverState.decodedSymbolCount;
    return {
      meanSymbolPurity,
      toneContrastDecibels: receiverState.contrastDecibelsSum / receiverState.decodedSymbolCount,
      qualityScore: Math.min(1, Math.max(0, (meanSymbolPurity - 1 / toneCount) / (1 - 1 / toneCount))),
      timingCorrectionHops: receiverState.timingCorrectionHops,
    };
  }

  function lockToPreamble(candidateHopScores: { hopIndex: number; score: number }[], events: AcousticReceiverEvent[]) {
    const bestScore = Math.max(...candidateHopScores.map((candidate) => candidate.score));
    const plateauHops = candidateHopScores
      .filter((candidate) => candidate.score >= bestScore - 0.03)
      .map((candidate) => candidate.hopIndex);
    const lockedHop = Math.round((Math.min(...plateauHops) + Math.max(...plateauHops)) / 2);
    let preambleEnergyTotal = 0;
    for (let preambleIndex = 0; preambleIndex < preambleTones.length; preambleIndex++) {
      preambleEnergyTotal += rowTotal(lockedHop - preambleIndex * hopsPerSymbol);
    }
    receiverState = {
      phase: 'receiving',
      nextDataHop: lockedHop + hopsPerSymbol,
      frameCollector: createFrameCollector(errorCorrection),
      preambleMeanEnergy: preambleEnergyTotal / preambleTones.length,
      weakSymbolCount: 0,
      timingErrorAverage: 0,
      timingCorrectionHops: 0,
      puritySum: 0,
      contrastDecibelsSum: 0,
      decodedSymbolCount: 0,
    };
    events.push({ type: 'preambleDetected', preambleScore: bestScore });
  }

  function decodeDataSymbol(events: AcousticReceiverEvent[]) {
    if (receiverState.phase !== 'receiving') return;
    const symbolHop = receiverState.nextDataHop;
    let winningToneIndex = 0;
    let winningEnergy = -1;
    for (let toneIndex = 0; toneIndex < toneCount; toneIndex++) {
      const energy = toneEnergy(symbolHop, toneIndex);
      if (energy > winningEnergy) {
        winningEnergy = energy;
        winningToneIndex = toneIndex;
      }
    }
    const totalEnergy = rowTotal(symbolHop);
    const otherMeanEnergy = (totalEnergy - winningEnergy) / Math.max(1, toneCount - 1);
    receiverState.puritySum += winningEnergy / (totalEnergy + energyFloor);
    receiverState.contrastDecibelsSum += 10 * Math.log10((winningEnergy + energyFloor) / (otherMeanEnergy + energyFloor));
    receiverState.decodedSymbolCount++;

    // Lazo adelanto-retraso: si el tono ganador está más limpio un octavo de símbolo después que
    // uno antes, la ventana va retrasada respecto al emisor (y al revés).
    const timingError = tonePurity(symbolHop + 1, winningToneIndex) - tonePurity(symbolHop - 1, winningToneIndex);
    receiverState.timingErrorAverage = 0.7 * receiverState.timingErrorAverage + 0.3 * timingError;
    let timingCorrection = 0;
    if (receiverState.timingErrorAverage > timingCorrectionThreshold) timingCorrection = 1;
    else if (receiverState.timingErrorAverage < -timingCorrectionThreshold) timingCorrection = -1;
    if (timingCorrection !== 0) {
      receiverState.timingErrorAverage = 0;
      receiverState.timingCorrectionHops += timingCorrection;
    }
    receiverState.nextDataHop = symbolHop + hopsPerSymbol + timingCorrection;

    if (totalEnergy < receiverState.preambleMeanEnergy * lostSignalEnergyRatio) receiverState.weakSymbolCount++;
    else receiverState.weakSymbolCount = 0;
    if (receiverState.weakSymbolCount >= lostSignalSymbolCount) {
      events.push({ type: 'frameLost', reason: 'signalLost', linkQuality: currentLinkQuality() });
      receiverState = { phase: 'searching', candidateHopScores: [] };
      return;
    }

    const symbolValue = grayDecode(winningToneIndex);
    for (let bitPosition = bitsPerSymbol - 1; bitPosition >= 0; bitPosition--) {
      const collectorState = receiverState.frameCollector.pushBit((symbolValue >> bitPosition) & 1);
      if (collectorState.phase === 'complete') {
        events.push({ type: 'frameReceived', frame: collectorState.frame, linkQuality: currentLinkQuality() });
        receiverState = { phase: 'searching', candidateHopScores: [] };
        return;
      }
      if (collectorState.phase === 'invalidHeader') {
        events.push({ type: 'frameLost', reason: 'invalidHeader', linkQuality: currentLinkQuality() });
        receiverState = { phase: 'searching', candidateHopScores: [] };
        return;
      }
    }
  }

  function handleHop(hopIndex: number, events: AcousticReceiverEvent[]) {
    if (receiverState.phase === 'searching') {
      if (hopIndex < preambleSpanHops) return;
      const score = preambleScoreEndingAt(hopIndex);
      const { candidateHopScores } = receiverState;
      if (score >= scoreThreshold) candidateHopScores.push({ hopIndex, score });
      const firstCandidateHop = candidateHopScores[0]?.hopIndex;
      if (
        firstCandidateHop !== undefined &&
        (score < scoreThreshold || hopIndex - firstCandidateHop >= hopsPerSymbol)
      ) {
        lockToPreamble(candidateHopScores, events);
      }
    }
    // Cada símbolo se decide cuando ya está medido el octavo siguiente (para el lazo de deriva).
    while (receiverState.phase === 'receiving' && hopIndex >= receiverState.nextDataHop + 1) {
      decodeDataSymbol(events);
    }
  }

  return {
    get status(): AcousticReceiverStatus {
      const collectorState = receiverState.phase === 'receiving' ? receiverState.frameCollector.state : null;
      const hasProgress = collectorState?.phase === 'header' || collectorState?.phase === 'body';
      return {
        phase: receiverState.phase,
        collectedBitCount: hasProgress ? collectorState.collectedBitCount : 0,
        expectedBitCount: collectorState?.phase === 'body' ? collectorState.expectedBitCount : null,
        inputLevelDecibels,
        latestTonePurities: [...latestTonePurities],
      };
    },
    reset() {
      receiverState = { phase: 'searching', candidateHopScores: [] };
    },
    pushSamples(samples) {
      const events: AcousticReceiverEvent[] = [];
      let squaredSum = 0;
      for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        const sampleValue = samples[sampleIndex]!;
        squaredSum += sampleValue * sampleValue;
        sampleRing[totalSampleCount & sampleRingMask] = sampleValue;
        totalSampleCount++;
        if (totalSampleCount === nextHopEndSample) {
          measureHop(nextHopIndex);
          handleHop(nextHopIndex, events);
          nextHopIndex++;
          nextHopEndSample = windowSampleCount + Math.round(nextHopIndex * hopSampleCount);
        }
      }
      if (samples.length > 0) {
        inputLevelDecibels = 10 * Math.log10(squaredSum / samples.length + 1e-12);
      }
      return events;
    },
  };
}
