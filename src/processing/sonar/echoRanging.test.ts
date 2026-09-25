import { createSpectrogramHistory, pushSpectrumRow } from '@/processing/dsp/spectrogram';
import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import { evaluateSonarChirpAt, generateSonarChirp, type SonarChirpSpecification } from './chirp';
import {
  createDistanceColumnMapping,
  createProfileAverager,
  findStrongestEcho,
  interpolatePeak,
  profileToDecibels,
  subtractBackgroundProfile,
} from './echoProfile';
import { computeCorrelationEnvelope, createMatchedFilter } from './matchedFilter';
import { createSonarPulseProcessor, type SonarPulseResult } from './pulseProcessor';
import { distanceToEchoDelaySeconds } from './soundSpeed';

const sampleRateHz = 48000;
const temperatureCelsius = 20;
const chirpSpecification: SonarChirpSpecification = {
  startFrequencyHz: 18000,
  endFrequencyHz: 22000,
  durationSeconds: 0.008,
};
const chirpSamples = generateSonarChirp(chirpSpecification, sampleRateHz);
const pulsePeriodSamples = 7200;

interface SimulatedReflector {
  distanceMeters: number;
  amplitude: number;
}

/**
 * Grabación simulada: cada pulso llega directo del altavoz (con un retardo desconocido que no es
 * un número entero de muestras) y después rebota en cada objeto; encima, ruido blanco.
 */
function simulateRecording(options: {
  pulseCount: number;
  latencySamples: number;
  directAmplitude: number;
  reflectors: readonly SimulatedReflector[];
  noiseAmplitude: number;
  seed: number;
}): Float32Array {
  const { pulseCount, latencySamples, directAmplitude, reflectors, noiseAmplitude, seed } = options;
  const recording = new Float32Array(pulseCount * pulsePeriodSamples + 4000);
  const nextRandom = createSeededRandom(seed);
  const arrivals = [
    { delaySeconds: 0, amplitude: directAmplitude },
    ...reflectors.map((reflector) => ({
      delaySeconds: distanceToEchoDelaySeconds(reflector.distanceMeters, temperatureCelsius),
      amplitude: reflector.amplitude,
    })),
  ];
  for (let sampleIndex = 0; sampleIndex < recording.length; sampleIndex++) {
    let sampleValue = noiseAmplitude * (nextRandom() * 2 - 1);
    const pulseIndex = Math.floor((sampleIndex - latencySamples) / pulsePeriodSamples);
    for (const candidatePulse of [pulseIndex - 1, pulseIndex]) {
      if (candidatePulse < 0 || candidatePulse >= pulseCount) continue;
      const pulseStartSeconds = (latencySamples + candidatePulse * pulsePeriodSamples) / sampleRateHz;
      for (const arrival of arrivals) {
        const elapsedSeconds = sampleIndex / sampleRateHz - pulseStartSeconds - arrival.delaySeconds;
        sampleValue += arrival.amplitude * evaluateSonarChirpAt(chirpSpecification, elapsedSeconds);
      }
    }
    recording[sampleIndex] = sampleValue;
  }
  return recording;
}

function processRecording(recording: Float32Array): SonarPulseResult[] {
  const pulseProcessor = createSonarPulseProcessor({
    sampleRateHz,
    chirpSamples,
    pulsePeriodSamples,
    maximumEchoDelaySeconds: 0.025,
    passbandLowHz: 18000,
    passbandHighHz: 22000,
  });
  const pulseResults: SonarPulseResult[] = [];
  // Bloques como los que entrega el micrófono.
  for (let blockStart = 0; blockStart < recording.length; blockStart += 1024) {
    pulseProcessor.pushSamples(recording.subarray(blockStart, blockStart + 1024), (pulseResult) =>
      pulseResults.push({ ...pulseResult, profile: Float64Array.from(pulseResult.profile) }),
    );
  }
  return pulseResults;
}

const echoSearchOptions = {
  sampleRateHz,
  temperatureCelsius,
  minimumDistanceMeters: 0.2,
  maximumDistanceMeters: 3,
};

