/**
 * Lo que hace cada móvil durante una medida, sobre el audio de su propio micrófono:
 *
 * 1. Escucha en continuo hasta oír el primer chirrido de referencia (filtro adaptado por tramos).
 * 2. Graba lo que queda hasta el segundo chirrido.
 * 3. Busca la palmada entre ambos y el segundo chirrido donde debe estar, y calcula el intervalo
 *    «primer chirrido → palmada» en su propio reloj, corregido con la separación medida entre los
 *    dos chirridos (que el emisor fija exactamente).
 *
 * Todos los instantes son índices de muestra del micrófono: el reloj del sistema no interviene y
 * los retrasos internos del móvil (búferes, conversor) afectan igual al chirrido y a la palmada,
 * así que se cancelan en el intervalo.
 */

import { type ChirpLocator, createChirpLocator, locateChirp } from './chirpArrival';
import { locateClapOnset } from './clapOnset';
import { generateReferenceChirp, referenceChirpSeparationSeconds } from './referenceSignal';

export interface ClapTimingResult {
  /** Intervalo primer chirrido → palmada, en segundos del reloj del emisor si se pudo corregir. */
  intervalSeconds: number;
  /** El mismo intervalo sin corregir la deriva del reloj. */
  uncorrectedIntervalSeconds: number;
  /** Cuánto va rápido (+) o lento (−) este reloj respecto al del emisor, o `null` si no se oyó el segundo chirrido. */
  clockDriftPartsPerMillion: number | null;
  chirpSharpness: number;
  /** Nivel del chirrido recibido (1 = tal cual se emitió). */
  chirpAmplitude: number;
  clapSignalToNoiseRatio: number;
  clapPeakAmplitude: number;
  hasCompetingOnset: boolean;
}

export type ClapTimingFailure = 'noClap' | 'audioGap';

export type ClapTimingState =
  | { phase: 'waitingForChirp' }
  | { phase: 'capturing'; progress: number }
  | { phase: 'done'; result: ClapTimingResult }
  | { phase: 'failed'; reason: ClapTimingFailure };

export interface ClapTimingSessionOptions {
  sampleRateHz: number;
  /** Tramo (s) de cada búsqueda del primer chirrido. */
  searchStepSeconds?: number;
}

/** La palmada se busca desde aquí (tras el primer chirrido y sus rebotes)… */
export const clapWindowStartSeconds = 0.3;
/** …hasta aquí antes del segundo chirrido. */
export const clapWindowEndMarginSeconds = 0.06;
/** Margen para buscar el segundo chirrido: ±3 ms dan para desvíos de reloj de 1000 ppm. */
const secondChirpToleranceSeconds = 0.003;
/** Desvíos mayores no son de reloj: el segundo «chirrido» sería otra cosa. */
const maximumPlausibleDriftPartsPerMillion = 800;

