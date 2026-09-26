import { useCallback, useEffect, useRef, useState } from 'react';

import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';

import { referenceFrequencyHz, type SingDifficulty } from '@instruments/sing-the-note/singGame';
import { useReferenceTone } from '@instruments/sing-the-note/useReferenceTone';
import { useTunerPitch } from '@instruments/traditional-tuner/useTunerPitch';

import {
  advanceEarTraining,
  type EarExerciseKind,
  type EarTrainingState,
  type EarTrainingStep,
  startEarTraining,
} from './earTraining';

const tickMilliseconds = 80;

/** Micrófono + nota de referencia + temporizador, como `useSingGame`, para los ejercicios de oído. */
export function useEarTraining() {
  const [trainingState, setTrainingState] = useState<EarTrainingState>({ phase: 'idle' });
  const isPlaying = trainingState.phase === 'playing';
  const { microphoneStatus, pitchReading, resetPitch } = useTunerPitch({ isActive: isPlaying });
  const { playReferenceTone } = useReferenceTone();
  const isMicrophoneRunning = microphoneStatus.status === 'running';

  if (isPlaying && microphoneStatus.status === 'error') {
    setTrainingState({ phase: 'idle', microphoneErrorMessage: microphoneStatus.errorMessage });
  }

  const sungFrequencyRef = useRef<number | null>(null);
  useEffect(() => {
    sungFrequencyRef.current = pitchReading.stableFrequencyHz;
  }, [pitchReading.stableFrequencyHz]);

  // El reloj solo corre con el micrófono escuchando.
  useEffect(() => {
    if (!isPlaying || !isMicrophoneRunning) return;
    let previousTickTime = Date.now();
    const trainingTimer = setInterval(() => {
      const currentTickTime = Date.now();
      const deltaSeconds = (currentTickTime - previousTickTime) / 1000;
      previousTickTime = currentTickTime;
      setTrainingState((previousState) => advanceEarTraining(previousState, deltaSeconds, sungFrequencyRef.current));
    }, tickMilliseconds);
    return () => clearInterval(trainingTimer);
  }, [isPlaying, isMicrophoneRunning]);

  const currentStepKey = trainingState.phase === 'playing' ? `${trainingState.stepIndex}-${trainingState.stage}` : null;
  const currentStage = trainingState.phase === 'playing' ? trainingState.stage : null;
  const referenceNoteIndex =
    trainingState.phase === 'playing' && trainingState.stage === 'reference'
      ? trainingState.steps[trainingState.stepIndex]!.referenceNoteIndex
      : null;

  useEffect(() => {
    if (!isMicrophoneRunning || currentStage !== 'reference' || referenceNoteIndex === null) return;
    playReferenceTone(referenceFrequencyHz(referenceNoteIndex));
  }, [currentStepKey, currentStage, referenceNoteIndex, isMicrophoneRunning, playReferenceTone]);

  // Al pasar a escuchar se olvida lo que sonó antes (la referencia o la nota anterior de la escala).
  useEffect(() => {
    if (currentStage !== 'listening') return;
    sungFrequencyRef.current = null;
    resetPitch();
  }, [currentStepKey, currentStage, resetPitch]);

  const startTraining = useCallback(
    (exerciseKind: EarExerciseKind, difficulty: SingDifficulty, steps: EarTrainingStep[]) =>
      setTrainingState(startEarTraining(exerciseKind, difficulty, steps)),
    [],
  );
  const stopTraining = useCallback(() => setTrainingState({ phase: 'idle' }), []);
  const stopTrainingInProgress = useCallback(
    () => setTrainingState((previousState) => (previousState.phase === 'playing' ? { phase: 'idle' } : previousState)),
    [],
  );
  const releaseNothing = useCallback(() => undefined, []);
  useStopWhenAppInactive(stopTrainingInProgress, releaseNothing);

  return { trainingState, startTraining, stopTraining, microphoneStatus };
}
