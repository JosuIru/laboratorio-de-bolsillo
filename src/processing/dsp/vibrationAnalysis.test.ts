import { createVibrationAnalyzer } from './vibrationAnalysis';

const gravityMetersPerSecondSquared = 9.80665;

/** Móvil sobre una mesa que vibra a `frequencyHz` en el eje X, con jitter en las marcas de tiempo. */
function simulateVibration(frequencyHz: number, amplitude: number, nominalRateHz: number, sampleCount: number) {
  const timestampsSeconds: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const jitterSeconds = ((sampleIndex * 7919) % 11) * 0.0001;
    const timeSeconds = 1000 + sampleIndex / nominalRateHz + jitterSeconds;
    timestampsSeconds.push(timeSeconds);
    x.push(amplitude * Math.sin(2 * Math.PI * frequencyHz * timeSeconds));
    y.push(0.3 * amplitude * Math.sin(2 * Math.PI * frequencyHz * timeSeconds + 1));
    z.push(gravityMetersPerSecondSquared);
  }
  return { timestampsSeconds, x, y, z };
}

describe('createVibrationAnalyzer', () => {
  const vibrationAnalyzer = createVibrationAnalyzer(512);

  it('encuentra la frecuencia de vibración y quita la gravedad', () => {
    const vibrationAnalysis = vibrationAnalyzer.analyze(simulateVibration(12.5, 0.2, 100, 700));
    expect(vibrationAnalysis).not.toBeNull();
    expect(vibrationAnalysis!.sampleRateHz).toBeCloseTo(100, 0);
    expect(Math.abs(vibrationAnalysis!.dominantFrequencyHz! - 12.5)).toBeLessThan(vibrationAnalysis!.binResolutionHz / 2);
    // Módulo de la vibración combinada de X e Y: 0,2·√(1 + 0,3²) ≈ 0,209 de pico.
    expect(vibrationAnalysis!.peakDynamicAcceleration).toBeGreaterThan(0.18);
    expect(vibrationAnalysis!.peakDynamicAcceleration).toBeLessThan(0.23);
    // La gravedad (9,8 m/s² en Z) no aparece en 0 Hz; solo queda la fuga espectral de la senoidal.
    expect(vibrationAnalysis!.spectrumAmplitudes[0]).toBeLessThan(1e-3);
  });

  it('en reposo no hay vibración', () => {
    const vibrationAnalysis = vibrationAnalyzer.analyze(simulateVibration(10, 0, 100, 600));
    expect(vibrationAnalysis!.rmsDynamicAcceleration).toBeCloseTo(0, 9);
    expect(vibrationAnalysis!.dominantFrequencyHz).toBeNull();
  });

  it('devuelve null mientras no haya muestras suficientes', () => {
    expect(vibrationAnalyzer.analyze(simulateVibration(10, 0.1, 100, 300))).toBeNull();
    expect(vibrationAnalyzer.analyze({ timestampsSeconds: [], x: [], y: [], z: [] })).toBeNull();
  });
});
