import { createFrameCollector, type ErrorCorrection, type FrameCollector, type ReceivedFrame } from './frameCodec';

/**
 * Capa física por luz: la linterna o la pantalla se encienden y apagan y la cámara del otro
 * móvil mide el brillo. Codificación Manchester: cada bit son dos «chips» de luz; un 1 es
 * encendido→apagado y un 0 apagado→encendido. Así hay siempre un cambio a mitad de cada bit
 * (el receptor recupera el ritmo) y la luz está encendida la mitad del tiempo (el umbral entre
 * claro y oscuro se calcula solo).
 *
 * Emisión: preámbulo de chips alternos (para medir la duración de un chip y el retraso de la
 * linterna al encender y al apagar), delimitador 111000 (tres chips iguales no pueden darse en
 * Manchester, así que marca sin ambigüedad el principio de los datos), datos y un chip
 * encendido final que cierra la última racha.
 *
 * Recepción: la cámara da el brillo a 30 fotogramas/s como mucho. De cada paso por el umbral
 * se estima el instante exacto interpolando entre fotogramas; la duración de cada racha de luz
 * u oscuridad, dividida por la de un chip, dice cuántos chips iguales hubo.
 */

export type OpticalSpeedPreset = 'slow' | 'normal' | 'fast';

export const opticalChipDurationsSeconds: Record<OpticalSpeedPreset, number> = {
  slow: 0.2,
  normal: 0.1,
  fast: 1 / 15,
};

export interface OpticalModemConfiguration {
  chipDurationSeconds: number;
}

export function opticalConfigurationFor(speedPreset: OpticalSpeedPreset): OpticalModemConfiguration {
  return { chipDurationSeconds: opticalChipDurationsSeconds[speedPreset] };
}

/** Bits por segundo brutos (dos chips por bit). */
export function opticalRawBitRate(configuration: OpticalModemConfiguration): number {
  return 1 / (2 * configuration.chipDurationSeconds);
}

export const opticalPreambleChips: readonly number[] = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
export const opticalDelimiterChips: readonly number[] = [1, 1, 1, 0, 0, 0];
const opticalPostambleChips: readonly number[] = [1];

/** Chips (1 = luz encendida) de una trama completa. */
export function buildOpticalChipSequence(channelBits: readonly number[]): number[] {
  const chips = [...opticalPreambleChips, ...opticalDelimiterChips];
  for (const bit of channelBits) chips.push(...(bit ? [1, 0] : [0, 1]));
  chips.push(...opticalPostambleChips);
  return chips;
}

export function opticalTransmissionDurationSeconds(
  channelBitCount: number,
  configuration: OpticalModemConfiguration,
): number {
  const chipCount =
    opticalPreambleChips.length + opticalDelimiterChips.length + 2 * channelBitCount + opticalPostambleChips.length;
  return chipCount * configuration.chipDurationSeconds;
}

/** Estado de la luz (1/0) a los `elapsedSeconds` de empezar; apagada antes y después. */
export function opticalLightLevelAt(
  chips: readonly number[],
  elapsedSeconds: number,
  configuration: OpticalModemConfiguration,
): number {
  if (elapsedSeconds < 0) return 0;
  return chips[Math.floor(elapsedSeconds / configuration.chipDurationSeconds)] ?? 0;
}

// ─── Receptor ────────────────────────────────────────────────────────────────

/** Historia usada para el umbral claro/oscuro, en chips (siempre hay de los dos en Manchester). */
const envelopeHistoryChips = 12;
const minimumEnvelopeHistorySeconds = 1.2;
const hysteresisFraction = 0.15;
/** Contraste mínimo (máx − mín)/máx y oscilación mínima (en niveles de 0-255) para creer que hay señal. */
const minimumRelativeContrast = 0.06;
const minimumLuminanceSwing = 4;
const minimumPreambleRunCount = 8;
/** Sin cambios de luz durante estos chips, la trama se da por perdida. */
const lostSignalChipCount = 8;

