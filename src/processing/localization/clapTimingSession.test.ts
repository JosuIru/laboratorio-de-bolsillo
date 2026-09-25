import { createClapTimingSession, type ClapTimingState } from './clapTimingSession';
import {
  distanceBetween,
  type PlanePoint,
  pseudorangesFromIntervals,
  solveTdoaPosition,
} from './multilateration';
import { createSyntheticClap, synthesizeRecording } from './syntheticRecordings';

const sampleRateHz = 48000;
const speedOfSound = 343.4;
const syntheticClap = createSyntheticClap(13);

function runSession(recording: Float32Array, chunkLength = 2048): ClapTimingState {
  const session = createClapTimingSession({ sampleRateHz });
  for (let chunkStart = 0; chunkStart < recording.length; chunkStart += chunkLength) {
    session.pushSamples(recording.subarray(chunkStart, chunkStart + chunkLength));
  }
  return session.getState();
}

describe('createClapTimingSession', () => {
  it('mide el intervalo chirrido → palmada y corrige la deriva del reloj', () => {
    const chirpArrivalSeconds = 1.7;
    const clapArrivalSeconds = 2.9;
    const clockDriftPartsPerMillion = 80;
    const recording = synthesizeRecording({
      sampleRateHz,
      durationSeconds: 6,
      recordingStartSeconds: 0.123,
      clockDriftPartsPerMillion,
      chirpArrivals: [
        { arrivalSeconds: chirpArrivalSeconds, amplitude: 0.1 },
        { arrivalSeconds: chirpArrivalSeconds + 0.006, amplitude: 0.06 },
      ],
      clapArrivals: [
        { arrivalSeconds: clapArrivalSeconds, amplitude: 0.3 },
        { arrivalSeconds: clapArrivalSeconds + 0.007, amplitude: 0.15 },
      ],
      syntheticClap,
      noiseAmplitude: 0.004,
      seed: 4,
    });
    const finalState = runSession(recording);
    expect(finalState.phase).toBe('done');
    if (finalState.phase !== 'done') return;
    const { result } = finalState;
    const trueIntervalSeconds = clapArrivalSeconds - chirpArrivalSeconds;
    expect(result.clockDriftPartsPerMillion).not.toBeNull();
    expect(Math.abs(result.clockDriftPartsPerMillion! - clockDriftPartsPerMillion)).toBeLessThan(3);
    // 80 ppm de 1,2 s son ~0,1 ms (3 cm de sonido): la corrección los quita.
    expect(result.uncorrectedIntervalSeconds / result.intervalSeconds - 1).toBeCloseTo(80e-6, 5);
    // El comienzo de la palmada lleva un retraso fijo de pocas muestras que depende de su forma
    // (el mismo en todos los móviles, así que no cambia las diferencias).
    expect(Math.abs(result.intervalSeconds - trueIntervalSeconds)).toBeLessThan(4 / sampleRateHz);
    expect(result.chirpSharpness).toBeGreaterThan(8);
  });

  it('avisa si no hubo palmada', () => {
    const recording = synthesizeRecording({
      sampleRateHz,
      durationSeconds: 5,
      recordingStartSeconds: 0,
      clockDriftPartsPerMillion: 0,
      chirpArrivals: [{ arrivalSeconds: 1, amplitude: 0.1 }],
      clapArrivals: [],
      syntheticClap,
      noiseAmplitude: 0.004,
      seed: 8,
    });
    expect(runSession(recording)).toEqual({ phase: 'failed', reason: 'noClap' });
  });

  it('sigue esperando mientras no suena el chirrido', () => {
    const recording = synthesizeRecording({
      sampleRateHz,
      durationSeconds: 2,
      recordingStartSeconds: 0,
      clockDriftPartsPerMillion: 0,
      chirpArrivals: [],
      clapArrivals: [{ arrivalSeconds: 1, amplitude: 0.5 }],
      syntheticClap,
      noiseAmplitude: 0.004,
      seed: 9,
    });
    expect(runSession(recording)).toEqual({ phase: 'waitingForChirp' });
  });

  it('un salto de audio durante la captura invalida la medida', () => {
    const session = createClapTimingSession({ sampleRateHz });
    const recording = synthesizeRecording({
      sampleRateHz,
      durationSeconds: 1.5,
      recordingStartSeconds: 0,
      clockDriftPartsPerMillion: 0,
      chirpArrivals: [{ arrivalSeconds: 0.8, amplitude: 0.1 }],
      clapArrivals: [],
      syntheticClap,
      noiseAmplitude: 0.004,
      seed: 10,
    });
    session.pushSamples(recording);
    expect(session.getState().phase).toBe('capturing');
    expect(session.reportAudioGap()).toBe(true);
    expect(session.getState()).toEqual({ phase: 'failed', reason: 'audioGap' });
  });
});

describe('de extremo a extremo: cuatro móviles sin relojes sincronizados', () => {
  it('localiza la palmada a pocos centímetros', () => {
    const receiverPositions: PlanePoint[] = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 3 },
      { x: 0, y: 3 },
    ];
    const emitterPosition = receiverPositions[0]!;
    const sourcePosition = { x: 1.9, y: 1.1 };
    const chirpEmissionSeconds = 2;
    const clapSeconds = 3.1;
    const receiverClocks = [
      { recordingStartSeconds: 0.4, clockDriftPartsPerMillion: 0 },
      { recordingStartSeconds: 1.1, clockDriftPartsPerMillion: -45 },
      { recordingStartSeconds: 0.05, clockDriftPartsPerMillion: 70 },
      { recordingStartSeconds: 0.9, clockDriftPartsPerMillion: 20 },
    ];

    const measuredIntervals = receiverPositions.map((receiverPosition, receiverIndex) => {
      const chirpArrivalSeconds = chirpEmissionSeconds + distanceBetween(emitterPosition, receiverPosition) / speedOfSound;
      const clapArrivalSeconds = clapSeconds + distanceBetween(sourcePosition, receiverPosition) / speedOfSound;
      const sourceDistance = distanceBetween(sourcePosition, receiverPosition);
      const recording = synthesizeRecording({
        sampleRateHz,
        durationSeconds: 6.5,
        ...receiverClocks[receiverIndex]!,
        chirpArrivals: [
          { arrivalSeconds: chirpArrivalSeconds, amplitude: 0.3 / (1 + distanceBetween(emitterPosition, receiverPosition)) },
        ],
        clapArrivals: [
          { arrivalSeconds: clapArrivalSeconds, amplitude: 0.5 / (1 + sourceDistance) },
          { arrivalSeconds: clapArrivalSeconds + 0.0045, amplitude: 0.2 / (1 + sourceDistance) },
        ],
        syntheticClap,
        noiseAmplitude: 0.003,
        seed: 100 + receiverIndex,
      });
      const finalState = runSession(recording, 1024 + 512 * receiverIndex);
      if (finalState.phase !== 'done') throw new Error(`Móvil ${receiverIndex}: ${JSON.stringify(finalState)}`);
      return finalState.result.intervalSeconds;
    });

    const solution = solveTdoaPosition({
      receiverPositions,
      pseudorangesMeters: pseudorangesFromIntervals(measuredIntervals, receiverPositions, emitterPosition, speedOfSound),
      rangeStandardDeviationMeters: 0.03,
    });
    expect(solution).not.toBeNull();
    expect(distanceBetween(solution!.position, sourcePosition)).toBeLessThan(0.03);
  });
});
