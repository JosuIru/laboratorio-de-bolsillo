import { estimatePitchMcLeod, normalizedSquareDifference } from './mcleodPitch';

const sampleRateHz = 48000;
const windowLength = 4096;

function harmonicTone(frequencyHz: number, harmonicAmplitudes: readonly number[], noiseAmplitude = 0): Float32Array {
  const samples = new Float32Array(windowLength);
  let pseudoRandomState = 12345;
  for (let sampleIndex = 0; sampleIndex < windowLength; sampleIndex++) {
    let sampleValue = 0;
    harmonicAmplitudes.forEach((harmonicAmplitude, harmonicIndex) => {
      sampleValue += harmonicAmplitude * Math.sin((2 * Math.PI * frequencyHz * (harmonicIndex + 1) * sampleIndex) / sampleRateHz);
    });
    pseudoRandomState = (pseudoRandomState * 1103515245 + 12345) % 2147483648;
    sampleValue += noiseAmplitude * (pseudoRandomState / 2147483648 - 0.5);
    samples[sampleIndex] = sampleValue;
  }
  return samples;
}

const detectionOptions = { sampleRateHz, minimumFrequencyHz: 40, maximumFrequencyHz: 2000 };

function centsBetween(measuredHz: number, trueHz: number): number {
  return 1200 * Math.log2(measuredHz / trueHz);
}

describe('normalizedSquareDifference', () => {
  it('vale 1 con retardo 0 y cerca de 1 con un periodo de retardo', () => {
    const nsdfValues = normalizedSquareDifference(harmonicTone(480, [0.5]), 200);
    expect(nsdfValues[0]).toBeCloseTo(1, 6);
    expect(nsdfValues[100]).toBeGreaterThan(0.95);
  });
});

describe('estimatePitchMcLeod', () => {
  it.each([41.2, 49, 55, 110, 196, 440, 523.25, 1318.5])('encuentra %s Hz con error menor de 1 centésima', (trueHz) => {
    const pitchEstimate = estimatePitchMcLeod(harmonicTone(trueHz, [0.4, 0.2, 0.1]), detectionOptions);
    expect(pitchEstimate).not.toBeNull();
    expect(Math.abs(centsBetween(pitchEstimate!.frequencyHz, trueHz))).toBeLessThan(1);
    expect(pitchEstimate!.clarity).toBeGreaterThan(0.9);
  });

  it('no salta a la octava cuando el segundo armónico suena más que la fundamental', () => {
    const pitchEstimate = estimatePitchMcLeod(harmonicTone(220, [0.1, 0.5, 0.2]), detectionOptions);
    expect(Math.abs(centsBetween(pitchEstimate!.frequencyHz, 220))).toBeLessThan(1);
  });

  it('aguanta algo de ruido', () => {
    const pitchEstimate = estimatePitchMcLeod(harmonicTone(330, [0.3, 0.15], 0.1), detectionOptions);
    expect(Math.abs(centsBetween(pitchEstimate!.frequencyHz, 330))).toBeLessThan(3);
  });

  it('devuelve null en silencio', () => {
    expect(estimatePitchMcLeod(new Float32Array(windowLength), detectionOptions)).toBeNull();
  });

  it('da poca claridad con ruido sin tono', () => {
    const pitchEstimate = estimatePitchMcLeod(harmonicTone(440, [0], 0.5), detectionOptions);
    expect(pitchEstimate === null || pitchEstimate.clarity < 0.8).toBe(true);
  });
});
