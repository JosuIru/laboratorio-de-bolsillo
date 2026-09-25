/**
 * Generador de señales de prueba: tonos, ruido y barridos. Todo se escribe en arrays tipados
 * normalizados a [−1, 1], listos para reproducir o para analizar en los tests.
 *
 * El ruido usa un generador pseudoaleatorio con semilla para que una misma prueba dé siempre
 * la misma señal (imprescindible para comparar mediciones y para los tests).
 */

export type WaveformKind = 'sine' | 'square' | 'triangle' | 'sawtooth';

export interface ToneOptions {
  frequencyHz: number;
  sampleRateHz: number;
  durationSeconds: number;
  amplitude?: number;
  waveform?: WaveformKind;
  /** Fase inicial en ciclos, en [0, 1). */
  initialPhaseCycles?: number;
}

/** Valor de una forma de onda para una fase en ciclos, en [0, 1). */
export function waveformValue(waveform: WaveformKind, phaseCycles: number): number {
  'worklet';
  switch (waveform) {
    case 'sine':
      return Math.sin(2 * Math.PI * phaseCycles);
    case 'square':
      return phaseCycles < 0.5 ? 1 : -1;
    case 'triangle':
      // Empieza en 0 y sube, como la senoidal, para que cambiar de forma no desplace la fase.
      return phaseCycles < 0.25
        ? 4 * phaseCycles
        : phaseCycles < 0.75
          ? 2 - 4 * phaseCycles
          : 4 * phaseCycles - 4;
    case 'sawtooth':
      return phaseCycles < 0.5 ? 2 * phaseCycles : 2 * phaseCycles - 2;
  }
}

function sampleCountFor(durationSeconds: number, sampleRateHz: number): number {
  if (!(sampleRateHz > 0)) throw new RangeError(`Frecuencia de muestreo no válida: ${sampleRateHz}`);
  if (!(durationSeconds >= 0)) throw new RangeError(`Duración no válida: ${durationSeconds}`);
  return Math.round(durationSeconds * sampleRateHz);
}

export function generateTone(options: ToneOptions): Float32Array {
  const { frequencyHz, sampleRateHz, durationSeconds, amplitude = 1, waveform = 'sine', initialPhaseCycles = 0 } = options;
  if (!(frequencyHz >= 0 && frequencyHz <= sampleRateHz / 2)) {
    throw new RangeError(`La frecuencia debe estar entre 0 y Nyquist (${sampleRateHz / 2} Hz): ${frequencyHz}`);
  }
  const toneSamples = new Float32Array(sampleCountFor(durationSeconds, sampleRateHz));
  const phaseIncrementCycles = frequencyHz / sampleRateHz;
  let phaseCycles = initialPhaseCycles - Math.floor(initialPhaseCycles);
  for (let sampleIndex = 0; sampleIndex < toneSamples.length; sampleIndex++) {
    toneSamples[sampleIndex] = amplitude * waveformValue(waveform, phaseCycles);
    phaseCycles += phaseIncrementCycles;
    // Acumular la fase (en vez de calcular f·n/fs) permite cambiar de frecuencia sin saltos.
    if (phaseCycles >= 1) phaseCycles -= Math.floor(phaseCycles);
  }
  return toneSamples;
}

/**
 * Oscilador con estado para generar audio por bloques (tiempo real). La fase se conserva entre
 * bloques y al cambiar de frecuencia, así que no hay clics en las costuras.
 */
export function createOscillator(sampleRateHz: number, initialFrequencyHz: number, waveform: WaveformKind = 'sine') {
  let frequencyHz = initialFrequencyHz;
  let currentWaveform = waveform;
  let phaseCycles = 0;
  return {
    setFrequency(nextFrequencyHz: number): void {
      frequencyHz = nextFrequencyHz;
    },
    setWaveform(nextWaveform: WaveformKind): void {
      currentWaveform = nextWaveform;
    },
    /** Rellena `outputBlock` y devuelve el mismo array. */
    fill(outputBlock: Float32Array, amplitude = 1): Float32Array {
      const phaseIncrementCycles = frequencyHz / sampleRateHz;
      for (let sampleIndex = 0; sampleIndex < outputBlock.length; sampleIndex++) {
        outputBlock[sampleIndex] = amplitude * waveformValue(currentWaveform, phaseCycles);
        phaseCycles += phaseIncrementCycles;
        if (phaseCycles >= 1) phaseCycles -= Math.floor(phaseCycles);
      }
      return outputBlock;
    },
    reset(): void {
      phaseCycles = 0;
    },
  };
}

