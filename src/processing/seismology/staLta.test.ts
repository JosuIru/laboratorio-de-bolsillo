import { createSeededRandom } from '../dsp/signalGenerator';
import { createOnsetDetector, createRecursiveStaLta, type OnsetPick, pickOnsetIndexByAic } from './staLta';

const gravityMetersPerSecondSquared = 9.81;

interface SyntheticRecordingOptions {
  sampleRateHz: number;
  durationSeconds: number;
  /** Instantes de llegada de los golpes. */
  impactTimesSeconds: readonly number[];
  impactAmplitude?: number;
  noiseAmplitude?: number;
  /** Desviación típica del intervalo entre muestras, como fracción del periodo (Android no es regular). */
  timingJitterFraction?: number;
  seed?: number;
}

/**
 * Acelerómetro sobre una mesa: gravedad en z, ruido blanco en los tres ejes y, en cada golpe,
 * una oscilación amortiguada de 90 Hz que empieza exactamente en el instante de llegada.
 */
function createSyntheticRecording(options: SyntheticRecordingOptions) {
  const {
    sampleRateHz,
    durationSeconds,
    impactTimesSeconds,
    impactAmplitude = 0.5,
    noiseAmplitude = 0.01,
    timingJitterFraction = 0,
    seed = 7,
  } = options;
  const nextRandom = createSeededRandom(seed);
  const samples: { timestampSeconds: number; x: number; y: number; z: number }[] = [];
  const nominalPeriodSeconds = 1 / sampleRateHz;
  let timestampSeconds = 100; // El reloj del sensor no empieza en 0.
  const recordingStartSeconds = timestampSeconds;
  while (timestampSeconds - recordingStartSeconds < durationSeconds) {
    const elapsedSeconds = timestampSeconds - recordingStartSeconds;
    let impactSignal = 0;
    for (const impactTimeSeconds of impactTimesSeconds) {
      const sinceImpactSeconds = elapsedSeconds - impactTimeSeconds;
      if (sinceImpactSeconds >= 0) {
        impactSignal += impactAmplitude * Math.exp(-sinceImpactSeconds / 0.05) * Math.sin(2 * Math.PI * 90 * sinceImpactSeconds + 0.6);
      }
    }
    samples.push({
      timestampSeconds,
      x: noiseAmplitude * (nextRandom() * 2 - 1) + 0.4 * impactSignal,
      y: noiseAmplitude * (nextRandom() * 2 - 1) + 0.2 * impactSignal,
      z: gravityMetersPerSecondSquared + noiseAmplitude * (nextRandom() * 2 - 1) + impactSignal,
    });
    const jitterSeconds = timingJitterFraction * nominalPeriodSeconds * (nextRandom() * 2 - 1);
    timestampSeconds += nominalPeriodSeconds + jitterSeconds;
  }
  return { samples, recordingStartSeconds };
}

function runDetector(recording: ReturnType<typeof createSyntheticRecording>, triggerRatio?: number): OnsetPick[] {
  const onsetDetector = createOnsetDetector(triggerRatio ? { triggerRatio } : {});
  const picks: OnsetPick[] = [];
  for (const sample of recording.samples) {
    const pick = onsetDetector.push(sample.timestampSeconds, sample.x, sample.y, sample.z);
    if (pick) picks.push(pick);
  }
  return picks;
}

describe('createRecursiveStaLta', () => {
  it('da un cociente cercano a 1 con ruido estacionario y alto con un salto de energía', () => {
    const staLta = createRecursiveStaLta({ shortWindowSeconds: 0.02, longWindowSeconds: 1 });
    const nextRandom = createSeededRandom(3);
    let ratio = 0;
    for (let sampleIndex = 0; sampleIndex < 400; sampleIndex++) ratio = staLta.push(nextRandom() * 2e-4, 0.005);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(3);
    for (let sampleIndex = 0; sampleIndex < 10; sampleIndex++) ratio = staLta.push(1e-2, 0.005);
    expect(ratio).toBeGreaterThan(10);
    expect(staLta.elapsedSeconds).toBeCloseTo(409 * 0.005, 6);
  });

  it('no deja que la media larga cambie mientras está congelada', () => {
    const staLta = createRecursiveStaLta({ shortWindowSeconds: 0.02, longWindowSeconds: 1 });
    for (let sampleIndex = 0; sampleIndex < 100; sampleIndex++) staLta.push(1, 0.01);
    staLta.setLongTermFrozen(true);
    for (let sampleIndex = 0; sampleIndex < 100; sampleIndex++) staLta.push(50, 0.01);
    expect(staLta.longTermLevel).toBeCloseTo(1, 6);
    expect(staLta.shortTermLevel).toBeCloseTo(50, 3);
  });

  it('respeta el nivel mínimo de la media larga', () => {
    const staLta = createRecursiveStaLta({ shortWindowSeconds: 0.02, longWindowSeconds: 1, minimumLongTermLevel: 1 });
    staLta.push(0, 0.01);
    expect(staLta.push(0.5, 0.01)).toBeLessThan(1);
  });
});

