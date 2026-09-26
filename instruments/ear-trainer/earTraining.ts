import type { NoteIndex } from '@/processing/dsp/musicalNotes';

import {
  advanceRound,
  type GameSummary,
  type RoundProgress,
  type RoundScore,
  scoreRound,
  type SingDifficulty,
  startRound,
  summarizeGame,
} from '@instruments/sing-the-note/singGame';
import { referenceToneSeconds } from '@instruments/sing-the-note/useReferenceTone';

/**
 * Entrena el oído con la voz: se oye una nota de partida y hay que cantar lo que se pide (un
 * intervalo por encima, o una escala entera nota a nota). La app escucha y dice si se acierta.
 * Se acepta cualquier octava, como en «Canta la nota».
 */

export type EarExerciseKind = 'intervals' | 'scales';

export type IntervalId =
  | 'minor-second'
  | 'major-second'
  | 'minor-third'
  | 'major-third'
  | 'perfect-fourth'
  | 'tritone'
  | 'perfect-fifth'
  | 'minor-sixth'
  | 'major-sixth'
  | 'minor-seventh'
  | 'major-seventh';

export const intervalSemitones: Record<IntervalId, number> = {
  'minor-second': 1,
  'major-second': 2,
  'minor-third': 3,
  'major-third': 4,
  'perfect-fourth': 5,
  tritone: 6,
  'perfect-fifth': 7,
  'minor-sixth': 8,
  'major-sixth': 9,
  'minor-seventh': 10,
  'major-seventh': 11,
};

/** Intervalos por nivel: primero los más fáciles de entonar (quinta, cuarta, tercera mayor). */
export const intervalPools: Record<SingDifficulty, readonly IntervalId[]> = {
  easy: ['perfect-fifth', 'perfect-fourth', 'major-third'],
  medium: ['perfect-fifth', 'perfect-fourth', 'major-third', 'minor-third', 'major-second', 'major-sixth'],
  hard: Object.keys(intervalSemitones) as IntervalId[],
};

export type ScaleId = 'major' | 'natural-minor' | 'major-pentatonic' | 'hijaz' | 'phrygian' | 'dorian';

/**
 * Escalas en temperamento igual (semitonos desde la tónica, sin la octava). El hiyaz es la
 * aproximación temperada del maqam; la afinación real usa intervalos que no caben en 12 notas.
 */
