import { referenceFrequencyHz } from '@instruments/sing-the-note/singGame';

import {
  advanceEarTraining,
  createIntervalSteps,
  createScaleSteps,
  type EarTrainingState,
  intervalPools,
  intervalSemitones,
  startEarTraining,
} from './earTraining';

jest.mock('react-native-audio-api', () => ({}));

function seededRandom(seed: number) {
  let generatorState = seed;
  return () => {
    generatorState = (generatorState * 16807) % 2147483647;
    return generatorState / 2147483647;
  };
}

function runFor(trainingState: EarTrainingState, seconds: number, frequencyHz: number | null): EarTrainingState {
  let currentState = trainingState;
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.08) {
    currentState = advanceEarTraining(currentState, 0.08, frequencyHz);
  }
  return currentState;
}

describe('createIntervalSteps', () => {
  it('diez intervalos del nivel, con la nota objetivo a la distancia pedida', () => {
    const intervalSteps = createIntervalSteps('easy', seededRandom(3));
    expect(intervalSteps).toHaveLength(10);
    for (const intervalStep of intervalSteps) {
      if (intervalStep.prompt.kind !== 'interval') throw new Error('se esperaba un intervalo');
      expect(intervalPools.easy).toContain(intervalStep.prompt.intervalId);
      const semitoneDistance = (intervalStep.targetNoteIndex - intervalStep.referenceNoteIndex! + 12) % 12;
      expect(semitoneDistance).toBe(intervalSemitones[intervalStep.prompt.intervalId]);
    }
  });
});

describe('createScaleSteps', () => {
  it('la escala mayor de Re: Re Mi Fa♯ Sol La Si Do♯ Re, y solo suena la tónica', () => {
    const scaleSteps = createScaleSteps('major', 2);
    expect(scaleSteps.map((scaleStep) => scaleStep.targetNoteIndex)).toEqual([2, 4, 6, 7, 9, 11, 1, 2]);
    expect(scaleSteps.map((scaleStep) => scaleStep.referenceNoteIndex)).toEqual([
      2,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('el hiyaz tiene la segunda aumentada característica (de 1 a 4 semitonos)', () => {
    const scaleSteps = createScaleSteps('hijaz', 0);
    expect(scaleSteps.slice(0, 3).map((scaleStep) => scaleStep.targetNoteIndex)).toEqual([0, 1, 4]);
  });
});

describe('advanceEarTraining', () => {
  it('en escalas, tras la tónica se encadenan los grados sin nota de referencia', () => {
    const scaleSteps = createScaleSteps('major-pentatonic', 0);
    let trainingState = startEarTraining('scales', 'medium', scaleSteps);
    expect(trainingState.phase === 'playing' && trainingState.stage).toBe('reference');
    trainingState = runFor(trainingState, 1.9, null);
    expect(trainingState.phase === 'playing' && trainingState.stage).toBe('listening');
    // Canta la tónica (Do) y luego el Re.
    trainingState = runFor(trainingState, 1.1, referenceFrequencyHz(0));
    trainingState = runFor(trainingState, 0.6, null);
    expect(trainingState.phase === 'playing' && trainingState.stepIndex).toBe(1);
    expect(trainingState.phase === 'playing' && trainingState.stage).toBe('listening');
    trainingState = runFor(trainingState, 1.1, referenceFrequencyHz(2));
    expect(trainingState.phase === 'playing' && trainingState.stepScores.map((stepScore) => stepScore.isHit)).toEqual([
      true,
      true,
    ]);
  });

  it('termina con el resumen de aciertos', () => {
    const intervalSteps = createIntervalSteps('easy', seededRandom(5)).slice(0, 1);
    let trainingState = startEarTraining('intervals', 'easy', intervalSteps);
    trainingState = runFor(trainingState, 1.9 + 8.1 + 1.6, null);
    expect(trainingState.phase).toBe('finished');
    if (trainingState.phase === 'finished') expect(trainingState.summary).toMatchObject({ hitCount: 0, roundCount: 1 });
  });
});
