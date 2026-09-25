import {
  classifyBandReception,
  hardwareTestFrequenciesHz,
  type HardwareBandResult,
  measureBandResult,
  summarizeHardwareTest,
  toneAmplitudeAt,
} from './hardwareTest';

function resultsFromSignalToNoise(signalToNoiseByFrequency: Record<number, number>): HardwareBandResult[] {
  return Object.entries(signalToNoiseByFrequency).map(([frequencyText, signalToNoiseDecibels]) => ({
    frequencyHz: Number(frequencyText),
    signalToNoiseDecibels,
    reception: classifyBandReception(signalToNoiseDecibels),
  }));
}

describe('prueba de hardware', () => {
  it('prueba de 15 a 22 kHz si el muestreo lo permite', () => {
    expect(hardwareTestFrequenciesHz(48000)).toEqual([15000, 16000, 17000, 18000, 19000, 20000, 21000, 22000]);
    expect(hardwareTestFrequenciesHz(44100)).toEqual([15000, 16000, 17000, 18000, 19000, 20000, 21000]);
  });

  it('mide el tono cerca de su bin y calcula la relación señal/ruido', () => {
    const spectrum = new Float64Array(4097);
    // 20 000 Hz a 96 kHz con FFT de 8192 → bin 1706,7; se busca a ±2 bins del redondeo (1707).
    spectrum[1708] = 0.2;
    expect(toneAmplitudeAt(spectrum, 20000, 96000, 8192)).toBe(0.2);
    const bandResult = measureBandResult(20000, 0.1, 0.001);
    expect(bandResult.signalToNoiseDecibels).toBeCloseTo(40);
    expect(bandResult.reception).toBe('good');
    expect(classifyBandReception(10)).toBe('weak');
    expect(classifyBandReception(3)).toBe('none');
  });

  it('recomienda 18–22 kHz si el móvil emite y capta ultrasonidos', () => {
    const summary = summarizeHardwareTest(
      resultsFromSignalToNoise({
        15000: 40,
        16000: 38,
        17000: 36,
        18000: 33,
        19000: 30,
        20000: 25,
        21000: 15,
        22000: 4,
      }),
    );
    expect(summary).toEqual({
      verdict: 'ultrasonicReady',
      recommendedPreset: 'ultrasonic',
      highestGoodFrequencyHz: 20000,
    });
  });

  it('recomienda 16–20 kHz si el altavoz corta hacia 19 kHz', () => {
    const summary = summarizeHardwareTest(
      resultsFromSignalToNoise({ 15000: 40, 16000: 38, 17000: 30, 18000: 22, 19000: 9, 20000: 2, 21000: 0, 22000: 0 }),
    );
    expect(summary.verdict).toBe('nearUltrasonicOnly');
    expect(summary.recommendedPreset).toBe('nearUltrasonic');
    expect(summary.highestGoodFrequencyHz).toBe(18000);
  });

  it('dice que no sirve si no llega nada por encima de 15 kHz', () => {
    const summary = summarizeHardwareTest(
      resultsFromSignalToNoise({ 15000: 12, 16000: 5, 17000: 2, 18000: 0, 19000: 0, 20000: 0, 21000: 0, 22000: 0 }),
    );
    expect(summary).toEqual({ verdict: 'notSupported', recommendedPreset: null, highestGoodFrequencyHz: null });
  });
});