export interface OpticalLinkQuality {
  /** Desviación típica del error de duración de las rachas, en chips (0 = perfecto). */
  timingJitterChips: number;
  /** Fracción de pares de chips que no eran Manchester válido. */
  manchesterViolationFraction: number;
  /** (máx − mín)/máx del brillo. */
  contrast: number;
  /** 0-1. */
  qualityScore: number;
  /** Duración de un chip medida en el preámbulo. */
  measuredChipDurationSeconds: number;
  /** Diferencia de retraso entre apagar y encender (típica de las linternas), en s. */
  switchingAsymmetrySeconds: number;
}

export type OpticalReceiverEvent =
  | { type: 'preambleDetected'; measuredChipDurationSeconds: number }
  | { type: 'frameReceived'; frame: ReceivedFrame; linkQuality: OpticalLinkQuality }
  | { type: 'frameLost'; reason: 'invalidHeader' | 'signalLost'; linkQuality: OpticalLinkQuality };

export interface OpticalReceiverStatus {
  phase: 'searching' | 'receiving';
  isSignalPresent: boolean;
  contrast: number;
  /** Nivel actual interpretado (1 = luz) o null si no hay señal. */
  lightLevel: number | null;
  collectedBitCount: number;
  expectedBitCount: number | null;
}

export interface OpticalReceiver {
  /** Añade el brillo medio de un fotograma (0-255) con su instante en segundos. */
  pushSample(timestampSeconds: number, luminance: number): OpticalReceiverEvent[];
  readonly status: OpticalReceiverStatus;
  reset(): void;
}

interface LightRun {
  level: number;
  durationSeconds: number;
}

