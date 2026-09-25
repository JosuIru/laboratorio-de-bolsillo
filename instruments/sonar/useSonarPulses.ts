import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioContext, AudioManager, AudioRecorder, type GainNode } from 'react-native-audio-api';

import { useIsAppActive } from '@/core/useIsAppActive';
import { createSpectrogramHistory, pushSpectrumRow, type SpectrogramHistory } from '@/processing/dsp/spectrogram';
import { createPulsePeriod, generateSonarChirp, type SonarBand } from '@/processing/sonar/chirp';
import {
  createDistanceColumnMapping,
  createProfileAverager,
  findStrongestEcho,
  profileToDecibels,
  type StrongestEcho,
  subtractBackgroundProfile,
} from '@/processing/sonar/echoProfile';
import type { SonarBandPreset } from '@/processing/sonar/hardwareTest';
import { createSonarPulseProcessor, type SonarPulseResult } from '@/processing/sonar/pulseProcessor';

import {
  averagedPulseCount,
  backgroundPulseCount,
  chirpDurationSeconds,
  echogramColumnCount,
  echogramFloorDecibels,
  echogramRowCount,
  maximumEchoDelaySeconds,
  maximumRangeMeters,
  minimumRangeMeters,
  pulsePeriodSeconds,
  sonarBandFor,
} from './sonarConfiguration';

export type SonarPulsesStatus =
  | { status: 'idle' }
  | { status: 'starting' }
  | { status: 'running' }
  /** El micrófono entrega muestras a una frecuencia que no llega a la banda del chirp. */
  | { status: 'inputSampleRateTooLow'; inputSampleRateHz: number }
  | { status: 'error'; errorMessage: string };

export interface SonarSnapshot {
  sampleRateHz: number | null;
  band: SonarBand | null;
  /** `false` si en el último pulso no se oyó el acoplamiento directo (volumen, banda…). */
  isDirectPathDetected: boolean;
  /** Nivel del acoplamiento directo en dBFS (0 = el chirp tal cual salió). */
  directLevelDecibels: number | null;
  strongestEcho: StrongestEcho | null;
  averagedPulseCount: number;
  hasBackground: boolean;
  /** Progreso (0-1) mientras se graba el fondo, o null. */
  backgroundProgress: number | null;
  /** Perfil de la última fila del ecograma (dB por columna, 0 → `maximumRangeMeters`). */
  latestEchogramRow: number[];
  pulseCount: number;
}

const emptySnapshot: SonarSnapshot = {
  sampleRateHz: null,
  band: null,
  isDirectPathDetected: false,
  directLevelDecibels: null,
  strongestEcho: null,
  averagedPulseCount: 0,
  hasBackground: false,
  backgroundProgress: null,
  latestEchogramRow: [],
  pulseCount: 0,
};

interface SonarPulsesOptions {
  isRunning: boolean;
  bandPreset: SonarBandPreset;
  volume: number;
  temperatureCelsius: number;
}

/**
 * Sonar de pulsos: el altavoz repite un chirp ultrasónico en bucle y el micrófono graba a la
 * vez. Cada pulso grabado pasa por el filtro adaptado, se promedia, se le resta el fondo (si se
 * ha grabado) y da la distancia al eco más fuerte y una fila del ecograma.
 * Todo se para al pausar, al salir de la pantalla o al pasar la app a segundo plano.
 */
