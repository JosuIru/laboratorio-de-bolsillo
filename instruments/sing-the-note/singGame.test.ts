import {
  advanceRound,
  chooseTargetNotes,
  difficultySettings,
  maximumRoundSeconds,
  octaveAgnosticCentsError,
  referenceFrequencyHz,
  type RoundProgress,
  scoreRound,
  startRound,
  summarizeGame,
} from './singGame';

function playFor(
  roundProgress: RoundProgress,
  frequencyHz: number | null,
  seconds: number,
  difficulty: 'easy' | 'medium' | 'hard' = 'medium',
): RoundProgress {
  const stepSeconds = 0.08;
  let currentProgress = roundProgress;
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += stepSeconds) {
    currentProgress = advanceRound(currentProgress, frequencyHz, stepSeconds, difficulty);
  }
  return currentProgress;
}

describe('referenceFrequencyHz y octaveAgnosticCentsError', () => {
  it('La4 = 440 Hz y Do4 ≈ 261,6 Hz', () => {
    expect(referenceFrequencyHz(9)).toBeCloseTo(440, 6);
    expect(referenceFrequencyHz(0)).toBeCloseTo(261.63, 2);
  });

  it('vale cualquier octava', () => {
    expect(octaveAgnosticCentsError(220, 9)).toBeCloseTo(0, 6);
    expect(octaveAgnosticCentsError(1760, 9)).toBeCloseTo(0, 6);
    expect(octaveAgnosticCentsError(440 * 2 ** (20 / 1200), 9)).toBeCloseTo(20, 6);
    expect(octaveAgnosticCentsError(220 * 2 ** (-35 / 1200), 9)).toBeCloseTo(-35, 6);
  });

  it('el error queda entre −600 y 600', () => {
    // Un tritono por encima de La: el borde.
    const tritoneError = octaveAgnosticCentsError(440 * 2 ** (6 / 12), 9);
    expect(Math.abs(tritoneError)).toBeCloseTo(600, 6);
  });
});

describe('chooseTargetNotes', () => {
  it('saca 10 notas del conjunto de la dificultad sin repetir la anterior', () => {
    let seed = 7;
    const nextRandom = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const targetNotes = chooseTargetNotes('easy', nextRandom);
    expect(targetNotes).toHaveLength(10);
    for (const noteIndex of targetNotes) expect(difficultySettings.easy.notePool).toContain(noteIndex);
    for (let noteIndex = 1; noteIndex < targetNotes.length; noteIndex++) {
      expect(targetNotes[noteIndex]).not.toBe(targetNotes[noteIndex - 1]);
    }
  });
});

describe('advanceRound y scoreRound', () => {
  it('acierta al sostener la nota un segundo, y puntúa rapidez y precisión', () => {
    const roundProgress = playFor(startRound(9), 440 * 2 ** (5 / 1200), 1.2);
    expect(roundProgress.outcome).toBe('hit');
    const roundScore = scoreRound(roundProgress, 'medium');
    expect(roundScore.meanAbsoluteCentsError).toBeCloseTo(5, 6);
    expect(roundScore.points).toBeGreaterThan(180);
  });

  it('un desafine corto resta tiempo sostenido pero no lo borra', () => {
    let roundProgress = playFor(startRound(9), 440, 0.64);
    roundProgress = playFor(roundProgress, 440 * 2 ** (100 / 1200), 0.16);
    expect(roundProgress.heldSeconds).toBeCloseTo(0.48, 6);
    expect(roundProgress.outcome).toBe('playing');
  });

  it('fuera de tolerancia no cuenta, y a los 8 s se falla', () => {
    const roundProgress = playFor(startRound(9), 440 * 2 ** (40 / 1200), maximumRoundSeconds + 0.1, 'medium');
    expect(roundProgress.outcome).toBe('missed');
    expect(scoreRound(roundProgress, 'medium').points).toBe(0);
  });

  it('esos 40 ct sí valen en fácil', () => {
    expect(playFor(startRound(9), 440 * 2 ** (40 / 1200), 1.2, 'easy').outcome).toBe('hit');
  });

  it('el silencio no cuenta', () => {
    expect(playFor(startRound(9), null, 2).heldSeconds).toBe(0);
  });
});

describe('summarizeGame', () => {
  it('suma puntos, cuenta aciertos y promedia la desviación de los aciertos', () => {
    const gameSummary = summarizeGame([
      { points: 180, meanAbsoluteCentsError: 10, isHit: true },
      { points: 0, meanAbsoluteCentsError: 40, isHit: false },
      { points: 170, meanAbsoluteCentsError: 20, isHit: true },
    ]);
    expect(gameSummary).toEqual({ totalPoints: 350, hitCount: 2, roundCount: 3, meanAbsoluteCentsError: 15 });
  });
});