/**
 * Generador pseudoaleatorio mulberry32: rápido, de 32 bits y con buena distribución para
 * audio. Devuelve números uniformes en [0, 1).
 */
export function createSeededRandom(seed: number): () => number {
  let generatorState = seed >>> 0;
  return () => {
    generatorState = (generatorState + 0x6d2b79f5) >>> 0;
    let mixedValue = generatorState;
    mixedValue = Math.imul(mixedValue ^ (mixedValue >>> 15), mixedValue | 1);
    mixedValue ^= mixedValue + Math.imul(mixedValue ^ (mixedValue >>> 7), mixedValue | 61);
    return ((mixedValue ^ (mixedValue >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseColor = 'white' | 'pink';

export interface NoiseOptions {
  sampleRateHz: number;
  durationSeconds: number;
  color?: NoiseColor;
  amplitude?: number;
  seed?: number;
}

/**
 * Ruido blanco (misma energía por hercio) o rosa (misma energía por octava, −3 dB/octava).
 * El rosa es el habitual en acústica de salas y altavoces porque se parece a cómo oímos.
 * Se normaliza para que el pico absoluto sea `amplitude`.
 */
export function generateNoise(options: NoiseOptions): Float32Array {
  const { sampleRateHz, durationSeconds, color = 'white', amplitude = 1, seed = 1 } = options;
  const noiseSamples = new Float32Array(sampleCountFor(durationSeconds, sampleRateHz));
  const nextRandom = createSeededRandom(seed);

  // Filtro de Paul Kellet (versión refinada): suma de siete polos que aproxima −3 dB/octava
  // con error < 0,05 dB por encima de fs/1000.
  let firstPole = 0;
  let secondPole = 0;
  let thirdPole = 0;
  let fourthPole = 0;
  let fifthPole = 0;
  let sixthPole = 0;
  let previousWhite = 0;
  for (let sampleIndex = 0; sampleIndex < noiseSamples.length; sampleIndex++) {
    const whiteValue = nextRandom() * 2 - 1;
    if (color === 'white') {
      noiseSamples[sampleIndex] = whiteValue;
      continue;
    }
    firstPole = 0.99886 * firstPole + whiteValue * 0.0555179;
    secondPole = 0.99332 * secondPole + whiteValue * 0.0750759;
    thirdPole = 0.969 * thirdPole + whiteValue * 0.153852;
    fourthPole = 0.8665 * fourthPole + whiteValue * 0.3104856;
    fifthPole = 0.55 * fifthPole + whiteValue * 0.5329522;
    sixthPole = -0.7616 * sixthPole - whiteValue * 0.016898;
    noiseSamples[sampleIndex] =
      firstPole + secondPole + thirdPole + fourthPole + fifthPole + sixthPole + previousWhite + whiteValue * 0.5362;
    previousWhite = whiteValue * 0.115926;
  }
  return normalizePeakInPlace(noiseSamples, amplitude);
}

export type SweepKind = 'linear' | 'logarithmic';

export interface SweepOptions {
  startFrequencyHz: number;
  endFrequencyHz: number;
  sampleRateHz: number;
  durationSeconds: number;
  kind?: SweepKind;
  amplitude?: number;
}

/**
 * Barrido senoidal (chirp). El logarítmico dedica el mismo tiempo a cada octava: es el que
 * se usa para medir respuestas de altavoces y salas (método de Farina).
 */
export function generateSweep(options: SweepOptions): Float32Array {
  const { startFrequencyHz, endFrequencyHz, sampleRateHz, durationSeconds, kind = 'logarithmic', amplitude = 1 } = options;
  const nyquistHz = sampleRateHz / 2;
  for (const frequencyHz of [startFrequencyHz, endFrequencyHz]) {
    if (!(frequencyHz > 0 && frequencyHz <= nyquistHz)) {
      throw new RangeError(`Las frecuencias del barrido deben estar en (0, ${nyquistHz}] Hz: ${frequencyHz}`);
    }
  }
  const sweepSamples = new Float32Array(sampleCountFor(durationSeconds, sampleRateHz));
  const frequencyRatio = endFrequencyHz / startFrequencyHz;
  // La fase es la integral de la frecuencia instantánea; con la fórmula cerrada no se acumula error.
  const isFlatSweep = kind === 'linear' || frequencyRatio === 1;
  for (let sampleIndex = 0; sampleIndex < sweepSamples.length; sampleIndex++) {
    const elapsedSeconds = sampleIndex / sampleRateHz;
    let phaseRadians: number;
    if (isFlatSweep) {
      const sweepRateHzPerSecond = (endFrequencyHz - startFrequencyHz) / durationSeconds;
      phaseRadians = 2 * Math.PI * (startFrequencyHz * elapsedSeconds + 0.5 * sweepRateHzPerSecond * elapsedSeconds ** 2);
    } else {
      const logarithmicRate = Math.log(frequencyRatio) / durationSeconds;
      phaseRadians = ((2 * Math.PI * startFrequencyHz) / logarithmicRate) * (Math.exp(logarithmicRate * elapsedSeconds) - 1);
    }
    sweepSamples[sampleIndex] = amplitude * Math.sin(phaseRadians);
  }
  return sweepSamples;
}

/** Frecuencia instantánea de un barrido en un instante dado (útil para dibujar o para tests). */
export function sweepFrequencyAt(options: Omit<SweepOptions, 'sampleRateHz' | 'amplitude'>, elapsedSeconds: number): number {
  const { startFrequencyHz, endFrequencyHz, durationSeconds, kind = 'logarithmic' } = options;
  const sweepProgress = Math.min(1, Math.max(0, elapsedSeconds / durationSeconds));
  return kind === 'linear'
    ? startFrequencyHz + (endFrequencyHz - startFrequencyHz) * sweepProgress
    : startFrequencyHz * (endFrequencyHz / startFrequencyHz) ** sweepProgress;
}

/**
 * Rampas de entrada y salida de coseno elevado. Sin ellas, empezar o cortar una señal de golpe
 * produce un clic audible (y energía espuria en todo el espectro).
 */
export function applyFadesInPlace<SampleArray extends Float32Array | Float64Array>(
  samples: SampleArray,
  fadeSampleCount: number,
): SampleArray {
  const effectiveFadeCount = Math.min(Math.floor(fadeSampleCount), Math.floor(samples.length / 2));
  for (let fadeIndex = 0; fadeIndex < effectiveFadeCount; fadeIndex++) {
    const fadeGain = 0.5 - 0.5 * Math.cos((Math.PI * fadeIndex) / effectiveFadeCount);
    samples[fadeIndex] = samples[fadeIndex]! * fadeGain;
    const mirroredIndex = samples.length - 1 - fadeIndex;
    samples[mirroredIndex] = samples[mirroredIndex]! * fadeGain;
  }
  return samples;
}

/** Escala para que el pico absoluto sea `targetPeak`. Una señal nula se deja como está. */
export function normalizePeakInPlace<SampleArray extends Float32Array | Float64Array>(
  samples: SampleArray,
  targetPeak = 1,
): SampleArray {
  let currentPeak = 0;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    currentPeak = Math.max(currentPeak, Math.abs(samples[sampleIndex]!));
  }
  if (currentPeak === 0) return samples;
  const gain = targetPeak / currentPeak;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    samples[sampleIndex] = samples[sampleIndex]! * gain;
  }
  return samples;
}