export function useSonarPulses({ isRunning, bandPreset, volume, temperatureCelsius }: SonarPulsesOptions) {
  const isAppActive = useIsAppActive();
  const shouldRun = isRunning && isAppActive;
  const [pulsesStatus, setPulsesStatus] = useState<SonarPulsesStatus>({ status: 'idle' });
  const [snapshot, setSnapshot] = useState<SonarSnapshot>(emptySnapshot);
  const [echogramHistory] = useState<SpectrogramHistory>(() =>
    createSpectrogramHistory(echogramRowCount, echogramColumnCount, echogramFloorDecibels),
  );

  // El procesado lee estos valores en cada pulso sin reiniciar el audio.
  const temperatureCelsiusRef = useRef(temperatureCelsius);
  const volumeRef = useRef(volume);
  const gainNodeRef = useRef<GainNode | null>(null);
  const backgroundRequestRef = useRef<'none' | 'record' | 'clear'>('none');
  useEffect(() => {
    temperatureCelsiusRef.current = temperatureCelsius;
  }, [temperatureCelsius]);
  useEffect(() => {
    volumeRef.current = volume;
    if (gainNodeRef.current) gainNodeRef.current.gain.value = volume;
  }, [volume]);

  const runKey = `${shouldRun}-${bandPreset}`;
  const [currentRunKey, setCurrentRunKey] = useState<string | null>(null);
  if (currentRunKey !== runKey) {
    setCurrentRunKey(runKey);
    setPulsesStatus(shouldRun ? { status: 'starting' } : { status: 'idle' });
  }

  useEffect(() => {
    if (!shouldRun) return;
    let isCancelled = false;
    const audioContext = new AudioContext();
    const audioRecorder = new AudioRecorder();
    const pulseSource = audioContext.createBufferSource();

    async function startSonar() {
      try {
        AudioManager.setAudioSessionOptions({
          iosCategory: 'playAndRecord',
          iosMode: 'measurement',
          iosOptions: ['defaultToSpeaker'],
        });
        const outputSampleRateHz = audioContext.sampleRate;
        const band = sonarBandFor(outputSampleRateHz, bandPreset);
        const chirpSpecification = {
          startFrequencyHz: band.lowFrequencyHz,
          endFrequencyHz: band.highFrequencyHz,
          durationSeconds: chirpDurationSeconds,
        };
        const outputPeriodSamples = Math.round(pulsePeriodSeconds * outputSampleRateHz);
        const pulsePeriod = createPulsePeriod(
          generateSonarChirp(chirpSpecification, outputSampleRateHz),
          outputPeriodSamples,
        );
        const pulseBuffer = audioContext.createBuffer(1, pulsePeriod.length, outputSampleRateHz);
        // copyToChannel exige un Float32Array respaldado por un ArrayBuffer normal.
        pulseBuffer.copyToChannel(new Float32Array(pulsePeriod), 0);
        pulseSource.buffer = pulseBuffer;
        pulseSource.loop = true;
        const gainNode = audioContext.createGain();
        gainNode.gain.value = volumeRef.current;
        pulseSource.connect(gainNode);
        gainNode.connect(audioContext.destination);
        gainNodeRef.current = gainNode;

        let pulseProcessor: ReturnType<typeof createSonarPulseProcessor> | null = null;
        let inputSampleRateHz = 0;
        let profileAverager: ReturnType<typeof createProfileAverager> | null = null;
        let backgroundAverager: ReturnType<typeof createProfileAverager> | null = null;
        let backgroundProfile: Float64Array | null = null;
        let subtractedProfile = new Float64Array(0);
        let profileDecibels = new Float64Array(0);
        let columnMapping: ReturnType<typeof createDistanceColumnMapping> | null = null;
        let columnMappingTemperatureCelsius = Number.NaN;
        let meanFractionalOffset = 0;
        let pulseCount = 0;

        const handlePulse = (pulseResult: SonarPulseResult) => {
          if (isCancelled || !pulseProcessor || !profileAverager) return;
          pulseCount++;
          const directLevelDecibels =
            pulseResult.directAmplitude > 0 ? 20 * Math.log10(pulseResult.directAmplitude) : null;
          if (!pulseResult.isDirectPathDetected) {
            setSnapshot((previousSnapshot) => ({
              ...previousSnapshot,
              isDirectPathDetected: false,
              directLevelDecibels,
              pulseCount,
            }));
            return;
          }
          if (backgroundRequestRef.current === 'clear') {
            backgroundRequestRef.current = 'none';
            backgroundProfile = null;
            backgroundAverager = null;
          } else if (backgroundRequestRef.current === 'record') {
            backgroundRequestRef.current = 'none';
            backgroundProfile = null;
            backgroundAverager = createProfileAverager(pulseProcessor.profileLength, backgroundPulseCount);
          }

          const averagedProfile = profileAverager.push(pulseResult.profile);
          meanFractionalOffset += 0.25 * (pulseResult.directPeakFractionalOffset - meanFractionalOffset);
          let backgroundProgress: number | null = null;
          if (backgroundAverager) {
            const backgroundAverage = backgroundAverager.push(pulseResult.profile);
            backgroundProgress = backgroundAverager.averagedPulseCount / backgroundPulseCount;
            if (backgroundAverager.averagedPulseCount >= backgroundPulseCount) {
              backgroundProfile = Float64Array.from(backgroundAverage);
              backgroundAverager = null;
              backgroundProgress = null;
            }
          }
          const displayedProfile = backgroundProfile
            ? subtractBackgroundProfile(averagedProfile, backgroundProfile, subtractedProfile)
            : averagedProfile;

          const currentTemperatureCelsius = temperatureCelsiusRef.current;
          const strongestEcho = findStrongestEcho(displayedProfile, {
            sampleRateHz: inputSampleRateHz,
            temperatureCelsius: currentTemperatureCelsius,
            minimumDistanceMeters: minimumRangeMeters,
            maximumDistanceMeters: maximumRangeMeters,
            directPeakFractionalOffset: meanFractionalOffset,
          });
          if (!columnMapping || columnMappingTemperatureCelsius !== currentTemperatureCelsius) {
            columnMapping = createDistanceColumnMapping(
              echogramColumnCount,
              pulseProcessor.profileLength,
              inputSampleRateHz,
              currentTemperatureCelsius,
              maximumRangeMeters,
            );
            columnMappingTemperatureCelsius = currentTemperatureCelsius;
          }
          pushSpectrumRow(
            echogramHistory,
            profileToDecibels(displayedProfile, profileDecibels, echogramFloorDecibels),
            columnMapping,
          );
          const newestRowOffset = echogramHistory.newestRowIndex * echogramColumnCount;
          const latestEchogramRow = Array.from(
            echogramHistory.decibelRows.subarray(newestRowOffset, newestRowOffset + echogramColumnCount),
          );

          setSnapshot({
            sampleRateHz: inputSampleRateHz,
            band,
            isDirectPathDetected: true,
            directLevelDecibels,
            strongestEcho,
            averagedPulseCount: profileAverager.averagedPulseCount,
            hasBackground: backgroundProfile !== null,
            backgroundProgress,
            latestEchogramRow,
            pulseCount,
          });
        };

        audioRecorder.onAudioReady(
          { sampleRate: outputSampleRateHz, bufferLength: 2048, channelCount: 1 },
          (audioEvent) => {
            if (isCancelled) return;
            if (!pulseProcessor) {
              inputSampleRateHz = audioEvent.buffer.sampleRate;
              if (band.highFrequencyHz > inputSampleRateHz / 2 - 500) {
                isCancelled = true;
                setPulsesStatus({ status: 'inputSampleRateTooLow', inputSampleRateHz });
                return;
              }
              const inputChirp = generateSonarChirp(chirpSpecification, inputSampleRateHz);
              pulseProcessor = createSonarPulseProcessor({
                sampleRateHz: inputSampleRateHz,
                chirpSamples: inputChirp,
                // Mismo periodo que el altavoz, medido en muestras del micrófono.
                pulsePeriodSamples: Math.round((outputPeriodSamples * inputSampleRateHz) / outputSampleRateHz),
                maximumEchoDelaySeconds,
                passbandLowHz: band.lowFrequencyHz,
                passbandHighHz: band.highFrequencyHz,
              });
              profileAverager = createProfileAverager(pulseProcessor.profileLength, averagedPulseCount);
              subtractedProfile = new Float64Array(pulseProcessor.profileLength);
              profileDecibels = new Float64Array(pulseProcessor.profileLength);
            }
            pulseProcessor.pushSamples(audioEvent.buffer.getChannelData(0), handlePulse);
          },
        );

        const startResult = await audioRecorder.start();
        if (isCancelled) return;
        if (startResult.status === 'error') throw new Error(startResult.message);
        await audioContext.resume();
        if (isCancelled) return;
        pulseSource.start();
        setSnapshot({ ...emptySnapshot, sampleRateHz: outputSampleRateHz, band });
        setPulsesStatus({ status: 'running' });
      } catch (startError) {
        if (!isCancelled) setPulsesStatus({ status: 'error', errorMessage: String(startError) });
      }
    }

    void startSonar();
    return () => {
      isCancelled = true;
      gainNodeRef.current = null;
      audioRecorder.clearOnAudioReady();
      void audioRecorder.stop().catch(() => undefined);
      try {
        pulseSource.stop();
      } catch {
        // No había empezado.
      }
      void audioContext.close().catch(() => undefined);
    };
  }, [shouldRun, bandPreset, echogramHistory]);

  const recordBackground = useCallback(() => {
    backgroundRequestRef.current = 'record';
    setSnapshot((previousSnapshot) => ({ ...previousSnapshot, backgroundProgress: 0, hasBackground: false }));
  }, []);

  const clearBackground = useCallback(() => {
    backgroundRequestRef.current = 'clear';
    setSnapshot((previousSnapshot) => ({ ...previousSnapshot, backgroundProgress: null, hasBackground: false }));
  }, []);

  return { pulsesStatus, snapshot, echogramHistory, recordBackground, clearBackground };
}
