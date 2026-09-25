import { computeSpectralFlux, createLiveOnsetDetector, detectOnsets, estimateTempo } from './onsets';
import { createSeededRandom, generateNoise, generateTone } from './signalGenerator';

const sampleRateHz = 16000;
const analysisOptions = { frameSize: 512, hopSize: 128 };
/** Media trama más un avance: el margen natural de un detector por tramas. */
const timingToleranceSeconds = 0.03;

/** Palmadas sintéticas: ráfagas de ruido con caída exponencial sobre un fondo suave. */
function createClapRecording(clapTimesSeconds: readonly number[], clapAmplitudes: readonly number[], durationSeconds: number) {
  const recordingSamples = generateNoise({ sampleRateHz, durationSeconds, amplitude: 0.003, seed: 11 });
  const nextRandom = createSeededRandom(23);
  const decayTimeConstantSeconds = 0.015;
  clapTimesSeconds.forEach((clapTimeSeconds, clapIndex) => {
    const clapStartIndex = Math.round(clapTimeSeconds * sampleRateHz);
    const clapLengthSamples = Math.round(0.1 * sampleRateHz);
    for (let offset = 0; offset < clapLengthSamples && clapStartIndex + offset < recordingSamples.length; offset++) {
      const envelope = Math.exp(-offset / sampleRateHz / decayTimeConstantSeconds);
      recordingSamples[clapStartIndex + offset]! += clapAmplitudes[clapIndex]! * envelope * (nextRandom() * 2 - 1);
    }
  });
  return recordingSamples;
}

function expectTimesClose(detectedTimesSeconds: readonly number[], expectedTimesSeconds: readonly number[]) {
  expect(detectedTimesSeconds).toHaveLength(expectedTimesSeconds.length);
  detectedTimesSeconds.forEach((detectedTimeSeconds, timeIndex) => {
    expect(Math.abs(detectedTimeSeconds - expectedTimesSeconds[timeIndex]!)).toBeLessThan(timingToleranceSeconds);
  });
}

describe('computeSpectralFlux', () => {
  it('devuelve una trama por avance y las marcas de tiempo coherentes', () => {
    const spectralFlux = computeSpectralFlux(new Float32Array(512 + 128 * 9), sampleRateHz, analysisOptions);
    expect(spectralFlux.fluxValues).toHaveLength(10);
    expect(spectralFlux.hopSeconds).toBeCloseTo(128 / sampleRateHz, 12);
    expect(spectralFlux.firstFrameCenterSeconds).toBeCloseTo(256 / sampleRateHz, 12);
  });

  it('con audio más corto que una trama no devuelve nada', () => {
    expect(computeSpectralFlux(new Float32Array(100), sampleRateHz, analysisOptions).fluxValues).toHaveLength(0);
  });
});

describe('detectOnsets', () => {
  const clapTimesSeconds = [0.5, 1.0, 1.25, 2.0];

  it('encuentra cada palmada en su instante', () => {
    const recordingSamples = createClapRecording(clapTimesSeconds, [0.5, 0.5, 0.5, 0.5], 2.5);
    expectTimesClose(detectOnsets(recordingSamples, sampleRateHz, analysisOptions), clapTimesSeconds);
  });

  it('no pierde una palmada suave entre palmadas fuertes (compresión logarítmica)', () => {
    const recordingSamples = createClapRecording(clapTimesSeconds, [0.8, 0.05, 0.8, 0.8], 2.5);
    expectTimesClose(detectOnsets(recordingSamples, sampleRateHz, analysisOptions), clapTimesSeconds);
  });

  it('no encuentra golpes en silencio ni en un tono sostenido', () => {
    expect(detectOnsets(new Float32Array(sampleRateHz), sampleRateHz, analysisOptions)).toEqual([]);
    const steadyTone = generateTone({ frequencyHz: 440, sampleRateHz, durationSeconds: 1, amplitude: 0.5 });
    expect(detectOnsets(steadyTone, sampleRateHz, analysisOptions)).toEqual([]);
  });

  it('detecta el comienzo de notas nuevas aunque no haya silencio entre ellas', () => {
    const noteDurationSeconds = 0.4;
    const melodySamples = new Float32Array(
      [262, 330, 392, 523].flatMap((frequencyHz) => [
        ...generateTone({ frequencyHz, sampleRateHz, durationSeconds: noteDurationSeconds, amplitude: 0.4 }),
      ]),
    );
    const detectedTimesSeconds = detectOnsets(melodySamples, sampleRateHz, analysisOptions);
    expectTimesClose(detectedTimesSeconds, [0.4, 0.8, 1.2]);
  });
});

