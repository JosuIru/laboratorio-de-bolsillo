import type { NoteIndex } from '@/processing/dsp/musicalNotes';

/**
 * «Canta o silba la nota»: suena una nota y hay que mantenerla afinada un momento. Vale en
 * cualquier octava, porque un silbido suena una o dos octavas por encima de la voz y las voces
 * graves cantan una octava por debajo de las agudas.
 */

export type SingDifficulty = 'easy' | 'medium' | 'hard';

export interface DifficultySettings {
  /** Desviación máxima (en centésimas) para contar como afinado. */
  toleranceCents: number;
  /** Notas que pueden salir: la escala de Do mayor en fácil; las doce en el resto. */
  notePool: readonly NoteIndex[];
}

const naturalNotes: readonly NoteIndex[] = [0, 2, 4, 5, 7, 9, 11];
const allNotes = Array.from({ length: 12 }, (_, noteIndex) => noteIndex as NoteIndex);

export const difficultySettings: Record<SingDifficulty, DifficultySettings> = {
  easy: { toleranceCents: 50, notePool: naturalNotes },
  medium: { toleranceCents: 30, notePool: allNotes },
  hard: { toleranceCents: 15, notePool: allNotes },
};

export const roundsPerGame = 10;
/** Tiempo que hay que sostener la nota afinada para acertar. */
export const requiredHoldSeconds = 1;
/** Tiempo máximo por ronda desde que se empieza a escuchar. */
export const maximumRoundSeconds = 8;
const referenceA4Hz = 440;

/** Frecuencia de la nota de referencia en la octava 4 (Do4 ≈ 262 Hz … Si4 ≈ 494 Hz). */
export function referenceFrequencyHz(noteIndex: NoteIndex): number {
  return referenceA4Hz * 2 ** ((noteIndex - 9) / 12);
}

/** Desviación respecto a la nota objetivo en la octava más cercana, en [−600, 600) centésimas. */
export function octaveAgnosticCentsError(frequencyHz: number, targetNoteIndex: NoteIndex): number {
  const centsFromTarget = 1200 * Math.log2(frequencyHz / referenceFrequencyHz(targetNoteIndex));
  return ((((centsFromTarget + 600) % 1200) + 1200) % 1200) - 600;
}

/**
 * Notas de una partida: al azar del conjunto de la dificultad, sin repetir la anterior.
 * `nextRandom` devuelve valores en [0, 1) (Math.random, o uno con semilla en los tests).
 */
export function chooseTargetNotes(
  difficulty: SingDifficulty,
  nextRandom: () => number,
  roundCount = roundsPerGame,
): NoteIndex[] {
  const { notePool } = difficultySettings[difficulty];
  const targetNotes: NoteIndex[] = [];
  while (targetNotes.length < roundCount) {
    const candidateNote = notePool[Math.floor(nextRandom() * notePool.length)]!;
    if (candidateNote !== targetNotes[targetNotes.length - 1]) targetNotes.push(candidateNote);
  }
  return targetNotes;
}

// ── Ronda ───────────────────────────────────────────────────────────────────────────────────

export interface RoundProgress {
  targetNoteIndex: NoteIndex;
  elapsedSeconds: number;
  /** Tiempo acumulado dentro de la tolerancia (baja despacio al desafinar, no de golpe). */
  heldSeconds: number;
  /** Última desviación medida, o null si no suena nada claro. */
  latestCentsError: number | null;
  /** Suma de |desviación| · tiempo mientras se estaba afinado, para la media. */
  weightedAbsoluteErrorSum: number;
  inTuneSeconds: number;
  outcome: 'playing' | 'hit' | 'missed';
}

export function startRound(targetNoteIndex: NoteIndex): RoundProgress {
  return {
    targetNoteIndex,
    elapsedSeconds: 0,
    heldSeconds: 0,
    latestCentsError: null,
    weightedAbsoluteErrorSum: 0,
    inTuneSeconds: 0,
    outcome: 'playing',
  };
}

