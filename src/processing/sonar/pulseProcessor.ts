import { indexOfMaximum, interpolatePeak } from './echoProfile';
import { computeCorrelationEnvelope, createMatchedFilter, nextPowerOfTwo } from './matchedFilter';

/**
 * Procesa la grabación del micrófono en continuo y devuelve un perfil de ecos por cada pulso.
 *
 * No se sabe cuánto tarda el audio en salir por el altavoz ni en volver del micrófono (depende
 * del móvil y cambia de una sesión a otra), así que no se usa el reloj: en cada tramo de
 * grabación, la cresta más alta de la correlación es el sonido que va directo del altavoz al
 * micrófono, y esa cresta marca el tiempo cero. Los ecos se miden respecto a ella.
 *
 * Cada tramo cubre un periodo completo más la ventana de ecos, así que siempre contiene un
 * acoplamiento directo entero con sus ecos. Tras encontrarlo, el tramo siguiente empieza un
 * cuarto de periodo antes del próximo pulso: así sigue la pista aunque los relojes del
 * altavoz y del micrófono se desvíen un poco.
 */
export interface SonarPulseProcessorOptions {
  sampleRateHz: number;
  chirpSamples: Float32Array;
  pulsePeriodSamples: number;
  maximumEchoDelaySeconds: number;
  passbandLowHz: number;
  passbandHighHz: number;
  /** El acoplamiento directo debe superar en este factor a la media de la correlación. */
  minimumDirectToMeanRatio?: number;
}

export interface SonarPulseResult {
  /** Perfil de ecos normalizado (índice 0 = acoplamiento directo). Se reutiliza entre pulsos. */
  profile: Float64Array;
  isDirectPathDetected: boolean;
  /** Amplitud del acoplamiento directo (1 ≈ el chirp tal cual se emitió). */
  directAmplitude: number;
  directToMeanRatio: number;
  /** Posición fraccionaria del directo respecto al índice 0 del perfil, en muestras. */
  directPeakFractionalOffset: number;
  /** Muestra del flujo de grabación donde llegó el directo. */
  directStreamSampleIndex: number;
}

export function createSonarPulseProcessor(options: SonarPulseProcessorOptions) {
  const {
    sampleRateHz,
    chirpSamples,
    pulsePeriodSamples,
    maximumEchoDelaySeconds,
    passbandLowHz,
    passbandHighHz,
    minimumDirectToMeanRatio = 6,
  } = options;
  const profileLength = Math.ceil(maximumEchoDelaySeconds * sampleRateHz) + 1;
  const segmentLength = pulsePeriodSamples + chirpSamples.length + profileLength + 2;
  const fftSize = nextPowerOfTwo(segmentLength);
  const matchedFilter = createMatchedFilter({ chirpSamples, fftSize, sampleRateHz, passbandLowHz, passbandHighHz });
  const envelope = new Float64Array(fftSize);
  const profile = new Float64Array(profileLength);
  const trackingGuardSamples = Math.floor(pulsePeriodSamples / 4);

  let recordingBuffer = new Float32Array(segmentLength * 2 + 8192);
  /** Muestra del flujo que ocupa la posición 0 del buffer. */
  let bufferStartStreamIndex = 0;
  let bufferedSampleCount = 0;
  let nextSegmentStreamIndex = 0;

  function appendSamples(samples: ArrayLike<number>): void {
    // Descarta lo que ya no hace falta antes de crecer.
    const discardableCount = Math.max(
      0,
      Math.min(bufferedSampleCount, nextSegmentStreamIndex - bufferStartStreamIndex),
    );
    if (bufferedSampleCount + samples.length > recordingBuffer.length && discardableCount > 0) {
      recordingBuffer.copyWithin(0, discardableCount, bufferedSampleCount);
      bufferedSampleCount -= discardableCount;
      bufferStartStreamIndex += discardableCount;
    }
    if (bufferedSampleCount + samples.length > recordingBuffer.length) {
      const grownBuffer = new Float32Array(Math.max(recordingBuffer.length * 2, bufferedSampleCount + samples.length));
      grownBuffer.set(recordingBuffer.subarray(0, bufferedSampleCount));
      recordingBuffer = grownBuffer;
    }
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
      recordingBuffer[bufferedSampleCount + sampleIndex] = samples[sampleIndex]!;
    }
    bufferedSampleCount += samples.length;
  }

  function processSegment(): SonarPulseResult {
    const segmentOffset = nextSegmentStreamIndex - bufferStartStreamIndex;
    const segment = recordingBuffer.subarray(segmentOffset, segmentOffset + segmentLength);
    const validLagCount = computeCorrelationEnvelope(matchedFilter, segment, envelope);
    const searchEnd = Math.min(pulsePeriodSamples, validLagCount);
    const directIndex = indexOfMaximum(envelope, 0, searchEnd);
    const { position: directPosition, amplitude: directAmplitude } = interpolatePeak(envelope, directIndex);
    let envelopeSum = 0;
    for (let lagIndex = 0; lagIndex < searchEnd; lagIndex++) envelopeSum += envelope[lagIndex]!;
    const envelopeMean = Math.max(envelopeSum / Math.max(1, searchEnd), 1e-12);
    const directToMeanRatio = directAmplitude / envelopeMean;
    const isDirectPathDetected = directAmplitude > 0 && directToMeanRatio >= minimumDirectToMeanRatio;

    for (let profileIndex = 0; profileIndex < profileLength; profileIndex++) {
      const lagIndex = directIndex + profileIndex;
      profile[profileIndex] =
        isDirectPathDetected && lagIndex < validLagCount ? envelope[lagIndex]! / directAmplitude : 0;
    }
    const directStreamSampleIndex = nextSegmentStreamIndex + directIndex;
    nextSegmentStreamIndex = isDirectPathDetected
      ? directStreamSampleIndex + pulsePeriodSamples - trackingGuardSamples
      : nextSegmentStreamIndex + pulsePeriodSamples;
    return {
      profile,
      isDirectPathDetected,
      directAmplitude,
      directToMeanRatio,
      directPeakFractionalOffset: directPosition - directIndex,
      directStreamSampleIndex,
    };
  }

  return {
    profileLength,
    fftSize,
    /** Añade grabación y llama a `onPulse` por cada pulso completo que ya se pueda analizar. */
    pushSamples(samples: ArrayLike<number>, onPulse: (pulseResult: SonarPulseResult) => void): void {
      appendSamples(samples);
      while (bufferStartStreamIndex + bufferedSampleCount - nextSegmentStreamIndex >= segmentLength) {
        onPulse(processSegment());
      }
    },
  };
}