describe('filtro adaptado', () => {
  it('da un pico con la amplitud del chirp en el retardo donde empieza', () => {
    const segment = new Float32Array(2000);
    for (let sampleIndex = 0; sampleIndex < chirpSamples.length; sampleIndex++) {
      segment[700 + sampleIndex] = 0.3 * chirpSamples[sampleIndex]!;
    }
    const matchedFilter = createMatchedFilter({
      chirpSamples,
      fftSize: 4096,
      sampleRateHz,
      passbandLowHz: 18000,
      passbandHighHz: 22000,
    });
    const envelope = new Float64Array(4096);
    const validLagCount = computeCorrelationEnvelope(matchedFilter, segment, envelope);
    expect(validLagCount).toBe(2000 - chirpSamples.length + 1);
    let peakIndex = 0;
    for (let lagIndex = 1; lagIndex < validLagCount; lagIndex++)
      if (envelope[lagIndex]! > envelope[peakIndex]!) peakIndex = lagIndex;
    expect(peakIndex).toBe(700);
    expect(interpolatePeak(envelope, peakIndex).amplitude).toBeCloseTo(0.3, 1);
    // Lejos del pulso la correlación es casi nula.
    expect(envelope[1500]!).toBeLessThan(0.01);
  });

  it('el paso banda ignora un tono grave fuerte', () => {
    const segment = new Float32Array(2000);
    for (let sampleIndex = 0; sampleIndex < segment.length; sampleIndex++) {
      segment[sampleIndex] = 0.8 * Math.sin((2 * Math.PI * 1000 * sampleIndex) / sampleRateHz);
    }
    const matchedFilter = createMatchedFilter({
      chirpSamples,
      fftSize: 4096,
      sampleRateHz,
      passbandLowHz: 18000,
      passbandHighHz: 22000,
    });
    const envelope = new Float64Array(4096);
    computeCorrelationEnvelope(matchedFilter, segment, envelope);
    expect(Math.max(...envelope)).toBeLessThan(0.01);
  });
});

describe('sonar de pulsos', () => {
  it('mide un eco a 1 m con ruido y latencia desconocida con error < 2 cm', () => {
    const recording = simulateRecording({
      pulseCount: 8,
      latencySamples: 1234.37,
      directAmplitude: 0.4,
      reflectors: [{ distanceMeters: 1, amplitude: 0.03 }],
      noiseAmplitude: 0.05,
      seed: 7,
    });
    const pulseResults = processRecording(recording);
    expect(pulseResults.length).toBeGreaterThanOrEqual(6);
    for (const pulseResult of pulseResults) {
      expect(pulseResult.isDirectPathDetected).toBe(true);
      const strongestEcho = findStrongestEcho(pulseResult.profile, {
        ...echoSearchOptions,
        directPeakFractionalOffset: pulseResult.directPeakFractionalOffset,
      });
      expect(strongestEcho).not.toBeNull();
      expect(Math.abs(strongestEcho!.distanceMeters - 1)).toBeLessThan(0.02);
    }
    // Los pulsos consecutivos llegan exactamente un periodo después: sigue la pista.
    expect(pulseResults[2]!.directStreamSampleIndex - pulseResults[1]!.directStreamSampleIndex).toBe(
      pulsePeriodSamples,
    );
  });

  it('el promediado de varios pulsos saca un eco débil que un solo pulso no ve', () => {
    const recording = simulateRecording({
      pulseCount: 12,
      latencySamples: 500,
      directAmplitude: 0.4,
      reflectors: [{ distanceMeters: 1.8, amplitude: 0.02 }],
      noiseAmplitude: 0.08,
      seed: 3,
    });
    const pulseResults = processRecording(recording);
    const singlePulseDetections = pulseResults.filter((pulseResult) => {
      const singleEcho = findStrongestEcho(pulseResult.profile, echoSearchOptions);
      return singleEcho !== null && Math.abs(singleEcho.distanceMeters - 1.8) < 0.05;
    });
    expect(singlePulseDetections.length).toBeLessThan(pulseResults.length / 2);

    const profileAverager = createProfileAverager(pulseResults[0]!.profile.length, 8);
    let averagedProfile: Float64Array = new Float64Array(0);
    for (const pulseResult of pulseResults) averagedProfile = profileAverager.push(pulseResult.profile);
    expect(profileAverager.averagedPulseCount).toBe(8);
    const averagedEcho = findStrongestEcho(averagedProfile, echoSearchOptions);
    expect(averagedEcho).not.toBeNull();
    expect(Math.abs(averagedEcho!.distanceMeters - 1.8)).toBeLessThan(0.03);
  });

  it('sin acoplamiento directo lo indica y no inventa ecos', () => {
    const recording = simulateRecording({
      pulseCount: 4,
      latencySamples: 0,
      directAmplitude: 0,
      reflectors: [],
      noiseAmplitude: 0.05,
      seed: 11,
    });
    const pulseResults = processRecording(recording);
    expect(pulseResults.length).toBeGreaterThan(0);
    expect(pulseResults.every((pulseResult) => !pulseResult.isDirectPathDetected)).toBe(true);
    expect(pulseResults.every((pulseResult) => pulseResult.profile.every((profileValue) => profileValue === 0))).toBe(
      true,
    );
  });

  it('la sustracción del fondo deja solo el objeto nuevo', () => {
    const staticReflector = { distanceMeters: 2.2, amplitude: 0.06 };
    const backgroundResults = processRecording(
      simulateRecording({
        pulseCount: 10,
        latencySamples: 321.5,
        directAmplitude: 0.4,
        reflectors: [staticReflector],
        noiseAmplitude: 0.02,
        seed: 5,
      }),
    );
    const profileLength = backgroundResults[0]!.profile.length;
    const backgroundAverager = createProfileAverager(profileLength, 8);
    let backgroundProfile: Float64Array = new Float64Array(0);
    for (const pulseResult of backgroundResults)
      backgroundProfile = Float64Array.from(backgroundAverager.push(pulseResult.profile));

    const sceneResults = processRecording(
      simulateRecording({
        pulseCount: 10,
        latencySamples: 2345.2,
        directAmplitude: 0.4,
        reflectors: [staticReflector, { distanceMeters: 0.75, amplitude: 0.03 }],
        noiseAmplitude: 0.02,
        seed: 9,
      }),
    );
    const sceneAverager = createProfileAverager(profileLength, 8);
    let sceneProfile: Float64Array = new Float64Array(0);
    for (const pulseResult of sceneResults) sceneProfile = sceneAverager.push(pulseResult.profile);

    expect(findStrongestEcho(sceneProfile, echoSearchOptions)!.distanceMeters).toBeCloseTo(2.2, 1);
    const subtractedProfile = subtractBackgroundProfile(
      sceneProfile,
      backgroundProfile,
      new Float64Array(profileLength),
    );
    expect(subtractedProfile.every((profileValue) => profileValue >= 0)).toBe(true);
    const movingEcho = findStrongestEcho(sceneProfile, { ...echoSearchOptions, backgroundProfile });
    expect(Math.abs(movingEcho!.distanceMeters - 0.75)).toBeLessThan(0.03);
    // Claridad razonable: ni al límite del umbral ni disparada por una dispersión nula.
    expect(movingEcho!.signalToNoiseRatio).toBeGreaterThan(10);
    expect(movingEcho!.signalToNoiseRatio).toBeLessThan(1000);

    // Fondo restado y nada nuevo delante: otra grabación del mismo escenario no da ningún eco.
    const emptySceneResults = processRecording(
      simulateRecording({
        pulseCount: 10,
        latencySamples: 987.6,
        directAmplitude: 0.4,
        reflectors: [staticReflector],
        noiseAmplitude: 0.02,
        seed: 13,
      }),
    );
    const emptySceneAverager = createProfileAverager(profileLength, 8);
    let emptySceneProfile: Float64Array = new Float64Array(0);
    for (const pulseResult of emptySceneResults) emptySceneProfile = emptySceneAverager.push(pulseResult.profile);
    expect(findStrongestEcho(emptySceneProfile, { ...echoSearchOptions, backgroundProfile })).toBeNull();
  });
});