describe('pickOnsetIndexByAic', () => {
  it('encuentra el comienzo exacto de una señal sobre ruido', () => {
    const nextRandom = createSeededRandom(5);
    const onsetIndex = 137;
    const signalValues = Array.from({ length: 220 }, (_, sampleIndex) =>
      sampleIndex < onsetIndex ? 0.01 * (nextRandom() - 0.5) : Math.sin(sampleIndex) * 0.3,
    );
    expect(pickOnsetIndexByAic([signalValues])).toBe(onsetIndex);
  });

  it('combina varios canales aunque el cambio sea más claro en uno', () => {
    const nextRandom = createSeededRandom(9);
    const onsetIndex = 60;
    const quietChannel = Array.from({ length: 120 }, () => 0.01 * (nextRandom() - 0.5));
    const loudChannel = Array.from({ length: 120 }, (_, sampleIndex) =>
      sampleIndex < onsetIndex ? 0.01 * (nextRandom() - 0.5) : 0.5 * (nextRandom() - 0.5),
    );
    expect(pickOnsetIndexByAic([quietChannel, loudChannel])).toBe(onsetIndex);
  });

  it('devuelve null si la ventana es demasiado corta', () => {
    expect(pickOnsetIndexByAic([[1, 2, 3]])).toBeNull();
  });
});

describe('createOnsetDetector', () => {
  it.each([
    { sampleRateHz: 200, timingJitterFraction: 0 },
    { sampleRateHz: 400, timingJitterFraction: 0 },
    { sampleRateHz: 200, timingJitterFraction: 0.2 },
  ])('fija la llegada con un error de una o dos muestras ($sampleRateHz Hz, jitter $timingJitterFraction)', (scenario) => {
    const impactTimeSeconds = 2.3456;
    const recording = createSyntheticRecording({ ...scenario, durationSeconds: 4, impactTimesSeconds: [impactTimeSeconds] });
    const picks = runDetector(recording);
    expect(picks).toHaveLength(1);
    const pickedArrivalSeconds = picks[0]!.onsetTimestampSeconds - recording.recordingStartSeconds;
    const samplePeriodSeconds = 1 / scenario.sampleRateHz;
    // El golpe cae entre dos muestras y, según la fase, la primera muestra de la onda puede ser
    // casi nula: el error es de hasta dos periodos de muestreo, y nunca antes de la llegada real.
    expect(pickedArrivalSeconds).toBeGreaterThanOrEqual(impactTimeSeconds - 0.2 * samplePeriodSeconds);
    expect(pickedArrivalSeconds - impactTimeSeconds).toBeLessThanOrEqual(2.2 * samplePeriodSeconds);
    expect(picks[0]!.onsetTimestampSeconds).toBeLessThanOrEqual(picks[0]!.triggerTimestampSeconds);
    expect(picks[0]!.peakRatio).toBeGreaterThan(8);
  });

  it('da el mismo retraso relativo entre dos golpes que la verdad (base de la sincronización)', () => {
    const syncImpactSeconds = 1.5;
    const quakeImpactSeconds = 4.2173;
    const recording = createSyntheticRecording({
      sampleRateHz: 250,
      durationSeconds: 6,
      impactTimesSeconds: [syncImpactSeconds, quakeImpactSeconds],
      timingJitterFraction: 0.1,
      seed: 21,
    });
    const picks = runDetector(recording);
    expect(picks).toHaveLength(2);
    const measuredIntervalSeconds = picks[1]!.onsetTimestampSeconds - picks[0]!.onsetTimestampSeconds;
    expect(Math.abs(measuredIntervalSeconds - (quakeImpactSeconds - syncImpactSeconds))).toBeLessThan(2 * (1 / 250));
  });

  it('no dispara con ruido de fondo solo', () => {
    const recording = createSyntheticRecording({ sampleRateHz: 200, durationSeconds: 10, impactTimesSeconds: [], seed: 13 });
    expect(runDetector(recording)).toHaveLength(0);
  });

  it('no cuenta la vibración que sigue a un golpe como otro golpe', () => {
    const recording = createSyntheticRecording({
      sampleRateHz: 200,
      durationSeconds: 5,
      impactTimesSeconds: [1.5, 1.62],
      seed: 17,
    });
    expect(runDetector(recording)).toHaveLength(1);
  });

  it('no dispara durante el calentamiento y vuelve a calentar tras un hueco largo', () => {
    const onsetDetector = createOnsetDetector();
    expect(onsetDetector.phase).toBe('warming-up');
    for (let sampleIndex = 0; sampleIndex < 300; sampleIndex++) onsetDetector.push(sampleIndex * 0.005, 0, 0, 9.81);
    expect(onsetDetector.phase).toBe('listening');
    onsetDetector.push(300 * 0.005 + 2, 0, 0, 9.81);
    expect(onsetDetector.phase).toBe('warming-up');
  });

  it('un umbral más alto ignora golpes débiles', () => {
    const recording = createSyntheticRecording({
      sampleRateHz: 200,
      durationSeconds: 4,
      impactTimesSeconds: [2],
      impactAmplitude: 0.03,
      seed: 29,
    });
    expect(runDetector(recording, 4)).toHaveLength(1);
    expect(runDetector(recording, 400)).toHaveLength(0);
  });
});
