import { advanceSingGame, type SingGameState } from './useSingGame';
import { startRound } from './singGame';

jest.mock('react-native-audio-api', () => ({}));
jest.mock('@instruments/traditional-tuner/useTunerPitch', () => ({}));

function newGame(): SingGameState {
  return {
    phase: 'playing',
    difficulty: 'medium',
    targetNotes: [9, 0],
    roundIndex: 0,
    stage: 'reference',
    stageSeconds: 0,
    roundProgress: startRound(9),
    roundScores: [],
  };
}

function runFor(gameState: SingGameState, seconds: number, frequencyHz: number | null): SingGameState {
  let currentState = gameState;
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.08) {
    currentState = advanceSingGame(currentState, 0.08, frequencyHz);
  }
  return currentState;
}

describe('advanceSingGame', () => {
  it('no escucha mientras suena la referencia (aunque el micrófono la oiga afinada)', () => {
    const gameState = runFor(newGame(), 1.5, 440);
    expect(gameState.phase === 'playing' && gameState.stage).toBe('reference');
    expect(gameState.phase === 'playing' && gameState.roundProgress.heldSeconds).toBe(0);
  });

  it('pasa por referencia → escucha → resultado → siguiente ronda → final', () => {
    let gameState = runFor(newGame(), 1.8, null);
    expect(gameState.phase === 'playing' && gameState.stage).toBe('listening');
    gameState = runFor(gameState, 1.1, 440);
    expect(gameState.phase === 'playing' && gameState.stage).toBe('result');
    expect(gameState.phase === 'playing' && gameState.roundScores[0]!.isHit).toBe(true);
    gameState = runFor(gameState, 1.6, null);
    expect(gameState.phase === 'playing' && gameState.roundIndex).toBe(1);
    expect(gameState.phase === 'playing' && gameState.stage).toBe('reference');
    gameState = runFor(gameState, 1.8 + 8.1 + 1.6, null);
    expect(gameState.phase).toBe('finished');
    if (gameState.phase === 'finished') {
      expect(gameState.summary.hitCount).toBe(1);
      expect(gameState.summary.roundCount).toBe(2);
    }
  });
});
