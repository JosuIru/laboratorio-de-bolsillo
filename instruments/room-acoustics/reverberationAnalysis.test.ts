import {
  analyzeDecay,
  analyzeRoomResponse,
  describeRoomCharacter,
  midFrequencyReverberationTime,
  preferredReverberationTime,
} from './reverberationAnalysis';

const sampleRateHz = 48000;

function createPseudoRandom(seed: number) {
  let generatorState = seed;
  return () => {
    generatorState = (generatorState * 1103515245 + 12345) % 2147483648;
    return generatorState / 2147483648 - 0.5;
  };
}

/**
 * Sala sintética: 0,3 s de ruido de fondo, un golpe de ruido blanco que decae exponencialmente
 * (−60 dB en `reverberationSeconds`) y el mismo ruido de fondo debajo.
 */
function syntheticRoomResponse(reverberationSeconds: number, noiseAmplitude: number) {
  const nextRandom = createPseudoRandom(2024);
  const preImpulseSamples = Math.round(0.3 * sampleRateHz);
  const totalSamples = preImpulseSamples + Math.round(3 * sampleRateHz);
  const responseSamples = new Float64Array(totalSamples);
  // Amplitud: 60 dB en reverberationSeconds → factor 10^(−3·t/RT).
  for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex++) {
    const secondsAfterImpulse = (sampleIndex - preImpulseSamples) / sampleRateHz;
    const decayingNoise =
      secondsAfterImpulse >= 0 ? 10 ** ((-3 * secondsAfterImpulse) / reverberationSeconds) * nextRandom() : 0;
    responseSamples[sampleIndex] = decayingNoise + noiseAmplitude * nextRandom();
  }
  const noiseSamples = new Float64Array(Math.round(0.5 * sampleRateHz));
  for (let sampleIndex = 0; sampleIndex < noiseSamples.length; sampleIndex++)
    noiseSamples[sampleIndex] = noiseAmplitude * nextRandom();
  return { responseSamples, noiseSamples };
}

describe('analyzeDecay (banda completa)', () => {
  it.each([0.4, 0.8, 1.6])('recupera un RT60 de %s s con T20 y T30', (reverberationSeconds) => {
    const { responseSamples, noiseSamples } = syntheticRoomResponse(reverberationSeconds, 1e-4);
    const decayResult = analyzeDecay(responseSamples, noiseSamples, sampleRateHz);
    expect(decayResult.dynamicRangeDecibels).toBeGreaterThan(60);
    expect(decayResult.t20!.reverberationTimeSeconds).toBeCloseTo(reverberationSeconds, 1);
    expect(decayResult.t30!.reverberationTimeSeconds).toBeCloseTo(reverberationSeconds, 1);
    expect(decayResult.t30!.correlation).toBeGreaterThan(0.99);
  });

  it('sin margen sobre el ruido no da T30 (ni se lo inventa)', () => {
    // Golpe de amplitud 0,5 (≈ −17 dB) sobre ruido de 0,02 (≈ −45 dB): unos 28 dB de margen.
    const { responseSamples, noiseSamples } = syntheticRoomResponse(0.8, 0.02);
    const decayResult = analyzeDecay(responseSamples, noiseSamples, sampleRateHz);
    expect(decayResult.dynamicRangeDecibels).toBeLessThan(40);
    expect(decayResult.t30).toBeNull();
    expect(decayResult.t20).toBeNull();
    expect(decayResult.edt).not.toBeNull();
  });
});

describe('analyzeRoomResponse', () => {
  it('da el mismo RT60 en todas las octavas de una sala uniforme', () => {
    const { responseSamples, noiseSamples } = syntheticRoomResponse(0.7, 1e-4);
    const bandResults = analyzeRoomResponse(responseSamples, noiseSamples, sampleRateHz);
    expect(bandResults.map((bandResult) => bandResult.centerHz)).toEqual([null, 125, 250, 500, 1000, 2000, 4000]);
    for (const bandResult of bandResults) {
      const preferredTime = preferredReverberationTime(bandResult);
      expect(preferredTime).not.toBeNull();
      expect(preferredTime!.decayFit.reverberationTimeSeconds).toBeGreaterThan(0.6);
      expect(preferredTime!.decayFit.reverberationTimeSeconds).toBeLessThan(0.8);
    }
    expect(midFrequencyReverberationTime(bandResults)).toBeCloseTo(0.7, 1);
  });
});

describe('describeRoomCharacter', () => {
  it('clasifica por el tiempo de frecuencias medias', () => {
    expect(describeRoomCharacter(0.2)).toBe('very-dry');
    expect(describeRoomCharacter(0.6)).toBe('balanced');
    expect(describeRoomCharacter(2)).toBe('very-reverberant');
  });
});
