import { useEffect, useRef, useState } from 'react';

import { useMicrophoneSpectrum } from '@/core/audio/useMicrophoneSpectrum';
import { accelerometerSource, magnetometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { estimatePitchMcLeod } from '@/processing/dsp/mcleodPitch';

import { octaveAgnosticCentsError } from '@instruments/sing-the-note/singGame';
import { createPitchStabilizer, minimumPitchClarity } from '@instruments/traditional-tuner/tuningSystems';

import { createKnockDetector, detectPhonePose, type LockDefinition, type LockReading } from './escapeLocks';

const microphoneWindowSize = 2048;
const microphoneFrameMilliseconds = 50;
/** Tiempo con el que se fija el campo magnético de referencia al empezar la cerradura. */
const magneticBaselineSeconds = 1;

/**
 * Lee solo los sensores que necesita la cerradura actual y entrega una lectura por trama. El
 * micrófono se abre una vez y de cada trama salen la nota (McLeod) y el nivel (para los golpes).
 */
export function useLockSensors(lockDefinition: LockDefinition | null, isActive: boolean) {
  const needsMicrophone = isActive && (lockDefinition?.kind === 'note' || lockDefinition?.kind === 'knocks');
  const latestReadingRef = useRef<Omit<LockReading, 'nowSeconds' | 'newKnockTimesSeconds'>>({
    noteCentsError: null,
    pose: null,
    magneticDeviationMicrotesla: null,
  });
  const pendingKnockTimesRef = useRef<number[]>([]);
  const [pitchStabilizer] = useState(() => createPitchStabilizer());
  const [knockDetector, setKnockDetector] = useState(() => createKnockDetector());
  const magneticBaselineRef = useRef<{ sum: { x: number; y: number; z: number }; count: number; startSeconds: number } | null>(
    null,
  );

  // Cada cerradura empieza con las lecturas limpias (y su propio campo de referencia).
  useEffect(() => {
    latestReadingRef.current = { noteCentsError: null, pose: null, magneticDeviationMicrotesla: null };
    pendingKnockTimesRef.current = [];
    magneticBaselineRef.current = null;
    pitchStabilizer.reset();
    setKnockDetector(createKnockDetector());
  }, [lockDefinition, isActive, pitchStabilizer]);

  const microphoneStatus = useMicrophoneSpectrum({
    isActive: needsMicrophone,
    fftSize: microphoneWindowSize,
    frameIntervalMilliseconds: microphoneFrameMilliseconds,
    onFrame: ({ timeDomainSamples, sampleRateHz }) => {
      const nowSeconds = Date.now() / 1000;
      let squaredSum = 0;
      for (const sampleValue of timeDomainSamples) squaredSum += sampleValue * sampleValue;
      const levelDecibels = 10 * Math.log10(Math.max(1e-12, squaredSum / timeDomainSamples.length));
      if (lockDefinition?.kind === 'knocks' && knockDetector.push(levelDecibels, nowSeconds)) {
        pendingKnockTimesRef.current.push(nowSeconds);
      }
      if (lockDefinition?.kind === 'note') {
        const pitchEstimate = estimatePitchMcLeod(timeDomainSamples, {
          sampleRateHz,
          minimumFrequencyHz: 70,
          maximumFrequencyHz: 2500,
        });
        const stableFrequencyHz = pitchStabilizer.push(
          pitchEstimate && pitchEstimate.clarity >= minimumPitchClarity ? pitchEstimate.frequencyHz : null,
        );
        latestReadingRef.current.noteCentsError =
          stableFrequencyHz === null ? null : octaveAgnosticCentsError(stableFrequencyHz, lockDefinition.noteIndex);
      }
    },
  });

  useSensorSubscription(
    accelerometerSource,
    ({ value }) => {
      latestReadingRef.current.pose = detectPhonePose(value.x, value.y, value.z);
    },
    { isActive: isActive && lockDefinition?.kind === 'pose', targetRateHz: 20 },
  );

  useSensorSubscription(
    magnetometerSource,
    ({ timestampSeconds, value }) => {
      const magneticBaseline = magneticBaselineRef.current;
      if (!magneticBaseline) {
        magneticBaselineRef.current = { sum: { ...value }, count: 1, startSeconds: timestampSeconds };
        return;
      }
      if (timestampSeconds - magneticBaseline.startSeconds < magneticBaselineSeconds) {
        magneticBaseline.sum.x += value.x;
        magneticBaseline.sum.y += value.y;
        magneticBaseline.sum.z += value.z;
        magneticBaseline.count++;
        return;
      }
      const { sum, count } = magneticBaseline;
      latestReadingRef.current.magneticDeviationMicrotesla = Math.hypot(
        value.x - sum.x / count,
        value.y - sum.y / count,
        value.z - sum.z / count,
      );
    },
    { isActive: isActive && lockDefinition?.kind === 'magnet', targetRateHz: 20 },
  );

  /** Lectura para el temporizador del juego: recoge los golpes nuevos desde la anterior. */
  function takeReading(): LockReading {
    const newKnockTimesSeconds = pendingKnockTimesRef.current;
    pendingKnockTimesRef.current = [];
    return { ...latestReadingRef.current, newKnockTimesSeconds, nowSeconds: Date.now() / 1000 };
  }

  return { takeReading, microphoneStatus };
}