/**
 * Avanza la ronda `deltaSeconds` con la frecuencia que suena (null = silencio o ruido). Un
 * desafine corto no borra lo sostenido: lo va restando, para perdonar el vibrato y los golpes
 * de voz.
 */
export function advanceRound(
  roundProgress: RoundProgress,
  frequencyHz: number | null,
  deltaSeconds: number,
  difficulty: SingDifficulty,
): RoundProgress {
  if (roundProgress.outcome !== 'playing') return roundProgress;
  const { toleranceCents } = difficultySettings[difficulty];
  const centsError =
    frequencyHz !== null && frequencyHz > 0
      ? octaveAgnosticCentsError(frequencyHz, roundProgress.targetNoteIndex)
      : null;
  const isInTune = centsError !== null && Math.abs(centsError) <= toleranceCents;
  const heldSeconds = isInTune
    ? roundProgress.heldSeconds + deltaSeconds
    : Math.max(0, roundProgress.heldSeconds - deltaSeconds);
  const elapsedSeconds = roundProgress.elapsedSeconds + deltaSeconds;
  const outcome =
    heldSeconds >= requiredHoldSeconds ? 'hit' : elapsedSeconds >= maximumRoundSeconds ? 'missed' : 'playing';
  return {
    ...roundProgress,
    elapsedSeconds,
    heldSeconds,
    latestCentsError: centsError,
    weightedAbsoluteErrorSum:
      roundProgress.weightedAbsoluteErrorSum + (isInTune ? Math.abs(centsError) * deltaSeconds : 0),
    inTuneSeconds: roundProgress.inTuneSeconds + (isInTune ? deltaSeconds : 0),
    outcome,
  };
}

export interface RoundScore {
  points: number;
  /** Desviación media mientras se estaba afinado; null si nunca se afinó. */
  meanAbsoluteCentsError: number | null;
}

/**
 * 100 por acertar, hasta 50 más por rapidez (acertar en el mínimo posible) y hasta 50 por
 * precisión (desviación media cero). Fallar da 0.
 */
export function scoreRound(roundProgress: RoundProgress, difficulty: SingDifficulty): RoundScore {
  const meanAbsoluteCentsError =
    roundProgress.inTuneSeconds > 0 ? roundProgress.weightedAbsoluteErrorSum / roundProgress.inTuneSeconds : null;
  if (roundProgress.outcome !== 'hit') return { points: 0, meanAbsoluteCentsError };
  const { toleranceCents } = difficultySettings[difficulty];
  const spareSeconds = maximumRoundSeconds - requiredHoldSeconds;
  const speedFraction = Math.max(0, Math.min(1, (maximumRoundSeconds - roundProgress.elapsedSeconds) / spareSeconds));
  const accuracyFraction =
    meanAbsoluteCentsError === null ? 0 : Math.max(0, 1 - meanAbsoluteCentsError / toleranceCents);
  return { points: Math.round(100 + 50 * speedFraction + 50 * accuracyFraction), meanAbsoluteCentsError };
}

export interface GameSummary {
  totalPoints: number;
  hitCount: number;
  roundCount: number;
  /** Media de las desviaciones medias de las rondas acertadas. */
  meanAbsoluteCentsError: number | null;
}

export function summarizeGame(roundScores: readonly (RoundScore & { isHit: boolean })[]): GameSummary {
  const hitRounds = roundScores.filter((roundScore) => roundScore.isHit);
  const hitErrors = hitRounds.flatMap((roundScore) =>
    roundScore.meanAbsoluteCentsError === null ? [] : [roundScore.meanAbsoluteCentsError],
  );
  return {
    totalPoints: roundScores.reduce((pointSum, roundScore) => pointSum + roundScore.points, 0),
    hitCount: hitRounds.length,
    roundCount: roundScores.length,
    meanAbsoluteCentsError:
      hitErrors.length > 0
        ? hitErrors.reduce((errorSum, roundError) => errorSum + roundError, 0) / hitErrors.length
        : null,
  };
}
