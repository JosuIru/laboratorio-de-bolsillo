/**
 * Captura de la respuesta de la sala a un golpe, bloque a bloque según llega el audio:
 * 1. mide el ruido de fondo durante `noiseSeconds`;
 * 2. espera a un bloque mucho más fuerte que ese ruido (el golpe);
 * 3. graba `decaySeconds` de cola, con un poco de audio de antes del golpe.
 */

export interface ImpulseCaptureOptions {
  sampleRateHz: number;
  noiseSeconds?: number;
  /** Cuántos dB por encima del ruido tiene que subir un bloque para contar como golpe. */
  impulseThresholdDecibels?: number;
  /** Audio anterior al golpe que se conserva (para no perder su arranque). */
  preImpulseSeconds?: number;
  decaySeconds?: number;
  /** Tiempo máximo de espera al golpe. */
  maximumWaitSeconds?: number;
}

export type ImpulseCapturePhase = 'measuring-noise' | 'waiting-for-impulse' | 'recording-decay' | 'finished' | 'timed-out';

export interface CapturedRoomResponse {
  noiseSamples: Float32Array;
  responseSamples: Float32Array;
  noiseLevelDecibels: number;
  /** Algún pico del golpe llegó al tope del micrófono: el principio de la caída sale recortado. */
  isClipped: boolean;
}

/** Nivel a partir del cual se considera que la muestra ha saturado. */
const clippingAmplitude = 0.99;

export function blockLevelDecibels(samples: ArrayLike<number>): number {
  let squaredSum = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) squaredSum += samples[sampleIndex]! ** 2;
  return 10 * Math.log10(Math.max(1e-20, squaredSum / Math.max(1, samples.length)));
}

function concatenateBlocks(blocks: readonly Float32Array[]): Float32Array {
  const totalLength = blocks.reduce((lengthSum, block) => lengthSum + block.length, 0);
  const concatenatedSamples = new Float32Array(totalLength);
  let writeOffset = 0;
  for (const block of blocks) {
    concatenatedSamples.set(block, writeOffset);
    writeOffset += block.length;
  }
  return concatenatedSamples;
}

export function createImpulseCapture(options: ImpulseCaptureOptions) {
  const {
    sampleRateHz,
    noiseSeconds = 0.6,
    impulseThresholdDecibels = 20,
    preImpulseSeconds = 0.05,
    decaySeconds = 3,
    maximumWaitSeconds = 15,
  } = options;
  const noiseSampleTarget = Math.round(noiseSeconds * sampleRateHz);
  const preImpulseSampleTarget = Math.round(preImpulseSeconds * sampleRateHz);
  const decaySampleTarget = Math.round(decaySeconds * sampleRateHz);
  const maximumWaitSamples = Math.round(maximumWaitSeconds * sampleRateHz);

  let phase: ImpulseCapturePhase = 'measuring-noise';
  const noiseBlocks: Float32Array[] = [];
  let noiseSampleCount = 0;
  let noiseLevelDecibels = Number.NEGATIVE_INFINITY;
  let noiseSamples: Float32Array = new Float32Array(0);
  const recentBlocks: Float32Array[] = [];
  let recentSampleCount = 0;
  let waitedSampleCount = 0;
  const responseBlocks: Float32Array[] = [];
  let responseSampleCountAfterImpulse = 0;
  let capturedResponse: CapturedRoomResponse | null = null;

  function finishCapture() {
    const responseSamples = concatenateBlocks(responseBlocks);
    let isClipped = false;
    for (let sampleIndex = 0; sampleIndex < responseSamples.length; sampleIndex++) {
      if (Math.abs(responseSamples[sampleIndex]!) >= clippingAmplitude) {
        isClipped = true;
        break;
      }
    }
    capturedResponse = { noiseSamples, responseSamples, noiseLevelDecibels, isClipped };
    phase = 'finished';
  }

  return {
    get phase(): ImpulseCapturePhase {
      return phase;
    },
    get noiseLevelDecibels(): number {
      return noiseLevelDecibels;
    },
    get capturedResponse(): CapturedRoomResponse | null {
      return capturedResponse;
    },
    /** Añade un bloque de audio (se copia) y devuelve la fase tras procesarlo. */
    pushBlock(incomingBlock: ArrayLike<number>): ImpulseCapturePhase {
      const block = Float32Array.from(incomingBlock);
      switch (phase) {
        case 'measuring-noise': {
          noiseBlocks.push(block);
          noiseSampleCount += block.length;
          if (noiseSampleCount >= noiseSampleTarget) {
            noiseSamples = concatenateBlocks(noiseBlocks);
            noiseLevelDecibels = blockLevelDecibels(noiseSamples);
            phase = 'waiting-for-impulse';
          }
          break;
        }
        case 'waiting-for-impulse': {
          waitedSampleCount += block.length;
          if (blockLevelDecibels(block) >= noiseLevelDecibels + impulseThresholdDecibels) {
            // Se conserva un poco de lo anterior para no perder el arranque del golpe.
            responseBlocks.push(...recentBlocks, block);
            responseSampleCountAfterImpulse = block.length;
            phase = 'recording-decay';
            break;
          }
          recentBlocks.push(block);
          recentSampleCount += block.length;
          while (recentBlocks.length > 1 && recentSampleCount - recentBlocks[0]!.length >= preImpulseSampleTarget) {
            recentSampleCount -= recentBlocks.shift()!.length;
          }
          if (waitedSampleCount >= maximumWaitSamples) phase = 'timed-out';
          break;
        }
        case 'recording-decay': {
          responseBlocks.push(block);
          responseSampleCountAfterImpulse += block.length;
          if (responseSampleCountAfterImpulse >= decaySampleTarget) finishCapture();
          break;
        }
        case 'finished':
        case 'timed-out':
          break;
      }
      return phase;
    },
  };
}
