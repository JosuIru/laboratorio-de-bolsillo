import { createFftPlan, type FftPlan } from './fft';
import { rootMeanSquare } from './levels';
import { computeAmplitudeSpectrum, createSpectrumWorkspace, findDominantFrequency, type SpectrumWorkspace } from './spectrum';
import { createWindow, type WindowFunction } from './windows';
import { estimateSampleRateHz, resampleUniformly } from '../signal/resampling';

export interface AxisSeries {
  timestampsSeconds: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
}

export interface VibrationAnalysis {
  /** Frecuencia de muestreo real estimada a partir de las marcas de tiempo. */
  sampleRateHz: number;
  /** Frecuencia con más energía sumando los tres ejes (sin la gravedad). */
  dominantFrequencyHz: number | null;
  /** Amplitud de esa componente, en m/s². */
  dominantAmplitude: number;
  /** Máximo del módulo de la aceleración dinámica (sin gravedad) en la ventana, en m/s². */
  peakDynamicAcceleration: number;
  /** Valor eficaz del módulo de la aceleración dinámica, en m/s². */
  rmsDynamicAcceleration: number;
  /** Espectro combinado de los tres ejes (amplitud por bin) y su resolución. */
  spectrumAmplitudes: Float64Array;
  binResolutionHz: number;
}

/**
 * Por debajo de esta amplitud (m/s²) no se informa de frecuencia dominante: es el orden del
 * ruido de los acelerómetros de móvil, y así el reposo no muestra una frecuencia inventada.
 */
export const defaultMinimumDominantAmplitude = 0.002;

/**
 * Prepara (una vez) lo necesario para analizar ventanas de `fftSize` muestras:
 * plan de FFT, ventana de Hann y buffers de trabajo reutilizables.
 */
export function createVibrationAnalyzer(fftSize: number) {
  const plan: FftPlan = createFftPlan(fftSize);
  const hannWindow: WindowFunction = createWindow('hann', fftSize);
  const axisWorkspace: SpectrumWorkspace = createSpectrumWorkspace(fftSize);
  const combinedAmplitudes = new Float64Array(fftSize / 2 + 1);

  /**
   * Analiza las últimas muestras. Remuestrea a ritmo uniforme (los sensores tienen jitter),
   * quita la media de cada eje (la gravedad) y combina los espectros de los tres ejes como
   * suma de potencias. Devuelve null si todavía no hay datos suficientes.
   */
  function analyze(
    series: AxisSeries,
    minimumFrequencyHz = 0.5,
    minimumDominantAmplitude = defaultMinimumDominantAmplitude,
  ): VibrationAnalysis | null {
    const sampleRateHz = estimateSampleRateHz(series.timestampsSeconds);
    if (!sampleRateHz) return null;

    const resampledAxes = [series.x, series.y, series.z].map(
      (axisValues) => resampleUniformly(series.timestampsSeconds, axisValues, sampleRateHz).values,
    );
    const availableCount = resampledAxes[0]!.length;
    if (availableCount < fftSize) return null;

    const latestAxes = resampledAxes.map((axisValues) => axisValues.subarray(availableCount - fftSize));
    const axisMeans = latestAxes.map((axisValues) => {
      let axisSum = 0;
      for (const axisValue of axisValues) axisSum += axisValue;
      return axisSum / fftSize;
    });

    const dynamicMagnitudes = new Float64Array(fftSize);
    for (let sampleIndex = 0; sampleIndex < fftSize; sampleIndex++) {
      dynamicMagnitudes[sampleIndex] = Math.hypot(
        latestAxes[0]![sampleIndex]! - axisMeans[0]!,
        latestAxes[1]![sampleIndex]! - axisMeans[1]!,
        latestAxes[2]![sampleIndex]! - axisMeans[2]!,
      );
    }

    combinedAmplitudes.fill(0);
    for (const axisValues of latestAxes) {
      const axisAmplitudes = computeAmplitudeSpectrum(
        plan,
        axisValues,
        hannWindow.coefficients,
        hannWindow.coherentGain,
        axisWorkspace,
      );
      for (let binIndex = 0; binIndex < combinedAmplitudes.length; binIndex++) {
        combinedAmplitudes[binIndex]! += axisAmplitudes[binIndex]! * axisAmplitudes[binIndex]!;
      }
    }
    for (let binIndex = 0; binIndex < combinedAmplitudes.length; binIndex++) {
      combinedAmplitudes[binIndex] = Math.sqrt(combinedAmplitudes[binIndex]!);
    }

    const spectralPeak = findDominantFrequency(combinedAmplitudes, sampleRateHz, fftSize, minimumFrequencyHz);
    const dominantFrequency = spectralPeak && spectralPeak.amplitude >= minimumDominantAmplitude ? spectralPeak : null;
    let peakDynamicAcceleration = 0;
    for (const dynamicMagnitude of dynamicMagnitudes) {
      if (dynamicMagnitude > peakDynamicAcceleration) peakDynamicAcceleration = dynamicMagnitude;
    }

    return {
      sampleRateHz,
      dominantFrequencyHz: dominantFrequency?.frequencyHz ?? null,
      dominantAmplitude: dominantFrequency?.amplitude ?? 0,
      peakDynamicAcceleration,
      rmsDynamicAcceleration: rootMeanSquare(dynamicMagnitudes),
      spectrumAmplitudes: Float64Array.from(combinedAmplitudes),
      binResolutionHz: sampleRateHz / fftSize,
    };
  }

  return { fftSize, analyze };
}