export function createClapTimingSession(options: ClapTimingSessionOptions) {
  const { sampleRateHz, searchStepSeconds = 0.2 } = options;
  const chirpSamples = generateReferenceChirp(sampleRateHz);
  const searchStepSamples = Math.round(searchStepSeconds * sampleRateHz);
  const separationSamples = referenceChirpSeparationSeconds * sampleRateHz;
  const toleranceSamples = Math.ceil(secondChirpToleranceSeconds * sampleRateHz);
  const streamingLocator: ChirpLocator = createChirpLocator({
    sampleRateHz,
    chirpSamples,
    maximumSegmentLength: searchStepSamples + chirpSamples.length + Math.ceil(0.03 * sampleRateHz),
  });
  const guardSamples = streamingLocator.guardSamples;
  const captureLengthSamples = Math.ceil(separationSamples + toleranceSamples + 2 * chirpSamples.length);

  let recordingBuffer = new Float32Array(Math.max(4 * searchStepSamples, 1 << 15));
  /** Muestra del flujo que ocupa la posición 0 del buffer. */
  let bufferStartStreamIndex = 0;
  let bufferedSampleCount = 0;
  let nextSearchStreamIndex = guardSamples;
  let firstChirpStreamIndex: number | null = null;
  let firstChirpDetails: { sharpness: number; amplitude: number } | null = null;
  let state: ClapTimingState = { phase: 'waitingForChirp' };

  function appendSamples(sampleChunk: ArrayLike<number>) {
    const neededStreamIndex = firstChirpStreamIndex === null ? nextSearchStreamIndex - guardSamples : bufferStartStreamIndex;
    const discardableCount = Math.max(0, Math.min(bufferedSampleCount, neededStreamIndex - bufferStartStreamIndex));
    if (bufferedSampleCount + sampleChunk.length > recordingBuffer.length && discardableCount > 0) {
      recordingBuffer.copyWithin(0, discardableCount, bufferedSampleCount);
      bufferedSampleCount -= discardableCount;
      bufferStartStreamIndex += discardableCount;
    }
    if (bufferedSampleCount + sampleChunk.length > recordingBuffer.length) {
      const grownBuffer = new Float32Array(Math.max(recordingBuffer.length * 2, bufferedSampleCount + sampleChunk.length));
      grownBuffer.set(recordingBuffer.subarray(0, bufferedSampleCount));
      recordingBuffer = grownBuffer;
    }
    for (let chunkIndex = 0; chunkIndex < sampleChunk.length; chunkIndex++) {
      recordingBuffer[bufferedSampleCount + chunkIndex] = sampleChunk[chunkIndex]!;
    }
    bufferedSampleCount += sampleChunk.length;
  }

  function searchFirstChirp() {
    const bufferEndStreamIndex = bufferStartStreamIndex + bufferedSampleCount;
    while (firstChirpStreamIndex === null && bufferEndStreamIndex >= nextSearchStreamIndex + searchStepSamples + chirpSamples.length) {
      const bufferedSamples = recordingBuffer.subarray(0, bufferedSampleCount);
      const searchStartOffset = nextSearchStreamIndex - bufferStartStreamIndex;
      const chirpArrival = locateChirp(
        streamingLocator,
        bufferedSamples,
        searchStartOffset,
        searchStartOffset + searchStepSamples,
      );
      if (chirpArrival) {
        firstChirpStreamIndex = bufferStartStreamIndex + chirpArrival.arrivalSampleIndex;
        firstChirpDetails = { sharpness: chirpArrival.sharpness, amplitude: chirpArrival.amplitude };
        state = { phase: 'capturing', progress: 0 };
      } else {
        nextSearchStreamIndex += searchStepSamples;
      }
    }
  }

  function analyzeCapture(firstChirpIndex: number): ClapTimingState {
    const bufferedSamples = recordingBuffer.subarray(0, bufferedSampleCount);
    const firstChirpOffset = firstChirpIndex - bufferStartStreamIndex;
    const expectedSecondOffset = firstChirpOffset + separationSamples;

    const secondChirpLocator = createChirpLocator({
      sampleRateHz,
      chirpSamples,
      maximumSegmentLength: 2 * toleranceSamples + chirpSamples.length + guardSamples + 2,
    });
    const secondChirp = locateChirp(
      secondChirpLocator,
      bufferedSamples,
      Math.floor(expectedSecondOffset - toleranceSamples),
      Math.ceil(expectedSecondOffset + toleranceSamples),
    );
    let clockRatio = 1;
    let clockDriftPartsPerMillion: number | null = null;
    if (secondChirp) {
      const measuredSeparationSamples = secondChirp.arrivalSampleIndex - firstChirpOffset;
      const driftPartsPerMillion = (measuredSeparationSamples / separationSamples - 1) * 1e6;
      if (Math.abs(driftPartsPerMillion) <= maximumPlausibleDriftPartsPerMillion) {
        clockDriftPartsPerMillion = driftPartsPerMillion;
        clockRatio = separationSamples / measuredSeparationSamples;
      }
    }

    const clapOnset = locateClapOnset(
      bufferedSamples,
      Math.round(firstChirpOffset + clapWindowStartSeconds * sampleRateHz),
      Math.round(expectedSecondOffset - clapWindowEndMarginSeconds * sampleRateHz),
      sampleRateHz,
    );
    if (!clapOnset) return { phase: 'failed', reason: 'noClap' };
    const uncorrectedIntervalSeconds = (clapOnset.onsetSampleIndex - firstChirpOffset) / sampleRateHz;
    return {
      phase: 'done',
      result: {
        intervalSeconds: uncorrectedIntervalSeconds * clockRatio,
        uncorrectedIntervalSeconds,
        clockDriftPartsPerMillion,
        chirpSharpness: firstChirpDetails?.sharpness ?? 0,
        chirpAmplitude: firstChirpDetails?.amplitude ?? 0,
        clapSignalToNoiseRatio: clapOnset.signalToNoiseRatio,
        clapPeakAmplitude: clapOnset.peakAmplitude,
        hasCompetingOnset: clapOnset.hasCompetingOnset,
      },
    };
  }

  return {
    getState(): ClapTimingState {
      return state;
    },
    /** Añade audio del micrófono. Devuelve `true` si ha cambiado el estado. */
    pushSamples(sampleChunk: ArrayLike<number>): boolean {
      if (state.phase === 'done' || state.phase === 'failed') return false;
      const previousState = state;
      appendSamples(sampleChunk);
      if (firstChirpStreamIndex === null) searchFirstChirp();
      if (firstChirpStreamIndex !== null) {
        const capturedSampleCount = bufferStartStreamIndex + bufferedSampleCount - firstChirpStreamIndex;
        if (capturedSampleCount >= captureLengthSamples) {
          state = analyzeCapture(firstChirpStreamIndex);
        } else {
          const progress = Math.max(0, capturedSampleCount / captureLengthSamples);
          // Solo se avisa cada ~5 % para no repintar la pantalla con cada bloque.
          if (previousState.phase !== 'capturing' || progress - previousState.progress >= 0.05) {
            state = { phase: 'capturing', progress };
          }
        }
      }
      return state !== previousState;
    },
    /** El micrófono se ha saltado audio: los índices de muestra ya no cuentan tiempo. */
    reportAudioGap(): boolean {
      if (state.phase === 'done' || state.phase === 'failed') return false;
      if (firstChirpStreamIndex !== null) {
        state = { phase: 'failed', reason: 'audioGap' };
        return true;
      }
      // Aún esperando: basta con olvidar lo anterior.
      bufferStartStreamIndex += bufferedSampleCount;
      bufferedSampleCount = 0;
      nextSearchStreamIndex = bufferStartStreamIndex + guardSamples;
      return false;
    },
  };
}