describe('createLiveOnsetDetector', () => {
  it('detecta las palmadas en directo, trama a trama y sin mirar al futuro', () => {
    const clapTimesSeconds = [0.5, 1.0, 1.25, 2.0];
    const recordingSamples = createClapRecording(clapTimesSeconds, [0.5, 0.2, 0.5, 0.5], 2.5);
    const { frameSize, hopSize } = analysisOptions;
    const liveDetector = createLiveOnsetDetector({ sampleRateHz, frameSize });

    const detectedTimesSeconds: number[] = [];
    let previousFrameEnd = 0;
    for (let frameEnd = frameSize; frameEnd <= recordingSamples.length; frameEnd += hopSize) {
      const onsetTimeSeconds = liveDetector.push(recordingSamples.subarray(frameEnd - frameSize, frameEnd), frameEnd - previousFrameEnd);
      previousFrameEnd = frameEnd;
      if (onsetTimeSeconds !== null) detectedTimesSeconds.push(onsetTimeSeconds);
    }
    expectTimesClose(detectedTimesSeconds, clapTimesSeconds);
  });
});

describe('estimateTempo', () => {
  it('estima 120 BPM aunque falte un golpe y haya algo de imprecisión', () => {
    const nextRandom = createSeededRandom(3);
    const beatTimesSeconds = Array.from({ length: 16 }, (_, beatIndex) => beatIndex * 0.5 + (nextRandom() - 0.5) * 0.02).filter(
      (_, beatIndex) => beatIndex !== 7,
    );
    const tempoEstimate = estimateTempo(beatTimesSeconds)!;
    expect(tempoEstimate.beatsPerMinute).toBeGreaterThan(118);
    expect(tempoEstimate.beatsPerMinute).toBeLessThan(122);
    expect(tempoEstimate.confidence).toBe(1);
  });

  it('lleva el tempo al rango pedido doblando o partiendo por la mitad', () => {
    const fastBeatTimesSeconds = Array.from({ length: 10 }, (_, beatIndex) => beatIndex * 0.2);
    expect(estimateTempo(fastBeatTimesSeconds)!.beatsPerMinute).toBeCloseTo(150, 6);
    const slowBeatTimesSeconds = Array.from({ length: 10 }, (_, beatIndex) => beatIndex * 2);
    expect(estimateTempo(slowBeatTimesSeconds)!.beatsPerMinute).toBeCloseTo(60, 6);
  });

  it('da poca confianza a golpes sin pulso', () => {
    const nextRandom = createSeededRandom(9);
    let accumulatedTimeSeconds = 0;
    const irregularTimesSeconds = Array.from({ length: 30 }, () => (accumulatedTimeSeconds += 0.15 + nextRandom() * 0.9));
    expect(estimateTempo(irregularTimesSeconds)!.confidence).toBeLessThan(0.6);
  });

  it('necesita al menos dos golpes y un rango de una octava', () => {
    expect(estimateTempo([1])).toBeNull();
    expect(() => estimateTempo([0, 1], { minimumBeatsPerMinute: 100, maximumBeatsPerMinute: 150 })).toThrow(RangeError);
  });
});
