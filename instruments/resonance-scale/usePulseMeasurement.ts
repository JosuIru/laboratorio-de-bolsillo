import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Vibration } from 'react-native';

import { accelerometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import {
  analyzePulseResponse,
  buildVibrationPattern,
  type PulseAnalysisFailure,
  type PulseResponseAnalysis,
  vibrationPatternDurationMilliseconds,
} from '@/processing/resonanceScale/pulseResponse';

/** Tiempo para apartar el dedo del botón antes del primer pulso. */
const initialDelayMilliseconds = 1500;
const pulseCount = 6;
const pulseOnMilliseconds = 500;
const pulseOffMilliseconds = 400;
/** Se sigue grabando un poco tras el último pulso. */
const tailMilliseconds = 300;
/**
 * Se pide la máxima frecuencia (intervalo de 1 ms). Con HIGH_SAMPLING_RATE_SENSORS Android
 * entrega lo que dé el sensor, típicamente 400-500 muestras/s.
 */
const requestedSampleRateHz = 1000;
const progressIntervalMilliseconds = 100;

const vibrationPattern = buildVibrationPattern(
  initialDelayMilliseconds,
  pulseCount,
  pulseOnMilliseconds,
  pulseOffMilliseconds,
);
const totalDurationMilliseconds = vibrationPatternDurationMilliseconds(vibrationPattern) + tailMilliseconds;

export const measurementDurationSeconds = Math.round(totalDurationMilliseconds / 1000);

export type PulseMeasurementState =
  | { status: 'idle' }
  | { status: 'measuring'; progress: number }
  | { status: 'done'; analysis: PulseResponseAnalysis }
  | { status: 'error'; failure: PulseAnalysisFailure };

interface RecordingBuffers {
  startedAt: number;
  timestampsSeconds: number[];
  x: number[];
  y: number[];
  z: number[];
}

/**
 * Hace vibrar el móvil con una serie de pulsos mientras graba el acelerómetro, y analiza la
 * respuesta. El sensor y el motor solo funcionan durante la medida (unos 7 s).
 */
export function usePulseMeasurement({ onMeasured }: { onMeasured(analysis: PulseResponseAnalysis): void }) {
  const notifyMeasured = useEffectEvent(onMeasured);
  const [measurementState, setMeasurementState] = useState<PulseMeasurementState>({ status: 'idle' });
  const recordingBuffers = useRef<RecordingBuffers | null>(null);
  const isMeasuring = measurementState.status === 'measuring';

  useSensorSubscription(
    accelerometerSource,
    ({ timestampSeconds, value }) => {
      const buffers = recordingBuffers.current;
      if (!buffers) return;
      buffers.timestampsSeconds.push(timestampSeconds);
      buffers.x.push(value.x);
      buffers.y.push(value.y);
      buffers.z.push(value.z);
    },
    { isActive: isMeasuring, targetRateHz: requestedSampleRateHz },
  );

  useEffect(() => {
    if (!isMeasuring) return;
    const progressTimer = setInterval(() => {
      const buffers = recordingBuffers.current;
      if (!buffers) return;
      const elapsedMilliseconds = Date.now() - buffers.startedAt;
      if (elapsedMilliseconds < totalDurationMilliseconds) {
        setMeasurementState({ status: 'measuring', progress: elapsedMilliseconds / totalDurationMilliseconds });
        return;
      }
      recordingBuffers.current = null;
      Vibration.cancel();
      const pulseResult = analyzePulseResponse(buffers);
      if (pulseResult.isSuccessful) {
        setMeasurementState({ status: 'done', analysis: pulseResult.analysis });
        notifyMeasured(pulseResult.analysis);
      } else {
        setMeasurementState({ status: 'error', failure: pulseResult.failure });
      }
    }, progressIntervalMilliseconds);
    return () => clearInterval(progressTimer);
  }, [isMeasuring]);

  const startMeasurement = useCallback(() => {
    recordingBuffers.current = { startedAt: Date.now(), timestampsSeconds: [], x: [], y: [], z: [] };
    setMeasurementState({ status: 'measuring', progress: 0 });
    // Android: [espera, encendido, apagado, …]; la espera inicial cubre el arranque del sensor.
    Vibration.vibrate(vibrationPattern);
  }, []);

  const cancelMeasurement = useCallback(() => {
    recordingBuffers.current = null;
    Vibration.cancel();
    setMeasurementState({ status: 'idle' });
  }, []);

  const releaseVibration = useCallback(() => {
    recordingBuffers.current = null;
    Vibration.cancel();
  }, []);
  useStopWhenAppInactive(() => setMeasurementState({ status: 'idle' }), releaseVibration);

  return { measurementState, startMeasurement, cancelMeasurement };
}
