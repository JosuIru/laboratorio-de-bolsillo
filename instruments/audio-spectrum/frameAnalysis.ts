import { rmsToDecibelsFullScale, rootMeanSquare } from '@/processing/dsp/levels';
import { findDominantFrequency } from '@/processing/dsp/spectrum';

/**
 * El AnalyserNode (especificación Web Audio) aplica una ventana de Blackman y divide entre N:
 * una senoidal de amplitud A da un bin de A·0,42/2. Para expresar el tono en dBFS hay que
 * sumar 20·log10(2/0,42) ≈ 13,56 dB.
 */
export const analyserToneCorrectionDecibels = 20 * Math.log10(2 / 0.42);

export interface AudioFrameAnalysis {
  /** Nivel global de la señal (RMS) en dBFS, convención AES17 (senoidal a fondo de escala = 0). */
  levelDecibelsFullScale: number;
  /** Frecuencia del tono más fuerte, o null si no destaca claramente del ruido. */
  dominantFrequencyHz: number | null;
  /** Nivel de ese tono en dBFS. */
  dominantToneDecibelsFullScale: number | null;
}

export interface FrameAnalysisOptions {
  minimumFrequencyHz: number;
  maximumFrequencyHz: number;
  /** El pico tiene que superar la mediana del espectro en al menos estos dB para ser un tono. */
  minimumProminenceDecibels: number;
}

export const defaultFrameAnalysisOptions: FrameAnalysisOptions = {
  minimumFrequencyHz: 20,
  maximumFrequencyHz: 20_000,
  minimumProminenceDecibels: 20,
};

function medianOf(values: Float64Array): number {
  const sortedValues = Float64Array.from(values).sort();
  const middleIndex = sortedValues.length >> 1;
  return sortedValues.length % 2 === 1
    ? sortedValues[middleIndex]!
    : (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
}

/**
 * Crea un analizador que reutiliza sus buffers entre tramas.
 * `decibelSpectrum`: salida de getFloatFrequencyData (fftSize/2 bins, en dB).
 * `timeDomainSamples`: salida de getFloatTimeDomainData (fftSize muestras en [−1, 1]).
 */
export function createAudioFrameAnalyzer(fftSize: number, options: FrameAnalysisOptions = defaultFrameAnalysisOptions) {
  const amplitudeSpectrum = new Float64Array(fftSize / 2);
  const decibelScratch = new Float64Array(fftSize / 2);

  return function analyzeFrame(
    decibelSpectrum: ArrayLike<number>,
    timeDomainSamples: ArrayLike<number>,
    sampleRateHz: number,
  ): AudioFrameAnalysis {
    const binCount = Math.min(amplitudeSpectrum.length, decibelSpectrum.length);
    for (let binIndex = 0; binIndex < binCount; binIndex++) {
      const binDecibels = decibelSpectrum[binIndex]!;
      const finiteDecibels = Number.isFinite(binDecibels) ? binDecibels : -200;
      decibelScratch[binIndex] = finiteDecibels;
      amplitudeSpectrum[binIndex] = 10 ** (finiteDecibels / 20);
    }

    const levelDecibelsFullScale = rmsToDecibelsFullScale(rootMeanSquare(timeDomainSamples));
    const maximumFrequencyHz = Math.min(options.maximumFrequencyHz, sampleRateHz / 2);
    const spectralPeak = findDominantFrequency(
      amplitudeSpectrum.subarray(0, binCount),
      sampleRateHz,
      fftSize,
      options.minimumFrequencyHz,
      maximumFrequencyHz,
    );

    if (!spectralPeak) return { levelDecibelsFullScale, dominantFrequencyHz: null, dominantToneDecibelsFullScale: null };
    const peakDecibels = decibelScratch[spectralPeak.binIndex]!;
    const isProminent = peakDecibels - medianOf(decibelScratch.subarray(0, binCount)) >= options.minimumProminenceDecibels;
    return {
      levelDecibelsFullScale,
      dominantFrequencyHz: isProminent ? spectralPeak.frequencyHz : null,
      dominantToneDecibelsFullScale: isProminent ? peakDecibels + analyserToneCorrectionDecibels : null,
    };
  };
}
