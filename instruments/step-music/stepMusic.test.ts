import { generateBar, sixteenthSeconds, stepsPerBar } from './grooveGenerator';
import { cadenceToMusicBpm, compareWithTarget, energyForCadence, estimateCadence } from './stepCadence';

/** Módulo de la aceleración al andar: gravedad + un golpe por paso + ruido. */
function walkingAcceleration(stepsPerMinute: number, seconds: number, sampleRateHz = 100) {
  const stepPeriodSeconds = 60 / stepsPerMinute;
  const sampleCount = Math.round(seconds * sampleRateHz);
  let pseudoRandomState = 7;
  const timestampsSeconds: number[] = [];
  const magnitudes: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const timeSeconds = sampleIndex / sampleRateHz;
    pseudoRandomState = (pseudoRandomState * 1103515245 + 12345) % 2147483648;
    const phase = (timeSeconds % stepPeriodSeconds) / stepPeriodSeconds;
    // Golpe de talón breve y algo de balanceo; la zancada (dos pasos) no es perfectamente simétrica.
    const stepIndex = Math.floor(timeSeconds / stepPeriodSeconds);
    const heelStrike = Math.exp(-((phase - 0.1) ** 2) / 0.004) * (stepIndex % 2 === 0 ? 4 : 3.4);
    timestampsSeconds.push(timeSeconds);
    magnitudes.push(
      9.81 + heelStrike + 0.8 * Math.sin(2 * Math.PI * phase) + (pseudoRandomState / 2147483648 - 0.5) * 0.3,
    );
  }
  return { timestampsSeconds, magnitudes };
}

describe('estimateCadence', () => {
  it.each([95, 120, 165, 180])('encuentra %s pasos/min (y no la zancada)', (stepsPerMinute) => {
    const { timestampsSeconds, magnitudes } = walkingAcceleration(stepsPerMinute, 8);
    const cadenceEstimate = estimateCadence(timestampsSeconds, magnitudes);
    expect(cadenceEstimate).not.toBeNull();
    expect(cadenceEstimate!.stepsPerMinute).toBeGreaterThan(stepsPerMinute * 0.97);
    expect(cadenceEstimate!.stepsPerMinute).toBeLessThan(stepsPerMinute * 1.03);
  });

  it('con el móvil quieto no da cadencia', () => {
    const timestampsSeconds = Array.from({ length: 800 }, (_, sampleIndex) => sampleIndex / 100);
    expect(
      estimateCadence(
        timestampsSeconds,
        timestampsSeconds.map(() => 9.81),
      ),
    ).toBeNull();
  });
});

describe('cadencia → música', () => {
  it('el tempo queda entre 70 y 180', () => {
    expect(cadenceToMusicBpm(120)).toBe(120);
    expect(cadenceToMusicBpm(200)).toBe(100);
    expect(cadenceToMusicBpm(60)).toBe(120);
  });

  it('más cadencia, más energía', () => {
    expect([90, 110, 140, 175].map(energyForCadence)).toEqual([0, 1, 2, 3]);
  });

  it('compara con el objetivo con ±3 % de margen', () => {
    expect(compareWithTarget(170, 170)).toBe('on-pace');
    expect(compareWithTarget(160, 170)).toBe('slower');
    expect(compareWithTarget(180, 170)).toBe('faster');
  });

  it('una semicorchea a 120 bpm dura 125 ms', () => {
    expect(sixteenthSeconds(120)).toBeCloseTo(0.125, 9);
  });
});

describe('generateBar', () => {
  it('siempre hay bombo en 1 y 3 y los golpes caen dentro del compás', () => {
    for (const energy of [0, 1, 2, 3] as const) {
      const grooveEvents = generateBar(5, energy, 42);
      const kickSteps = grooveEvents
        .filter((grooveEvent) => grooveEvent.voice === 'kick')
        .map((grooveEvent) => grooveEvent.stepIndex);
      expect(kickSteps).toEqual(expect.arrayContaining([0, 8]));
      for (const grooveEvent of grooveEvents) {
        expect(grooveEvent.stepIndex).toBeGreaterThanOrEqual(0);
        expect(grooveEvent.stepIndex).toBeLessThan(stepsPerBar);
      }
    }
  });

  it('más energía, más capas; la caja y el arpegio aparecen al subir', () => {
    const calmVoices = new Set(generateBar(0, 0, 1).map((grooveEvent) => grooveEvent.voice));
    const intenseVoices = new Set(generateBar(0, 3, 1).map((grooveEvent) => grooveEvent.voice));
    expect(calmVoices.has('snare')).toBe(false);
    expect(calmVoices.has('lead')).toBe(false);
    expect(intenseVoices.has('snare')).toBe(true);
    expect(intenseVoices.has('lead')).toBe(true);
    expect(generateBar(0, 3, 1).length).toBeGreaterThan(generateBar(0, 0, 1).length);
  });

  it('misma semilla, mismo compás; el cuarto compás lleva redoble', () => {
    expect(generateBar(2, 2, 9)).toEqual(generateBar(2, 2, 9));
    const fillSnares = generateBar(3, 1, 9).filter((grooveEvent) => grooveEvent.voice === 'snare');
    expect(fillSnares.length).toBeGreaterThan(2);
  });
});
