import { useCallback, useEffect, useRef, useState } from 'react';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';

import { measureRotationVibration, type RotationVibration } from './balancingEngine';

/** Pedimos la máxima frecuencia; el sistema da lo que permite el sensor (100–500 Hz). */
const requestedRateHz = 250;
export const captureSeconds = 6;
/** Se descarta el primer segundo: el móvil aún se está asentando tras tocarlo. */
const settleSeconds = 1;
/** Giro entre 5 Hz (300 rpm) y 90 Hz (5400 rpm): por encima, el acelerómetro no llega. */
export const minimumRotationHz = 5;
export const maximumRotationHz = 90;

export type VibrationCaptureState =
  | { status: 'idle' }
  | { status: 'capturing'; progress: number }
  | { status: 'done'; vibration: RotationVibration }
  | { status: 'failed' };

/** Graba unos segundos del acelerómetro y mide la vibración a la velocidad de giro. */
export function useVibrationCapture() {
  const [captureState, setCaptureState] = useState<VibrationCaptureState>({ status: 'idle' });
  const isCapturing = captureState.status === 'capturing';
  const samplesRef = useRef<{ timestampsSeconds: number[]; x: number[]; y: number[]; z: number[] }>({
    timestampsSeconds: [],
    x: [],
    y: [],
    z: [],
  });
  const expectedFrequencyRef = useRef<number | null>(null);
  const captureStartTimeRef = useRef(0);

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      const capturedSamples = samplesRef.current;
      capturedSamples.timestampsSeconds.push(timestampSeconds);
      capturedSamples.x.push(value.x);
      capturedSamples.y.push(value.y);
      capturedSamples.z.push(value.z);
    },
    { isActive: isCapturing, targetRateHz: requestedRateHz },
  );

  useEffect(() => {
    if (!isCapturing) return;
    const progressTimer = setInterval(() => {
      const elapsedSeconds = (Date.now() - captureStartTimeRef.current) / 1000;
      if (elapsedSeconds < captureSeconds) {
        setCaptureState({ status: 'capturing', progress: elapsedSeconds / captureSeconds });
        return;
      }
      clearInterval(progressTimer);
      const capturedSamples = samplesRef.current;
      const firstTimestamp = capturedSamples.timestampsSeconds[0] ?? 0;
      const firstKeptIndex = capturedSamples.timestampsSeconds.findIndex(
        (timestampSeconds) => timestampSeconds - firstTimestamp >= settleSeconds,
      );
      const keptFrom = Math.max(0, firstKeptIndex);
      const vibration = measureRotationVibration(
        {
          timestampsSeconds: capturedSamples.timestampsSeconds.slice(keptFrom),
          x: capturedSamples.x.slice(keptFrom),
          y: capturedSamples.y.slice(keptFrom),
          z: capturedSamples.z.slice(keptFrom),
        },
        minimumRotationHz,
        maximumRotationHz,
        expectedFrequencyRef.current,
      );
      setCaptureState(vibration ? { status: 'done', vibration } : { status: 'failed' });
    }, 100);
    return () => clearInterval(progressTimer);
  }, [isCapturing]);

  /** `expectedFrequencyHz`: la de la primera pasada, para no confundir el giro con otro pico. */
  const startCapture = useCallback((expectedFrequencyHz: number | null) => {
    samplesRef.current = { timestampsSeconds: [], x: [], y: [], z: [] };
    expectedFrequencyRef.current = expectedFrequencyHz;
    captureStartTimeRef.current = Date.now();
    setCaptureState({ status: 'capturing', progress: 0 });
  }, []);

  const resetCapture = useCallback(() => setCaptureState({ status: 'idle' }), []);
  const releaseNothing = useCallback(() => undefined, []);
  useStopWhenAppInactive(
    () =>
      setCaptureState((previousState) => (previousState.status === 'capturing' ? { status: 'idle' } : previousState)),
    releaseNothing,
  );

  return { captureState, startCapture, resetCapture };
}
