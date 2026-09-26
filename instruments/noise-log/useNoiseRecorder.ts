import { useCallback, useRef, useState } from 'react';

import { useMicrophoneSpectrum } from '@/core/audio/useMicrophoneSpectrum';
import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';

import { createNoiseSessionLog, type NoiseSessionLog } from './noiseSession';
import { createSpectrumLevelMeter } from './soundLevels';

/**
 * 8192 muestras son ≈0,17 s a 48 kHz: con una trama cada 125 ms las ventanas se solapan y no
 * queda ningún hueco sin medir. La resolución (≈6 Hz) basta para ponderar bien los graves.
 */
const analyserFftSize = 8192;
const frameIntervalMilliseconds = 125;
/** La pantalla se refresca una vez por segundo: el registro puede durar horas. */
const displayRefreshMilliseconds = 1000;

export type NoiseRecorderPhase = 'idle' | 'recording' | 'stopped';

/**
 * Mide el nivel ponderado A con el micrófono y lo va apuntando en un registro de sesión.
 * Solo se calculan niveles: el audio no se guarda en ningún sitio.
 * `calibrationOffsetDecibels` (null sin calibrar: niveles en dBFS) se fija al empezar cada sesión.
 */
export function useNoiseRecorder(calibrationOffsetDecibels: number | null) {
  const [recorderPhase, setRecorderPhase] = useState<NoiseRecorderPhase>('idle');
  const [wasInterrupted, setWasInterrupted] = useState(false);
  const [displayRevision, setDisplayRevision] = useState(0);
  const [sessionLog, setSessionLog] = useState<NoiseSessionLog | null>(null);
  const [sessionOffsetDecibels, setSessionOffsetDecibels] = useState<number | null>(calibrationOffsetDecibels);
  const sessionLogRef = useRef<NoiseSessionLog | null>(null);
  const levelMeterRef = useRef<{ sampleRateHz: number; measure: ReturnType<typeof createSpectrumLevelMeter> } | null>(null);
  const lastDisplayRefreshRef = useRef(0);
  /** Último nivel de ventana corta, para la cifra en directo (se refresca con la pantalla). */
  const [latestLevelDecibels, setLatestLevelDecibels] = useState<number | null>(null);

  const isRecording = recorderPhase === 'recording';
  useKeepScreenOnWhile(isRecording, 'noise-log');

  const microphoneStatus = useMicrophoneSpectrum({
    isActive: isRecording,
    fftSize: analyserFftSize,
    frameIntervalMilliseconds,
    onFrame({ decibelSpectrum, sampleRateHz }) {
      const currentLog = sessionLogRef.current;
      // Tras pulsar Detener aún puede llegar alguna trama antes de que se cierre el micrófono.
      if (!currentLog || recorderPhase !== 'recording') return;
      if (levelMeterRef.current?.sampleRateHz !== sampleRateHz) {
        levelMeterRef.current = { sampleRateHz, measure: createSpectrumLevelMeter(analyserFftSize, sampleRateHz) };
      }
      const frameTimestamp = Date.now();
      const { aWeightedDecibelsFullScale } = levelMeterRef.current.measure(decibelSpectrum);
      const levelDecibels = aWeightedDecibelsFullScale + (sessionOffsetDecibels ?? 0);
      currentLog.pushShortWindowLevel(frameTimestamp, levelDecibels);
      if (frameTimestamp - lastDisplayRefreshRef.current >= displayRefreshMilliseconds) {
        lastDisplayRefreshRef.current = frameTimestamp;
        setLatestLevelDecibels(levelDecibels);
        setDisplayRevision((previousRevision) => previousRevision + 1);
      }
    },
  });

  function startSession() {
    const newLog = createNoiseSessionLog(Date.now());
    sessionLogRef.current = newLog;
    setLatestLevelDecibels(null);
    setSessionLog(newLog);
    setSessionOffsetDecibels(calibrationOffsetDecibels);
    setWasInterrupted(false);
    setRecorderPhase('recording');
  }

  const finishSession = useCallback(() => {
    sessionLogRef.current?.finish();
  }, []);

  function stopSession() {
    finishSession();
    setRecorderPhase('stopped');
    setDisplayRevision((previousRevision) => previousRevision + 1);
  }

  // Si la app pasa a segundo plano o otra pantalla la tapa, el micrófono se cierra: la sesión
  // se da por terminada (se conservan los datos) y se avisa.
  useStopWhenAppInactive(() => {
    if (recorderPhase !== 'recording') return;
    setRecorderPhase('stopped');
    setWasInterrupted(true);
    setDisplayRevision((previousRevision) => previousRevision + 1);
  }, finishSession);

  return {
    recorderPhase,
    wasInterrupted,
    microphoneStatus,
    sessionLog,
    sessionOffsetDecibels,
    displayRevision,
    latestLevelDecibels,
    startSession,
    stopSession,
  };
}
