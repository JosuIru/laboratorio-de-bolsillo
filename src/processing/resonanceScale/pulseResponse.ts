/**
 * Respuesta del móvil a pulsos de su propio motor de vibración, medida con el acelerómetro.
 *
 * El motor se enciende y se apaga varias veces. De la grabación se detectan los tramos con
 * vibración (sin necesidad de sincronizar relojes con el motor), y de cada tramo se mide:
 * - la amplitud eficaz (RMS) de la aceleración, sumando los tres ejes y quitando la gravedad;
 * - la frecuencia del pico del espectro (la del motor o su alias, si pasa de Nyquist).
 *
 * Las muestras de Android llegan con jitter y huecos: la amplitud se calcula con las muestras
 * tal cual (el RMS de una senoidal no necesita muestreo uniforme) y solo el espectro remuestrea.
 */

import { createFftPlan } from '@/processing/dsp/fft';
import { computeAmplitudeSpectrum, createSpectrumWorkspace, findDominantFrequency } from '@/processing/dsp/spectrum';
import { createWindow } from '@/processing/dsp/windows';
import { estimateSampleRateHz, resampleUniformly } from '@/processing/signal/resampling';

export interface AccelerationRecording {
  timestampsSeconds: ArrayLike<number>;
  /** Aceleración en m/s² (con la gravedad incluida; se quita aquí). */
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
}

export interface PulseFeatures {
  startSeconds: number;
  endSeconds: number;
  /** RMS de la aceleración vibratoria (tres ejes juntos), en m/s². */
  amplitudeRms: number;
  /** Frecuencia aparente del pico del espectro, o null si el tramo es demasiado corto. */
  peakFrequencyHz: number | null;
}

export interface PulseResponseAnalysis {
  sampleRateHz: number;
  pulses: PulseFeatures[];
  /** Nivel de fondo con el motor apagado (m/s² RMS). */
  noiseRms: number;
  /** Mediana de las amplitudes de los pulsos. */
  amplitudeRms: number;
  /** Desviación típica de las amplitudes entre pulsos (repetibilidad). */
  amplitudeSpreadRms: number;
  peakFrequencyHz: number | null;
  peakFrequencySpreadHz: number | null;
  /** Espectro medio de los pulsos, para dibujarlo. */
  spectrumAmplitudes: Float64Array;
  spectrumBinWidthHz: number;
}

export type PulseAnalysisFailure = 'too-few-samples' | 'no-vibration-detected' | 'too-few-pulses';

export type PulseAnalysisResult =
  | { isSuccessful: true; analysis: PulseResponseAnalysis }
  | { isSuccessful: false; failure: PulseAnalysisFailure };

export interface PulseAnalysisOptions {
  /** Duración de cada bloque de la envolvente. */
  envelopeBinSeconds: number;
  /** Se ignora el principio de la grabación (el dedo que acaba de pulsar el botón). */
  ignoreBeforeSeconds: number;
  /** Tramo inicial de cada pulso que se descarta: el motor tarda en coger velocidad. */
  pulseTrimStartSeconds: number;
  pulseTrimEndSeconds: number;
  minimumPulseSeconds: number;
  minimumPulseCount: number;
  /** El pulso más flojo que se acepta como vibración (m/s² RMS). */
  minimumVibrationRms: number;
  /** La vibración debe superar el fondo al menos este factor. */
  minimumSignalToNoiseRatio: number;
  /** Por debajo no se busca el pico (gravedad, movimientos de la mano, rebotes lentos). */
  minimumPeakFrequencyHz: number;
  maximumFftSize: number;
}

export const defaultPulseAnalysisOptions: PulseAnalysisOptions = {
  envelopeBinSeconds: 0.02,
  ignoreBeforeSeconds: 1,
  pulseTrimStartSeconds: 0.12,
  pulseTrimEndSeconds: 0.04,
  minimumPulseSeconds: 0.25,
  minimumPulseCount: 3,
  minimumVibrationRms: 0.03,
  minimumSignalToNoiseRatio: 4,
  minimumPeakFrequencyHz: 20,
  maximumFftSize: 256,
};

const minimumSamplesPerBin = 3;
const minimumFftSize = 32;

