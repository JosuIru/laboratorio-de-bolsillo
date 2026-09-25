import { useCallback, useEffect, useRef, useState } from 'react';

import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import type { NoteIndex } from '@/processing/dsp/musicalNotes';

import { useTunerPitch } from '@instruments/traditional-tuner/useTunerPitch';

import {
  advanceRound,
  chooseTargetNotes,
  type GameSummary,
  referenceFrequencyHz,
  type RoundProgress,
  type RoundScore,
  scoreRound,
  type SingDifficulty,
  startRound,
  summarizeGame,
} from './singGame';
import { referenceToneSeconds, useReferenceTone } from './useReferenceTone';

/** Tras la nota de referencia se espera un poco: que se apague su eco y no cuente como canto. */
const referenceGuardSeconds = 0.5;
const roundResultSeconds = 1.5;
const tickMilliseconds = 80;

export type RoundScoreWithHit = RoundScore & { isHit: boolean; targetNoteIndex: NoteIndex };

export type SingGameState =
  | { phase: 'idle' }
  | {
      phase: 'playing';
      difficulty: SingDifficulty;
      targetNotes: NoteIndex[];
      roundIndex: number;
      stage: 'reference' | 'listening' | 'result';
      stageSeconds: number;
      roundProgress: RoundProgress;
      roundScores: RoundScoreWithHit[];
    }
  | { phase: 'finished'; difficulty: SingDifficulty; summary: GameSummary; roundScores: RoundScoreWithHit[] };

/** Un paso del juego: pura, para que el temporizador solo tenga que llamarla. */
export function advanceSingGame(
  gameState: SingGameState,
  deltaSeconds: number,
  sungFrequencyHz: number | null,
): SingGameState {
  if (gameState.phase !== 'playing') return gameState;
  const stageSeconds = gameState.stageSeconds + deltaSeconds;
  switch (gameState.stage) {
    case 'reference':
      if (stageSeconds < referenceToneSeconds + referenceGuardSeconds) return { ...gameState, stageSeconds };
      return { ...gameState, stage: 'listening', stageSeconds: 0 };
    case 'listening': {
      const roundProgress = advanceRound(gameState.roundProgress, sungFrequencyHz, deltaSeconds, gameState.difficulty);
      if (roundProgress.outcome === 'playing') return { ...gameState, stageSeconds, roundProgress };
      const roundScore = scoreRound(roundProgress, gameState.difficulty);
      return {
        ...gameState,
        stage: 'result',
        stageSeconds: 0,
        roundProgress,
        roundScores: [
          ...gameState.roundScores,
          { ...roundScore, isHit: roundProgress.outcome === 'hit', targetNoteIndex: roundProgress.targetNoteIndex },
        ],
      };
    }
    case 'result': {
      if (stageSeconds < roundResultSeconds) return { ...gameState, stageSeconds };
      const nextRoundIndex = gameState.roundIndex + 1;
      if (nextRoundIndex >= gameState.targetNotes.length) {
        return {
          phase: 'finished',
          difficulty: gameState.difficulty,
          summary: summarizeGame(gameState.roundScores),
          roundScores: gameState.roundScores,
        };
      }
      return {
        ...gameState,
        roundIndex: nextRoundIndex,
        stage: 'reference',
        stageSeconds: 0,
        roundProgress: startRound(gameState.targetNotes[nextRoundIndex]!),
      };
    }
  }
}

export function useSingGame() {
  const [gameState, setGameState] = useState<SingGameState>({ phase: 'idle' });
  const isPlaying = gameState.phase === 'playing';
  const { microphoneStatus, pitchReading } = useTunerPitch({ isActive: isPlaying });
  const { playReferenceTone } = useReferenceTone();

  // El temporizador lee la última frecuencia sin reiniciarse con cada lectura.
  const sungFrequencyRef = useRef<number | null>(null);
  useEffect(() => {
    sungFrequencyRef.current = pitchReading.stableFrequencyHz;
  }, [pitchReading.stableFrequencyHz]);

  useEffect(() => {
    if (!isPlaying) return;
    let previousTickTime = Date.now();
    const gameTimer = setInterval(() => {
      const currentTickTime = Date.now();
      const deltaSeconds = (currentTickTime - previousTickTime) / 1000;
      previousTickTime = currentTickTime;
      setGameState((previousState) => advanceSingGame(previousState, deltaSeconds, sungFrequencyRef.current));
    }, tickMilliseconds);
    return () => clearInterval(gameTimer);
  }, [isPlaying]);

  // Una nota de referencia al empezar cada ronda.
  const referenceRoundKey =
    gameState.phase === 'playing' && gameState.stage === 'reference'
      ? `${gameState.roundIndex}-${gameState.targetNotes[gameState.roundIndex]}`
      : null;
  const targetNoteForReference =
    gameState.phase === 'playing' && gameState.stage === 'reference'
      ? gameState.targetNotes[gameState.roundIndex]!
      : null;
  useEffect(() => {
    if (referenceRoundKey === null || targetNoteForReference === null) return;
    playReferenceTone(referenceFrequencyHz(targetNoteForReference));
  }, [referenceRoundKey, targetNoteForReference, playReferenceTone]);

  const startGame = useCallback((difficulty: SingDifficulty) => {
    const targetNotes = chooseTargetNotes(difficulty, Math.random);
    setGameState({
      phase: 'playing',
      difficulty,
      targetNotes,
      roundIndex: 0,
      stage: 'reference',
      stageSeconds: 0,
      roundProgress: startRound(targetNotes[0]!),
      roundScores: [],
    });
  }, []);

  const stopGame = useCallback(() => setGameState({ phase: 'idle' }), []);
  // En segundo plano el micrófono se cierra: la partida no puede seguir contando rondas.
  const releaseNothing = useCallback(() => undefined, []);
  useStopWhenAppInactive(stopGame, releaseNothing);

  return { gameState, startGame, stopGame, microphoneStatus };
}
