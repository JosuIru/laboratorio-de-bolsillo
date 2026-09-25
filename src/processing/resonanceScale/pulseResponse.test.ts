import {
  analyzePulseResponse,
  buildVibrationPattern,
  median,
  percentile,
  sampleStandardDeviation,
  vibrationPatternDurationMilliseconds,
} from './pulseResponse';
import { createSyntheticPulseRecording, expectedVibrationRms } from './syntheticRecording';

describe('estadística básica', () => {
  it('calcula percentiles, mediana y desviación típica', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 10], 0.25)).toBeCloseTo(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(sampleStandardDeviation([3])).toBe(0);
  });
});

describe('analyzePulseResponse', () => {
  it('encuentra los seis pulsos y mide su amplitud y la frecuencia del motor', () => {
    const recording = createSyntheticPulseRecording({ vibrationAmplitude: 2, motorFrequencyHz: 170 });
    const pulseResult = analyzePulseResponse(recording);
    if (!pulseResult.isSuccessful) throw new Error(pulseResult.failure);
    const { analysis } = pulseResult;
    expect(analysis.pulses).toHaveLength(6);
    expect(analysis.sampleRateHz).toBeGreaterThan(400);
    expect(analysis.sampleRateHz).toBeLessThan(440);
    expect(analysis.amplitudeRms).toBeCloseTo(expectedVibrationRms(2), 1);
    expect(analysis.amplitudeSpreadRms / analysis.amplitudeRms).toBeLessThan(0.02);
    expect(analysis.peakFrequencyHz).not.toBeNull();
    expect(Math.abs(analysis.peakFrequencyHz! - 170)).toBeLessThan(3);
    expect(analysis.noiseRms).toBeLessThan(0.1);
    // Los pulsos se detectan donde están: el primero empieza hacia 1,5 s tras la primera muestra.
    const firstPulseStart = analysis.pulses[0]!.startSeconds - recording.timestampsSeconds[0]!;
    expect(firstPulseStart).toBeGreaterThan(1.5);
    expect(firstPulseStart).toBeLessThan(1.75);
  });

  it('la amplitud medida es proporcional a la real', () => {
    const measureAmplitude = (vibrationAmplitude: number) => {
      const pulseResult = analyzePulseResponse(createSyntheticPulseRecording({ vibrationAmplitude }));
      if (!pulseResult.isSuccessful) throw new Error(pulseResult.failure);
      return pulseResult.analysis.amplitudeRms;
    };
    expect(measureAmplitude(1) / measureAmplitude(2)).toBeCloseTo(0.5, 2);
  });

  it('da la frecuencia aparente (alias) si el motor pasa de Nyquist', () => {
    const pulseResult = analyzePulseResponse(
      createSyntheticPulseRecording({ sampleRateHz: 400, motorFrequencyHz: 230 }),
    );
    if (!pulseResult.isSuccessful) throw new Error(pulseResult.failure);
    // 230 Hz muestreados a ~400 Hz aparecen hacia 170 Hz; la amplitud no cambia.
    expect(Math.abs(pulseResult.analysis.peakFrequencyHz! - 170)).toBeLessThan(4);
    expect(pulseResult.analysis.amplitudeRms).toBeCloseTo(expectedVibrationRms(2), 1);
  });

  it('refleja la dispersión entre pulsos', () => {
    const pulseResult = analyzePulseResponse(createSyntheticPulseRecording({ pulseAmplitudeJitter: 0.1, seed: 3 }));
    if (!pulseResult.isSuccessful) throw new Error(pulseResult.failure);
    expect(pulseResult.analysis.amplitudeSpreadRms / pulseResult.analysis.amplitudeRms).toBeGreaterThan(0.02);
  });

  it('avisa si el motor no ha vibrado', () => {
    const silentRecording = createSyntheticPulseRecording({ vibrationAmplitude: 0 });
    expect(analyzePulseResponse(silentRecording)).toEqual({ isSuccessful: false, failure: 'no-vibration-detected' });
  });

  it('avisa si hay pocas muestras o pocos pulsos', () => {
    const shortRecording = { timestampsSeconds: [0, 0.01], x: [0, 0], y: [0, 0], z: [9.8, 9.8] };
    expect(analyzePulseResponse(shortRecording)).toEqual({ isSuccessful: false, failure: 'too-few-samples' });
    expect(analyzePulseResponse(createSyntheticPulseRecording({ pulseCount: 2 }))).toEqual({
      isSuccessful: false,
      failure: 'too-few-pulses',
    });
  });

  it('no confunde un golpe breve al principio con un pulso', () => {
    const recording = createSyntheticPulseRecording();
    const xValues = recording.x;
    // Golpe de 30 ms nada más empezar a contar (a 1,1 s).
    recording.timestampsSeconds.forEach((timestamp, sampleIndex) => {
      const elapsedSeconds = timestamp - recording.timestampsSeconds[0]!;
      if (elapsedSeconds > 1.1 && elapsedSeconds < 1.13) xValues[sampleIndex]! += 6 * Math.sin(sampleIndex);
    });
    const pulseResult = analyzePulseResponse(recording);
    if (!pulseResult.isSuccessful) throw new Error(pulseResult.failure);
    expect(pulseResult.analysis.pulses).toHaveLength(6);
  });
});

describe('patrón de vibración', () => {
  it('alterna encendido y apagado tras la espera inicial', () => {
    const vibrationPattern = buildVibrationPattern(1500, 3, 500, 400);
    expect(vibrationPattern).toEqual([1500, 500, 400, 500, 400, 500]);
    expect(vibrationPatternDurationMilliseconds(vibrationPattern)).toBe(3800);
  });
});