export function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  const position = Math.min(1, Math.max(0, fraction)) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(sortedValues.length - 1, lowerIndex + 1);
  const interpolationFraction = position - lowerIndex;
  return sortedValues[lowerIndex]! + interpolationFraction * (sortedValues[upperIndex]! - sortedValues[lowerIndex]!);
}

export function median(values: readonly number[]): number {
  return percentile([...values].sort((left, right) => left - right), 0.5);
}

/** Desviación típica muestral (n − 1); 0 si hay menos de dos valores. */
export function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const valuesMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squaredDeviationSum = values.reduce((sum, value) => sum + (value - valuesMean) ** 2, 0);
  return Math.sqrt(squaredDeviationSum / (values.length - 1));
}

/**
 * RMS vibratorio de las muestras [firstIndex, endIndex): se resta la media de cada eje (la
 * gravedad, que no cambia si el móvil está quieto) y se suman las varianzas de los tres ejes.
 */
function vibrationRmsBetween(recording: AccelerationRecording, firstIndex: number, endIndex: number): number {
  const sampleCount = endIndex - firstIndex;
  if (sampleCount < 2) return Number.NaN;
  let varianceSum = 0;
  for (const axisValues of [recording.x, recording.y, recording.z]) {
    let axisMean = 0;
    for (let sampleIndex = firstIndex; sampleIndex < endIndex; sampleIndex++) axisMean += axisValues[sampleIndex]!;
    axisMean /= sampleCount;
    let squaredDeviationSum = 0;
    for (let sampleIndex = firstIndex; sampleIndex < endIndex; sampleIndex++) {
      squaredDeviationSum += (axisValues[sampleIndex]! - axisMean) ** 2;
    }
    varianceSum += squaredDeviationSum / sampleCount;
  }
  return Math.sqrt(varianceSum);
}

/** Primer índice con marca de tiempo ≥ `targetSeconds` (las marcas son crecientes). */
function firstIndexAtOrAfter(timestampsSeconds: ArrayLike<number>, targetSeconds: number): number {
  let lowIndex = 0;
  let highIndex = timestampsSeconds.length;
  while (lowIndex < highIndex) {
    const middleIndex = (lowIndex + highIndex) >> 1;
    if (timestampsSeconds[middleIndex]! < targetSeconds) lowIndex = middleIndex + 1;
    else highIndex = middleIndex;
  }
  return lowIndex;
}

interface EnvelopeBin {
  startSeconds: number;
  rms: number;
}

function computeEnvelope(recording: AccelerationRecording, startSeconds: number, binSeconds: number): EnvelopeBin[] {
  const { timestampsSeconds } = recording;
  const lastTimestamp = timestampsSeconds[timestampsSeconds.length - 1]!;
  const envelopeBins: EnvelopeBin[] = [];
  let binStartIndex = firstIndexAtOrAfter(timestampsSeconds, startSeconds);
  for (let binStartSeconds = startSeconds; binStartSeconds < lastTimestamp; binStartSeconds += binSeconds) {
    const binEndIndex = firstIndexAtOrAfter(timestampsSeconds, binStartSeconds + binSeconds);
    const rms =
      binEndIndex - binStartIndex >= minimumSamplesPerBin
        ? vibrationRmsBetween(recording, binStartIndex, binEndIndex)
        : Number.NaN;
    envelopeBins.push({ startSeconds: binStartSeconds, rms });
    binStartIndex = binEndIndex;
  }
  return envelopeBins;
}

/**
 * Tramos seguidos por encima del umbral. Un bloque sin datos o un único bloque por debajo
 * dentro de un pulso no lo corta (huecos del sensor).
 */
function findActiveSegments(envelopeBins: readonly EnvelopeBin[], threshold: number, binSeconds: number) {
  const activeSegments: { startSeconds: number; endSeconds: number }[] = [];
  let segmentStartIndex = -1;
  let lastActiveIndex = -1;
  const closeSegment = () => {
    if (segmentStartIndex >= 0) {
      activeSegments.push({
        startSeconds: envelopeBins[segmentStartIndex]!.startSeconds,
        endSeconds: envelopeBins[lastActiveIndex]!.startSeconds + binSeconds,
      });
    }
    segmentStartIndex = -1;
  };
  for (let binIndex = 0; binIndex < envelopeBins.length; binIndex++) {
    const binRms = envelopeBins[binIndex]!.rms;
    if (binRms > threshold) {
      if (segmentStartIndex < 0) segmentStartIndex = binIndex;
      lastActiveIndex = binIndex;
    } else if (segmentStartIndex >= 0 && binIndex - lastActiveIndex > 1) {
      closeSegment();
    }
  }
  closeSegment();
  return activeSegments;
}