export const scaleSemitones: Record<ScaleId, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  'natural-minor': [0, 2, 3, 5, 7, 8, 10],
  'major-pentatonic': [0, 2, 4, 7, 9],
  hijaz: [0, 1, 4, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

/** Notas de partida: las naturales, cómodas para empezar a cantar. */
const rootPool: readonly NoteIndex[] = [0, 2, 4, 5, 7, 9, 11];
export const intervalRoundCount = 10;

export interface EarTrainingStep {
  /** Nota que suena antes del paso, o null si se encadena con el anterior (escalas). */
  referenceNoteIndex: NoteIndex | null;
  targetNoteIndex: NoteIndex;
  /** Qué se pide: un intervalo o el grado de la escala (0 = tónica). */
  prompt: { kind: 'interval'; intervalId: IntervalId } | { kind: 'scale-degree'; degreeIndex: number };
}

function transpose(noteIndex: NoteIndex, semitones: number): NoteIndex {
  return ((((noteIndex + semitones) % 12) + 12) % 12) as NoteIndex;
}

export function createIntervalSteps(difficulty: SingDifficulty, nextRandom: () => number): EarTrainingStep[] {
  const intervalPool = intervalPools[difficulty];
  return Array.from({ length: intervalRoundCount }, () => {
    const rootNoteIndex = rootPool[Math.floor(nextRandom() * rootPool.length)]!;
    const intervalId = intervalPool[Math.floor(nextRandom() * intervalPool.length)]!;
    return {
      referenceNoteIndex: rootNoteIndex,
      targetNoteIndex: transpose(rootNoteIndex, intervalSemitones[intervalId]),
      prompt: { kind: 'interval', intervalId },
    };
  });
}

/** La escala entera subiendo y la tónica al final; solo suena la tónica al principio. */
export function createScaleSteps(scaleId: ScaleId, rootNoteIndex: NoteIndex): EarTrainingStep[] {
  const semitones = [...scaleSemitones[scaleId], 12];
  return semitones.map((semitone, degreeIndex) => ({
    referenceNoteIndex: degreeIndex === 0 ? rootNoteIndex : null,
    targetNoteIndex: transpose(rootNoteIndex, semitone),
    prompt: { kind: 'scale-degree', degreeIndex },
  }));
}

// ── Desarrollo del ejercicio ────────────────────────────────────────────────────────────────

/** Tras la nota de referencia se espera a que se apague su eco. */
export const referenceGuardSeconds = 0.6;
/** Pausa tras cada paso: más larga entre intervalos (hay que oír la siguiente nota) que en escalas. */
const resultSecondsByKind: Record<EarExerciseKind, number> = { intervals: 1.5, scales: 0.5 };
/** Tras un fallo suena la nota correcta: la pausa dura al menos lo que ella y su eco. */
const missedResultSeconds = referenceToneSeconds + referenceGuardSeconds;

function resultSecondsFor(exerciseKind: EarExerciseKind, outcome: RoundProgress['outcome']): number {
  const resultSeconds = resultSecondsByKind[exerciseKind];
  return outcome === 'missed' ? Math.max(resultSeconds, missedResultSeconds) : resultSeconds;
}

export type EarStepScore = RoundScore & { isHit: boolean; step: EarTrainingStep };

export type EarTrainingState =
  | { phase: 'idle'; microphoneErrorMessage?: string }
  | {
      phase: 'playing';
      exerciseKind: EarExerciseKind;
      difficulty: SingDifficulty;
      steps: EarTrainingStep[];
      stepIndex: number;
      stage: 'reference' | 'listening' | 'result';
      stageSeconds: number;
      roundProgress: RoundProgress;
      stepScores: EarStepScore[];
    }
  | {
      phase: 'finished';
      exerciseKind: EarExerciseKind;
      difficulty: SingDifficulty;
      summary: GameSummary;
      stepScores: EarStepScore[];
    };

function stageForStep(step: EarTrainingStep): 'reference' | 'listening' {
  return step.referenceNoteIndex === null ? 'listening' : 'reference';
}

export function startEarTraining(
  exerciseKind: EarExerciseKind,
  difficulty: SingDifficulty,
  steps: EarTrainingStep[],
): EarTrainingState {
  return {
    phase: 'playing',
    exerciseKind,
    difficulty,
    steps,
    stepIndex: 0,
    stage: stageForStep(steps[0]!),
    stageSeconds: 0,
    roundProgress: startRound(steps[0]!.targetNoteIndex),
    stepScores: [],
  };
}

/** Un paso del temporizador: pura, como `advanceSingGame`. */
export function advanceEarTraining(
  trainingState: EarTrainingState,
  deltaSeconds: number,
  sungFrequencyHz: number | null,
): EarTrainingState {
  if (trainingState.phase !== 'playing') return trainingState;
  const stageSeconds = trainingState.stageSeconds + deltaSeconds;
  switch (trainingState.stage) {
    case 'reference':
      if (stageSeconds < referenceToneSeconds + referenceGuardSeconds) return { ...trainingState, stageSeconds };
      return { ...trainingState, stage: 'listening', stageSeconds: 0 };
    case 'listening': {
      const roundProgress = advanceRound(
        trainingState.roundProgress,
        sungFrequencyHz,
        deltaSeconds,
        trainingState.difficulty,
      );
      if (roundProgress.outcome === 'playing') return { ...trainingState, stageSeconds, roundProgress };
      return {
        ...trainingState,
        stage: 'result',
        stageSeconds: 0,
        roundProgress,
        stepScores: [
          ...trainingState.stepScores,
          {
            ...scoreRound(roundProgress, trainingState.difficulty),
            isHit: roundProgress.outcome === 'hit',
            step: trainingState.steps[trainingState.stepIndex]!,
          },
        ],
      };
    }
    case 'result': {
      const resultSeconds = resultSecondsFor(trainingState.exerciseKind, trainingState.roundProgress.outcome);
      if (stageSeconds < resultSeconds) return { ...trainingState, stageSeconds };
      const nextStepIndex = trainingState.stepIndex + 1;
      if (nextStepIndex >= trainingState.steps.length) {
        return {
          phase: 'finished',
          exerciseKind: trainingState.exerciseKind,
          difficulty: trainingState.difficulty,
          summary: summarizeGame(trainingState.stepScores),
          stepScores: trainingState.stepScores,
        };
      }
      const nextStep = trainingState.steps[nextStepIndex]!;
      return {
        ...trainingState,
        stepIndex: nextStepIndex,
        stage: stageForStep(nextStep),
        stageSeconds: 0,
        roundProgress: startRound(nextStep.targetNoteIndex),
      };
    }
  }
}