export function createOpticalReceiver({
  configuration,
  errorCorrection,
}: {
  configuration: OpticalModemConfiguration;
  errorCorrection: ErrorCorrection;
}): OpticalReceiver {
  const nominalChipSeconds = configuration.chipDurationSeconds;
  const envelopeHistorySeconds = Math.max(minimumEnvelopeHistorySeconds, envelopeHistoryChips * nominalChipSeconds);

  const historyTimes: number[] = [];
  const historyLuminances: number[] = [];
  let currentLevel: number | null = null;
  let lastEdgeSeconds: number | null = null;
  let isSignalPresent = false;
  let contrast = 0;
  let recentRuns: LightRun[] = [];

  type ReceivingState = {
    phase: 'receiving';
    chipSeconds: number;
    onBiasSeconds: number;
    pendingChips: number[];
    frameCollector: FrameCollector;
    residualSquaredSum: number;
    runCount: number;
    manchesterPairCount: number;
    manchesterViolationCount: number;
  };
  let receiverState: { phase: 'searching' } | ReceivingState = { phase: 'searching' };

  function linkQualityOf(state: ReceivingState): OpticalLinkQuality {
    const timingJitterChips = state.runCount > 0 ? Math.sqrt(state.residualSquaredSum / state.runCount) : 0;
    const manchesterViolationFraction =
      state.manchesterPairCount > 0 ? state.manchesterViolationCount / state.manchesterPairCount : 0;
    return {
      timingJitterChips,
      manchesterViolationFraction,
      contrast,
      qualityScore:
        Math.max(0, 1 - 2.5 * timingJitterChips) * Math.max(0, 1 - 5 * manchesterViolationFraction),
      measuredChipDurationSeconds: state.chipSeconds,
      switchingAsymmetrySeconds: state.onBiasSeconds,
    };
  }

  function correctedDuration(run: LightRun, onBiasSeconds: number): number {
    return run.level === 1 ? run.durationSeconds - onBiasSeconds : run.durationSeconds + onBiasSeconds;
  }

  /** Busca preámbulo + delimitador al final de las rachas recientes; empieza a recibir si lo hay. */
  function tryDetectPreamble(events: OpticalReceiverEvent[]) {
    const runCount = recentRuns.length;
    if (runCount < minimumPreambleRunCount + 2) return;
    const delimiterOffRun = recentRuns[runCount - 1]!;
    const delimiterOnRun = recentRuns[runCount - 2]!;
    if (delimiterOffRun.level !== 0 || delimiterOnRun.level !== 1) return;
    const preambleRuns = recentRuns.slice(runCount - 2 - minimumPreambleRunCount, runCount - 2);
    const onDurations = preambleRuns.filter((run) => run.level === 1).map((run) => run.durationSeconds);
    const offDurations = preambleRuns.filter((run) => run.level === 0).map((run) => run.durationSeconds);
    if (onDurations.length === 0 || offDurations.length === 0) return;
    const meanOnSeconds = onDurations.reduce((total, duration) => total + duration, 0) / onDurations.length;
    const meanOffSeconds = offDurations.reduce((total, duration) => total + duration, 0) / offDurations.length;
    const chipSeconds = (meanOnSeconds + meanOffSeconds) / 2;
    const onBiasSeconds = (meanOnSeconds - meanOffSeconds) / 2;
    if (chipSeconds < 0.6 * nominalChipSeconds || chipSeconds > 1.6 * nominalChipSeconds) return;
    const isPreambleRegular = preambleRuns.every((run) => {
      const chipCount = correctedDuration(run, onBiasSeconds) / chipSeconds;
      return chipCount > 0.6 && chipCount < 1.4;
    });
    if (!isPreambleRegular) return;
    const delimiterOnChips = correctedDuration(delimiterOnRun, onBiasSeconds) / chipSeconds;
    const delimiterOffChips = Math.round(correctedDuration(delimiterOffRun, onBiasSeconds) / chipSeconds);
    if (delimiterOnChips < 2.4 || delimiterOnChips > 3.6) return;
    // Si el primer chip de datos está apagado, se suma a los tres del delimitador.
    if (delimiterOffChips !== 3 && delimiterOffChips !== 4) return;

    receiverState = {
      phase: 'receiving',
      chipSeconds,
      onBiasSeconds,
      pendingChips: delimiterOffChips === 4 ? [0] : [],
      frameCollector: createFrameCollector(errorCorrection),
      residualSquaredSum: 0,
      runCount: 0,
      manchesterPairCount: 0,
      manchesterViolationCount: 0,
    };
    recentRuns = [];
    events.push({ type: 'preambleDetected', measuredChipDurationSeconds: chipSeconds });
  }

  function handleReceivedRun(run: LightRun, events: OpticalReceiverEvent[]) {
    if (receiverState.phase !== 'receiving') return;
    const state = receiverState;
    const chipCountEstimate = correctedDuration(run, state.onBiasSeconds) / state.chipSeconds;
    const chipCount = Math.max(1, Math.round(chipCountEstimate));
    state.residualSquaredSum += (chipCountEstimate - Math.round(chipCountEstimate)) ** 2;
    state.runCount++;
    if (chipCount <= 2) {
      // Sigue despacio la duración del chip (el reloj del emisor puede no ser exacto).
      state.chipSeconds += 0.05 * (correctedDuration(run, state.onBiasSeconds) / chipCount - state.chipSeconds);
    }
    for (let chipIndex = 0; chipIndex < chipCount; chipIndex++) state.pendingChips.push(run.level);

    while (state.pendingChips.length >= 2) {
      const firstChip = state.pendingChips.shift()!;
      const secondChip = state.pendingChips.shift()!;
      state.manchesterPairCount++;
      if (firstChip === secondChip) state.manchesterViolationCount++;
      // Par válido: 10 → 1 y 01 → 0. En un par inválido se apuesta por el primer chip.
      const collectorState = state.frameCollector.pushBit(firstChip);
      if (collectorState.phase === 'complete') {
        events.push({ type: 'frameReceived', frame: collectorState.frame, linkQuality: linkQualityOf(state) });
        receiverState = { phase: 'searching' };
        return;
      }
      if (collectorState.phase === 'invalidHeader') {
        events.push({ type: 'frameLost', reason: 'invalidHeader', linkQuality: linkQualityOf(state) });
        receiverState = { phase: 'searching' };
        return;
      }
    }
  }

  function handleRun(run: LightRun, events: OpticalReceiverEvent[]) {
    if (receiverState.phase === 'receiving') {
      handleReceivedRun(run, events);
      return;
    }
    recentRuns.push(run);
    if (recentRuns.length > 40) recentRuns.shift();
    tryDetectPreamble(events);
  }

  /** Instante en que el brillo cruzó el umbral, interpolado entre los fotogramas que lo rodean. */
  function interpolateCrossingSeconds(threshold: number): number {
    const lastIndex = historyTimes.length - 1;
    for (let sampleIndex = lastIndex; sampleIndex > 0 && sampleIndex > lastIndex - 4; sampleIndex--) {
      const laterLuminance = historyLuminances[sampleIndex]!;
      const earlierLuminance = historyLuminances[sampleIndex - 1]!;
      if ((laterLuminance - threshold) * (earlierLuminance - threshold) <= 0 && laterLuminance !== earlierLuminance) {
        const crossingFraction = (threshold - earlierLuminance) / (laterLuminance - earlierLuminance);
        const earlierSeconds = historyTimes[sampleIndex - 1]!;
        return earlierSeconds + crossingFraction * (historyTimes[sampleIndex]! - earlierSeconds);
      }
    }
    return historyTimes[lastIndex]!;
  }

  function resetReceiver() {
    receiverState = { phase: 'searching' };
    recentRuns = [];
    currentLevel = null;
    lastEdgeSeconds = null;
  }

  return {
    get status(): OpticalReceiverStatus {
      const collectorState = receiverState.phase === 'receiving' ? receiverState.frameCollector.state : null;
      let collectedBitCount = 0;
      if (collectorState?.phase === 'header' || collectorState?.phase === 'body') {
        collectedBitCount = collectorState.collectedBitCount;
      }
      return {
        phase: receiverState.phase,
        isSignalPresent,
        contrast,
        lightLevel: isSignalPresent ? currentLevel : null,
        collectedBitCount,
        expectedBitCount: collectorState?.phase === 'body' ? collectorState.expectedBitCount : null,
      };
    },
    reset: resetReceiver,
    pushSample(timestampSeconds, luminance) {
      const events: OpticalReceiverEvent[] = [];
      historyTimes.push(timestampSeconds);
      historyLuminances.push(luminance);
      while (historyTimes.length > 2 && timestampSeconds - historyTimes[0]! > envelopeHistorySeconds) {
        historyTimes.shift();
        historyLuminances.shift();
      }
      let minimumLuminance = Infinity;
      let maximumLuminance = -Infinity;
      for (const historyLuminance of historyLuminances) {
        minimumLuminance = Math.min(minimumLuminance, historyLuminance);
        maximumLuminance = Math.max(maximumLuminance, historyLuminance);
      }
      const luminanceSwing = maximumLuminance - minimumLuminance;
      contrast = maximumLuminance > 0 ? luminanceSwing / maximumLuminance : 0;
      isSignalPresent = luminanceSwing >= minimumLuminanceSwing && contrast >= minimumRelativeContrast;

      const lostSignalSeconds =
        lostSignalChipCount * (receiverState.phase === 'receiving' ? receiverState.chipSeconds : nominalChipSeconds);
      if (lastEdgeSeconds !== null && timestampSeconds - lastEdgeSeconds > lostSignalSeconds) {
        if (receiverState.phase === 'receiving') {
          events.push({ type: 'frameLost', reason: 'signalLost', linkQuality: linkQualityOf(receiverState) });
        }
        resetReceiver();
      }
      if (!isSignalPresent) return events;

      const threshold = (minimumLuminance + maximumLuminance) / 2;
      const hysteresis = hysteresisFraction * luminanceSwing;
      let newLevel = currentLevel;
      if (luminance > threshold + hysteresis) newLevel = 1;
      else if (luminance < threshold - hysteresis) newLevel = 0;
      if (newLevel === null || newLevel === currentLevel) {
        currentLevel = newLevel;
        return events;
      }
      const edgeSeconds = interpolateCrossingSeconds(threshold);
      if (currentLevel !== null && lastEdgeSeconds !== null) {
        handleRun({ level: currentLevel, durationSeconds: edgeSeconds - lastEdgeSeconds }, events);
      }
      currentLevel = newLevel;
      lastEdgeSeconds = edgeSeconds;
      return events;
    },
  };
}