function largestPowerOfTwoAtMost(limit: number): number {
  let powerOfTwo = 1;
  while (powerOfTwo * 2 <= limit) powerOfTwo *= 2;
  return powerOfTwo;
}

export function analyzePulseResponse(
  recording: AccelerationRecording,
  options: Partial<PulseAnalysisOptions> = {},
): PulseAnalysisResult {
  const settings = { ...defaultPulseAnalysisOptions, ...options };
  const { timestampsSeconds } = recording;
  if (timestampsSeconds.length < 50) return { isSuccessful: false, failure: 'too-few-samples' };
  const sampleRateHz = estimateSampleRateHz(timestampsSeconds);
  if (!sampleRateHz) return { isSuccessful: false, failure: 'too-few-samples' };

  const analysisStartSeconds = timestampsSeconds[0]! + settings.ignoreBeforeSeconds;
  const envelopeBins = computeEnvelope(recording, analysisStartSeconds, settings.envelopeBinSeconds);
  const sortedBinLevels = envelopeBins
    .map((envelopeBin) => envelopeBin.rms)
    .filter((binRms) => Number.isFinite(binRms))
    .sort((left, right) => left - right);
  if (sortedBinLevels.length < 10) return { isSuccessful: false, failure: 'too-few-samples' };

  const noiseRms = percentile(sortedBinLevels, 0.15);
  const vibrationLevel = percentile(sortedBinLevels, 0.9);
  if (
    vibrationLevel < settings.minimumVibrationRms ||
    vibrationLevel < settings.minimumSignalToNoiseRatio * Math.max(noiseRms, 1e-6)
  ) {
    return { isSuccessful: false, failure: 'no-vibration-detected' };
  }
  const activityThreshold = noiseRms + 0.3 * (vibrationLevel - noiseRms);

  const analysisWindows = findActiveSegments(envelopeBins, activityThreshold, settings.envelopeBinSeconds)
    .filter((segment) => segment.endSeconds - segment.startSeconds >= settings.minimumPulseSeconds)
    .map((segment) => ({
      startSeconds: segment.startSeconds + settings.pulseTrimStartSeconds,
      endSeconds: segment.endSeconds - settings.pulseTrimEndSeconds,
    }))
    .map((analysisWindow) => ({
      ...analysisWindow,
      firstIndex: firstIndexAtOrAfter(timestampsSeconds, analysisWindow.startSeconds),
      endIndex: firstIndexAtOrAfter(timestampsSeconds, analysisWindow.endSeconds),
    }))
    .filter((analysisWindow) => analysisWindow.endIndex - analysisWindow.firstIndex >= minimumFftSize / 2);
  if (analysisWindows.length < settings.minimumPulseCount) return { isSuccessful: false, failure: 'too-few-pulses' };

  // Un tamaño de FFT común para todos los pulsos, para poder promediar sus espectros.
  const shortestWindowSampleCount = Math.min(
    ...analysisWindows.map((analysisWindow) =>
      Math.floor((analysisWindow.endSeconds - analysisWindow.startSeconds) * sampleRateHz),
    ),
  );
  // Margen de unas muestras: el remuestreo puede dar alguna menos que la duración × frecuencia.
  const fftSize = Math.min(settings.maximumFftSize, largestPowerOfTwoAtMost(shortestWindowSampleCount - 4));
  const canComputeSpectrum = fftSize >= minimumFftSize;
  const fftPlan = canComputeSpectrum ? createFftPlan(fftSize) : null;
  const hannWindow = canComputeSpectrum ? createWindow('hann', fftSize) : null;
  const spectrumWorkspace = canComputeSpectrum ? createSpectrumWorkspace(fftSize) : null;
  const spectrumAmplitudes = new Float64Array(canComputeSpectrum ? fftSize / 2 + 1 : 0);
  const pulseSpectrumPower = new Float64Array(spectrumAmplitudes.length);

  const pulses: PulseFeatures[] = analysisWindows.map((analysisWindow) => {
    const amplitudeRms = vibrationRmsBetween(recording, analysisWindow.firstIndex, analysisWindow.endIndex);
    let peakFrequencyHz: number | null = null;
    if (fftPlan && hannWindow && spectrumWorkspace) {
      pulseSpectrumPower.fill(0);
      const windowTimestamps = Array.prototype.slice.call(
        timestampsSeconds,
        analysisWindow.firstIndex,
        analysisWindow.endIndex,
      ) as number[];
      for (const axisValues of [recording.x, recording.y, recording.z]) {
        const windowValues = Array.prototype.slice.call(
          axisValues,
          analysisWindow.firstIndex,
          analysisWindow.endIndex,
        ) as number[];
        const { values: uniformValues } = resampleUniformly(windowTimestamps, windowValues, sampleRateHz);
        if (uniformValues.length < fftSize) continue;
        // Se toma el centro del tramo.
        const centeredOffset = Math.floor((uniformValues.length - fftSize) / 2);
        const axisSpectrum = computeAmplitudeSpectrum(
          fftPlan,
          uniformValues.subarray(centeredOffset, centeredOffset + fftSize),
          hannWindow.coefficients,
          hannWindow.coherentGain,
          spectrumWorkspace,
        );
        for (let binIndex = 0; binIndex < axisSpectrum.length; binIndex++) {
          pulseSpectrumPower[binIndex]! += axisSpectrum[binIndex]! ** 2;
        }
      }
      for (let binIndex = 0; binIndex < pulseSpectrumPower.length; binIndex++) {
        const binAmplitude = Math.sqrt(pulseSpectrumPower[binIndex]!);
        pulseSpectrumPower[binIndex] = binAmplitude;
        spectrumAmplitudes[binIndex]! += binAmplitude / analysisWindows.length;
      }
      const dominantFrequency = findDominantFrequency(
        pulseSpectrumPower,
        sampleRateHz,
        fftSize,
        settings.minimumPeakFrequencyHz,
      );
      peakFrequencyHz = dominantFrequency ? dominantFrequency.frequencyHz : null;
    }
    return {
      startSeconds: analysisWindow.startSeconds,
      endSeconds: analysisWindow.endSeconds,
      amplitudeRms,
      peakFrequencyHz,
    };
  });

  const pulseAmplitudes = pulses.map((pulse) => pulse.amplitudeRms);
  const pulseFrequencies = pulses.flatMap((pulse) => (pulse.peakFrequencyHz === null ? [] : [pulse.peakFrequencyHz]));
  const hasFrequencyForEveryPulse = pulseFrequencies.length === pulses.length;

  return {
    isSuccessful: true,
    analysis: {
      sampleRateHz,
      pulses,
      noiseRms,
      amplitudeRms: median(pulseAmplitudes),
      amplitudeSpreadRms: sampleStandardDeviation(pulseAmplitudes),
      peakFrequencyHz: hasFrequencyForEveryPulse ? median(pulseFrequencies) : null,
      peakFrequencySpreadHz: hasFrequencyForEveryPulse ? sampleStandardDeviation(pulseFrequencies) : null,
      spectrumAmplitudes,
      spectrumBinWidthHz: canComputeSpectrum ? sampleRateHz / fftSize : 0,
    },
  };
}

/**
 * Patrón para `Vibration.vibrate` de Android: [espera, encendido, apagado, encendido, …] en ms.
 * El último apagado no hace falta.
 */
export function buildVibrationPattern(
  initialDelayMilliseconds: number,
  pulseCount: number,
  pulseOnMilliseconds: number,
  pulseOffMilliseconds: number,
): number[] {
  const vibrationPattern = [initialDelayMilliseconds];
  for (let pulseIndex = 0; pulseIndex < pulseCount; pulseIndex++) {
    vibrationPattern.push(pulseOnMilliseconds);
    if (pulseIndex < pulseCount - 1) vibrationPattern.push(pulseOffMilliseconds);
  }
  return vibrationPattern;
}

export function vibrationPatternDurationMilliseconds(vibrationPattern: readonly number[]): number {
  return vibrationPattern.reduce((durationSum, patternStep) => durationSum + patternStep, 0);
}