describe('perfil de ecos', () => {
  it('subtractBackgroundProfile no baja de cero', () => {
    const output = subtractBackgroundProfile([0.5, 0.1, 0.3], [0.2, 0.4, 0.3], new Float64Array(3));
    expect(Array.from(output)).toEqual([expect.closeTo(0.3), 0, 0]);
  });

  it('findStrongestEcho devuelve null si nada destaca del ruido', () => {
    const flatProfile = new Float64Array(1200).fill(0.01);
    expect(findStrongestEcho(flatProfile, echoSearchOptions)).toBeNull();
  });

  it('el ecograma pone cada eco en la columna de su distancia', () => {
    const profileLength = 1201;
    const columnCount = 60;
    const maximumDistanceMeters = 3;
    const columnMapping = createDistanceColumnMapping(
      columnCount,
      profileLength,
      sampleRateHz,
      temperatureCelsius,
      maximumDistanceMeters,
    );
    expect(columnMapping.firstBinByColumn[0]).toBe(0);
    const profile = new Float64Array(profileLength);
    profile[Math.round(distanceToEchoDelaySeconds(1.5, temperatureCelsius) * sampleRateHz)] = 0.1;
    const history = createSpectrogramHistory(10, columnCount, -80);
    pushSpectrumRow(history, profileToDecibels(profile, new Float64Array(profileLength)), columnMapping);
    const echoColumn = (1.5 / maximumDistanceMeters) * columnCount;
    expect(history.decibelRows[Math.floor(echoColumn)]).toBeCloseTo(-20);
    expect(history.decibelRows[10]).toBe(-80);
  });
});
