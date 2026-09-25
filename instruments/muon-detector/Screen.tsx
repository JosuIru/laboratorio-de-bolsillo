import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View } from 'react-native';
import {
  Camera,
  type CameraRef,
  type CameraSessionConfig,
  type Constraint,
  useCameraDevice,
} from 'react-native-vision-camera';

import { writeImageToCachePng } from '@/core/camera/imageFiles';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import { countsForRelativeUncertainty, type CountingRate } from '@/processing/particles/countingStatistics';
import {
  countPixelOccurrences,
  isCameraCovered,
  selectHotPixels,
  summarizeDarkHistogram,
  thresholdOffsetFromNoise,
} from '@/processing/particles/darkCalibration';
import type { FrameDetectionResult } from '@/processing/particles/darkFrameEvents';
import {
  analyzedFrameFraction,
  applyFrameDetection,
  createDetectionSession,
  type DetectionSessionState,
  summarizeDetectionSession,
} from '@/processing/particles/detectionSession';
import { buildThumbnailMosaic } from '@/processing/particles/thumbnailRendering';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { muonDetectorInstrumentId } from './instrumentId';
import { createSkiaImageFromRgba, ParticleGallery } from './ParticleGallery';
import type { MuonDetectorMeasurementValues } from './schema';
import { type DarkFrameMode, type FrameSize, useDarkFrames } from './useDarkFrames';

type DetectorPhase = 'idle' | 'noiseCalibration' | 'hotPixelCalibration' | 'measuring' | 'stopped';

/**
 * Pocos fotogramas por segundo: así la exposición automática puede alargar cada fotograma (más
 * tiempo de exposición por fotograma y menos cálculo). Se negocia el más cercano que admita.
 */
const targetFramesPerSecond = 10;
const cameraConstraints: Constraint[] = [{ fps: targetFramesPerSecond }];
const noiseCalibrationMilliseconds = 3000;
const minimumNoiseCalibrationFrames = 8;
const hotPixelCalibrationMilliseconds = 5000;
const minimumHotPixelCalibrationFrames = 12;
/** Un píxel que supera el umbral en 2 fotogramas de la calibración es caliente, no una partícula. */
const hotPixelMinimumOccurrences = 2;
/** Subida del nivel de negro que indica que el sensor se ha calentado. */
const heatingDarkLevelRise = 3;
const galleryEventLimit = 30;
const savedMosaicEventLimit = 24;
const previewSide = 96;

interface CalibrationAccumulator {
  startedAtMilliseconds: number;
  frameCount: number;
  histogram: Float64Array;
  hotPixelOccurrences: Map<number, number>;
  calibrationDarkLevel: number;
  /** Umbral que sale de la fase de ruido. */
  thresholdOffset: number;
}

function createCalibrationAccumulator(): CalibrationAccumulator {
  return {
    startedAtMilliseconds: Date.now(),
    frameCount: 0,
    histogram: new Float64Array(256),
    hotPixelOccurrences: new Map(),
    calibrationDarkLevel: 0,
    thresholdOffset: 0,
  };
}

interface MeasurementRun {
  detectionSession: DetectionSessionState;
  calibrationHotPixelCount: number;
  initialThresholdOffset: number;
  calibrationDarkLevel: number;
  startedAtMilliseconds: number;
  endedAtMilliseconds: number | null;
}

/** La cámara la cierra `useIsCameraAllowed`; no hay más recursos que liberar. */
function releaseNothing() {}

function roundTo(value: number, decimalCount: number): number {
  const scale = 10 ** decimalCount;
  return Math.round(value * scale) / scale;
}

function formatDuration(totalSeconds: number): string {
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const twoDigits = (timePart: number) => timePart.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}` : `${minutes}:${twoDigits(seconds)}`;
}

function frameModeForPhase(phase: DetectorPhase): DarkFrameMode {
  if (phase === 'noiseCalibration' || phase === 'hotPixelCalibration' || phase === 'measuring') return phase;
  return 'monitor';
}

export function MuonDetectorScreen({ saveMeasurement }: InstrumentScreenProps<MuonDetectorMeasurementValues>) {
  const { t } = useTranslation(muonDetectorInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();

  const [phase, setPhase] = useState<DetectorPhase>('idle');
  // Copia síncrona de la fase: los fotogramas llegan antes de que React repinte.
  const phaseRef = useRef<DetectorPhase>('idle');
  const [liveDarkLevel, setLiveDarkLevel] = useState<number | null>(null);
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);
  const [thresholdOffset, setThresholdOffset] = useState(0);
  const [hotPixelIndices, setHotPixelIndices] = useState<Int32Array>(() => new Int32Array(0));
  const [measurementRun, setMeasurementRun] = useState<MeasurementRun | null>(null);
  // El recuento se modifica en el sitio; este contador fuerza el repintado cuando cambia.
  const [, setEventRenderVersion] = useState(0);
  const [currentTimeMilliseconds, setCurrentTimeMilliseconds] = useState(() => Date.now());
  const [selectedFramesPerSecond, setSelectedFramesPerSecond] = useState<number | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const calibrationAccumulator = useRef<CalibrationAccumulator>(createCalibrationAccumulator());
  const lastDarkLevelUpdateTime = useRef(0);

  const changePhase = useCallback((nextPhase: DetectorPhase) => {
    phaseRef.current = nextPhase;
    setPhase(nextPhase);
  }, []);

  const abortCalibration = useCallback(
    (messageKey: string) => {
      changePhase('idle');
      setStatusMessage(t(messageKey));
    },
    [changePhase, t],
  );

  const finishMeasurement = useCallback(() => {
    if (phaseRef.current !== 'measuring') return;
    const endedAtMilliseconds = Date.now();
    setMeasurementRun((previousRun) => (previousRun ? { ...previousRun, endedAtMilliseconds } : previousRun));
    setCurrentTimeMilliseconds(endedAtMilliseconds);
    changePhase('stopped');
  }, [changePhase]);

  useStopWhenAppInactive(
    () => {
      if (phaseRef.current === 'measuring') finishMeasurement();
      else if (phaseRef.current === 'noiseCalibration' || phaseRef.current === 'hotPixelCalibration') changePhase('idle');
    },
    releaseNothing,
  );

  // Sin cámara (otra pantalla encima) no se mide: se cierra la medición para no diluir la tasa.
  if (!isCameraAllowed && phase === 'measuring') finishMeasurement();

  // Si la pantalla se apagara, la cámara se cerraría y la medición se pararía.
  const isScreenNeededOn = phase === 'noiseCalibration' || phase === 'hotPixelCalibration' || phase === 'measuring';
  useEffect(() => {
    if (!isScreenNeededOn) return;
    const keepAwakeTag = 'muon-detector';
    activateKeepAwakeAsync(keepAwakeTag).catch(() => undefined);
    return () => {
      deactivateKeepAwake(keepAwakeTag).catch(() => undefined);
    };
  }, [isScreenNeededOn]);

  // Reloj de la medición: repinta cada segundo el tiempo, la tasa y su incertidumbre.
  useEffect(() => {
    if (phase !== 'measuring') return;
    const clockInterval = setInterval(() => setCurrentTimeMilliseconds(Date.now()), 1000);
    return () => clearInterval(clockInterval);
  }, [phase]);

  const updateLiveDarkLevel = useCallback((darkLevel: number, latestFrameSize: FrameSize) => {
    const currentTime = Date.now();
    if (currentTime - lastDarkLevelUpdateTime.current < 1000) return;
    lastDarkLevelUpdateTime.current = currentTime;
    setLiveDarkLevel(darkLevel);
    setFrameSize((previousSize) =>
      previousSize?.frameWidth === latestFrameSize.frameWidth && previousSize.frameHeight === latestFrameSize.frameHeight
        ? previousSize
        : latestFrameSize,
    );
  }, []);

  function handleNoiseHistogram(histogram: Uint32Array, darkLevel: number) {
    if (phaseRef.current !== 'noiseCalibration') return;
    if (!isCameraCovered(darkLevel)) {
      abortCalibration('messages.lightDuringCalibration');
      return;
    }
    const accumulator = calibrationAccumulator.current;
    for (let brightness = 0; brightness < 256; brightness++) accumulator.histogram[brightness]! += histogram[brightness]!;
    accumulator.frameCount++;
    const elapsedMilliseconds = Date.now() - accumulator.startedAtMilliseconds;
    if (elapsedMilliseconds < noiseCalibrationMilliseconds || accumulator.frameCount < minimumNoiseCalibrationFrames) return;

    const noiseSummary = summarizeDarkHistogram(accumulator.histogram);
    const calibratedOffset = thresholdOffsetFromNoise(noiseSummary);
    calibrationAccumulator.current = {
      ...createCalibrationAccumulator(),
      calibrationDarkLevel: noiseSummary.meanBrightness,
      thresholdOffset: calibratedOffset,
    };
    setThresholdOffset(calibratedOffset);
    changePhase('hotPixelCalibration');
  }

  function handleHotPixelFrame(pixelIndices: number[], isOverflowing: boolean, darkLevel: number, latestFrameSize: FrameSize) {
    if (phaseRef.current !== 'hotPixelCalibration') return;
    if (isOverflowing || !isCameraCovered(darkLevel)) {
      abortCalibration('messages.lightDuringCalibration');
      return;
    }
    const accumulator = calibrationAccumulator.current;
    countPixelOccurrences(accumulator.hotPixelOccurrences, pixelIndices);
    accumulator.frameCount++;
    const elapsedMilliseconds = Date.now() - accumulator.startedAtMilliseconds;
    if (elapsedMilliseconds < hotPixelCalibrationMilliseconds || accumulator.frameCount < minimumHotPixelCalibrationFrames) {
      return;
    }

    const calibratedHotPixels = selectHotPixels(accumulator.hotPixelOccurrences, hotPixelMinimumOccurrences);
    const startedAtMilliseconds = Date.now();
    setHotPixelIndices(calibratedHotPixels);
    setMeasurementRun({
      detectionSession: createDetectionSession(
        latestFrameSize.frameWidth,
        latestFrameSize.frameHeight,
        accumulator.thresholdOffset,
        calibratedHotPixels,
      ),
      calibrationHotPixelCount: calibratedHotPixels.length,
      initialThresholdOffset: accumulator.thresholdOffset,
      calibrationDarkLevel: accumulator.calibrationDarkLevel,
      startedAtMilliseconds,
      endedAtMilliseconds: null,
    });
    setCurrentTimeMilliseconds(startedAtMilliseconds);
    changePhase('measuring');
  }

  function handleDetection(detection: FrameDetectionResult, latestFrameSize: FrameSize) {
    if (phaseRef.current !== 'measuring' || !measurementRun) return;
    const detectionSession = measurementRun.detectionSession;
    // Si la cámara cambia de resolución a mitad (no debería), los índices ya no valen.
    if (
      latestFrameSize.frameWidth !== detectionSession.frameWidth ||
      latestFrameSize.frameHeight !== detectionSession.frameHeight
    ) {
      return;
    }
    updateLiveDarkLevel(detection.darkLevel, latestFrameSize);
    const outcome = applyFrameDetection(detectionSession, detection, Date.now());
    if (outcome.hasDetectionSettingsChanged) {
      setThresholdOffset(detectionSession.thresholdOffset);
      setHotPixelIndices(detectionSession.hotPixelIndices);
    }
    if (outcome.newEventCount > 0 || outcome.hasDetectionSettingsChanged) {
      setEventRenderVersion((previousVersion) => previousVersion + 1);
    }
  }

  const frameOutput = useDarkFrames(frameModeForPhase(phase), thresholdOffset, hotPixelIndices, {
    onMonitor: updateLiveDarkLevel,
    onNoiseHistogram: (histogram, darkLevel, latestFrameSize) => {
      updateLiveDarkLevel(darkLevel, latestFrameSize);
      handleNoiseHistogram(histogram, darkLevel);
    },
    onHotPixelFrame: (pixelIndices, isOverflowing, darkLevel, latestFrameSize) => {
      updateLiveDarkLevel(darkLevel, latestFrameSize);
      handleHotPixelFrame(pixelIndices, isOverflowing, darkLevel, latestFrameSize);
    },
    onDetection: handleDetection,
  });

  const maximumExposureBias = cameraDevice?.supportsExposureBias ? cameraDevice.maxExposureBias : undefined;

  /**
   * Máxima exposición. En iOS se fija el tiempo de exposición más largo que permite la cadencia
   * y el ISO máximo; en Android vision-camera aún no permite fijar ISO ni tiempo, así que se
   * sube al máximo la compensación de exposición (con la lente tapada, la exposición automática
   * ya tiende a ir al máximo de ganancia).
   */
  async function applyMaximumExposure() {
    const cameraController = cameraRef.current?.controller;
    if (!cameraController) return;
    try {
      if (cameraController.device.supportsExposureLocking && cameraController.maxISO > 0) {
        const frameIntervalSeconds = 1 / (selectedFramesPerSecond ?? targetFramesPerSecond);
        const exposureSeconds = Math.min(cameraController.maxExposureDuration, frameIntervalSeconds);
        await cameraController.setExposureLocked(exposureSeconds, cameraController.maxISO);
      } else if (maximumExposureBias !== undefined) {
        await cameraController.setExposureBias(maximumExposureBias);
      }
    } catch {
      // La cámara puede no estar lista o no admitirlo: se queda con la exposición automática.
    }
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  function handleStart() {
    setStatusMessage(null);
    setMeasurementRun(null);
    setHotPixelIndices(new Int32Array(0));
    calibrationAccumulator.current = createCalibrationAccumulator();
    changePhase('noiseCalibration');
  }

  function handleNewMeasurement() {
    setStatusMessage(null);
    setMeasurementRun(null);
    changePhase('idle');
  }

  const isCovered = liveDarkLevel !== null && isCameraCovered(liveDarkLevel);
  const isCalibrating = phase === 'noiseCalibration' || phase === 'hotPixelCalibration';

  const detectionSession = measurementRun?.detectionSession ?? null;
  const elapsedMilliseconds = measurementRun
    ? (measurementRun.endedAtMilliseconds ?? currentTimeMilliseconds) - measurementRun.startedAtMilliseconds
    : 0;
  const elapsedMinutes = Math.max(0, elapsedMilliseconds) / 60_000;
  const sessionSummary = detectionSession ? summarizeDetectionSession(detectionSession, elapsedMinutes) : null;
  const analyzedFraction = measurementRun
    ? analyzedFrameFraction(
        measurementRun.detectionSession.analyzedFrameCount + measurementRun.detectionSession.lightLeakFrameCount,
        elapsedMilliseconds / 1000,
        selectedFramesPerSecond,
      )
    : null;
  const isSensorWarming =
    phase === 'measuring' &&
    measurementRun !== null &&
    liveDarkLevel !== null &&
    liveDarkLevel - measurementRun.calibrationDarkLevel > heatingDarkLevelRise;
  const galleryEvents = detectionSession ? detectionSession.acceptedEvents.slice(-galleryEventLimit).reverse() : [];

  function formatRate(rate: CountingRate | null): string {
    if (!rate) return '—';
    return t('rateValue', {
      rate: rate.ratePerMinute.toFixed(3),
      uncertainty: rate.standardUncertaintyPerMinute.toFixed(3),
      perHour: (rate.ratePerMinute * 60).toFixed(1),
    });
  }

  async function handleSave() {
    if (!measurementRun || !detectionSession || !sessionSummary?.allEventsRate || !sessionSummary.trackRate) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const mosaic = buildThumbnailMosaic(
        detectionSession.acceptedEvents.slice(-savedMosaicEventLimit).map((acceptedEvent) => acceptedEvent.thumbnail),
        128,
        6,
        4,
      );
      const mosaicImage = mosaic ? createSkiaImageFromRgba(mosaic) : null;
      const mosaicFile = mosaicImage ? writeImageToCachePng(mosaicImage, 'particulas') : null;
      const allEventsRate = sessionSummary.allEventsRate;
      const trackRate = sessionSummary.trackRate;
      await saveMeasurement({
        values: {
          durationMinutes: roundTo(elapsedMinutes, 2),
          analyzedFrameCount: detectionSession.analyzedFrameCount - detectionSession.noisyFrameCount,
          ...(analyzedFraction !== null ? { analyzedFramePercent: roundTo(analyzedFraction * 100, 1) } : {}),
          frameWidthPixels: detectionSession.frameWidth,
          frameHeightPixels: detectionSession.frameHeight,
          eventCount: sessionSummary.eventCount,
          spotCount: sessionSummary.spotCount,
          wormCount: sessionSummary.wormCount,
          trackCount: sessionSummary.trackCount,
          eventsPerMinute: roundTo(allEventsRate.ratePerMinute, 4),
          eventsPerMinuteUncertainty: roundTo(allEventsRate.standardUncertaintyPerMinute, 4),
          eventsPerMinuteLower: roundTo(allEventsRate.lowerPerMinute, 4),
          eventsPerMinuteUpper: roundTo(allEventsRate.upperPerMinute, 4),
          tracksPerMinute: roundTo(trackRate.ratePerMinute, 4),
          tracksPerMinuteUncertainty: roundTo(trackRate.standardUncertaintyPerMinute, 4),
          calibrationHotPixelCount: measurementRun.calibrationHotPixelCount,
          addedHotPixelCount: detectionSession.addedHotPixelCount,
          discardedHotEventCount: detectionSession.discardedHotEventCount,
          initialThresholdOffset: measurementRun.initialThresholdOffset,
          finalThresholdOffset: detectionSession.thresholdOffset,
          meanDarkLevel: roundTo(sessionSummary.meanDarkLevel, 2),
          lightLeakFrameCount: detectionSession.lightLeakFrameCount,
          noisyFrameCount: detectionSession.noisyFrameCount,
        },
        attachments:
          mosaicFile && mosaicImage
            ? [
                {
                  kind: 'photo',
                  sourceUri: mosaicFile.uri,
                  fileName: 'sucesos.png',
                  mimeType: 'image/png',
                  metadata: {
                    widthPixels: mosaicImage.width(),
                    heightPixels: mosaicImage.height(),
                    eventCount: Math.min(savedMosaicEventLimit, sessionSummary.eventCount),
                  },
                },
              ]
            : [],
      });
      mosaicFile?.delete();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('intro')}</BodyText>
      <Card>
        <BodyText>{t('steps.cover')}</BodyText>
        <BodyText>{t('steps.still')}</BodyText>
        <BodyText>{t('steps.wait')}</BodyText>
      </Card>

      <View style={styles.cameraRow}>
        <View style={[styles.previewBox, { borderColor: themePalette.border }]}>
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={cameraDevice ?? 'back'}
            isActive={isCameraAllowed}
            outputs={[frameOutput]}
            constraints={cameraConstraints}
            exposure={maximumExposureBias}
            onSessionConfigSelected={(sessionConfig: CameraSessionConfig) =>
              setSelectedFramesPerSecond(sessionConfig.selectedFPS)
            }
            onStarted={() => void applyMaximumExposure()}
            onError={handleCameraError}
            resizeMode="cover"
          />
        </View>
        <View style={styles.cameraStatus}>
          <BodyText tone={liveDarkLevel === null ? 'secondary' : isCovered ? 'accent' : 'danger'}>
            {liveDarkLevel === null ? t('status.waitingCamera') : isCovered ? t('status.covered') : t('status.notCovered')}
          </BodyText>
          {liveDarkLevel !== null ? (
            <BodyText tone="secondary" style={styles.smallText}>
              {t('status.darkLevel', { level: liveDarkLevel.toFixed(1) })}
            </BodyText>
          ) : null}
          {frameSize ? (
            <BodyText tone="secondary" style={styles.smallText}>
              {t('status.frameSize', { width: frameSize.frameWidth, height: frameSize.frameHeight })}
            </BodyText>
          ) : null}
        </View>
      </View>

      {phase === 'idle' ? (
        <AppButton
          label={t('actions.start')}
          onPress={handleStart}
          isDisabled={!isCameraAllowed || !isCovered}
        />
      ) : null}
      {phase === 'idle' && liveDarkLevel !== null && !isCovered ? (
        <BodyText tone="danger">{t('messages.coverFirst')}</BodyText>
      ) : null}

      {isCalibrating ? (
        <Card>
          <BodyText>
            {phase === 'noiseCalibration' ? t('calibration.noise') : t('calibration.hotPixels')}
          </BodyText>
          <BodyText tone="secondary">{t('calibration.keepStill')}</BodyText>
          <AppButton label={t('actions.cancel')} onPress={() => changePhase('idle')} variant="secondary" />
        </Card>
      ) : null}

      {measurementRun && detectionSession && sessionSummary ? (
        <>
          <SectionTitle>{phase === 'measuring' ? t('results.measuringTitle') : t('results.finishedTitle')}</SectionTitle>
          <Card>
            <BodyText style={styles.bigValue}>{sessionSummary.eventCount}</BodyText>
            <BodyText tone="secondary">
              {t('results.eventsIn', { duration: formatDuration(elapsedMilliseconds / 1000) })}
            </BodyText>
            <BodyText>
              {t('results.byShape', {
                spots: sessionSummary.spotCount,
                worms: sessionSummary.wormCount,
                tracks: sessionSummary.trackCount,
              })}
            </BodyText>
            <BodyText>{t('results.allRate', { rate: formatRate(sessionSummary.allEventsRate) })}</BodyText>
            {sessionSummary.allEventsRate ? (
              <BodyText tone="secondary" style={styles.smallText}>
                {t('results.interval', {
                  lower: sessionSummary.allEventsRate.lowerPerMinute.toFixed(3),
                  upper: sessionSummary.allEventsRate.upperPerMinute.toFixed(3),
                })}
              </BodyText>
            ) : null}
            <BodyText>{t('results.trackRate', { rate: formatRate(sessionSummary.trackRate) })}</BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {sessionSummary.eventCount > 0
                ? t('results.precision', {
                    percent: Math.round(100 / Math.sqrt(sessionSummary.eventCount)),
                    needed: countsForRelativeUncertainty(0.1),
                  })
                : t('results.noEventsYet')}
            </BodyText>
          </Card>

          <Card>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('details.calibration', {
                hotPixels: measurementRun.calibrationHotPixelCount,
                threshold: measurementRun.initialThresholdOffset,
              })}
            </BodyText>
            {detectionSession.addedHotPixelCount > 0 || detectionSession.discardedHotEventCount > 0 ? (
              <BodyText tone="secondary" style={styles.smallText}>
                {t('details.heatedPixels', {
                  addedPixels: detectionSession.addedHotPixelCount,
                  discardedEvents: detectionSession.discardedHotEventCount,
                })}
              </BodyText>
            ) : null}
            {detectionSession.thresholdRaiseCount > 0 ? (
              <BodyText tone="secondary" style={styles.smallText}>
                {t('details.thresholdRaised', { threshold: detectionSession.thresholdOffset })}
              </BodyText>
            ) : null}
            <BodyText tone="secondary" style={styles.smallText}>
              {t('details.frames', {
                analyzed: detectionSession.analyzedFrameCount,
                lightLeak: detectionSession.lightLeakFrameCount,
                noisy: detectionSession.noisyFrameCount,
              })}
            </BodyText>
            {analyzedFraction !== null ? (
              <BodyText tone="secondary" style={styles.smallText}>
                {t('details.analyzedFraction', {
                  percent: Math.round(analyzedFraction * 100),
                  framesPerSecond: selectedFramesPerSecond,
                })}
              </BodyText>
            ) : null}
          </Card>
          {isSensorWarming ? <BodyText tone="danger">{t('messages.sensorWarming')}</BodyText> : null}
          {detectionSession.lightLeakFrameCount > 0 && phase === 'measuring' && !isCovered ? (
            <BodyText tone="danger">{t('messages.lightDuringMeasurement')}</BodyText>
          ) : null}

          {phase === 'measuring' ? (
            <>
              <BodyText tone="secondary">{t('messages.keepScreenOn')}</BodyText>
              <AppButton label={t('actions.stop')} onPress={finishMeasurement} variant="secondary" />
            </>
          ) : (
            <View style={styles.buttonColumn}>
              <AppButton
                label={t('core:common.save')}
                onPress={() => void handleSave()}
                isBusy={isSaving}
                isDisabled={elapsedMinutes <= 0}
              />
              <AppButton label={t('actions.newMeasurement')} onPress={handleNewMeasurement} variant="secondary" />
            </View>
          )}

          <SectionTitle>{t('gallery.title')}</SectionTitle>
          <ParticleGallery particleEvents={galleryEvents} />
        </>
      ) : null}

      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <SectionTitle>{t('limits.title')}</SectionTitle>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('limits.expectedRate')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('limits.heat')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('limits.shapes')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {Platform.OS === 'android' ? t('limits.cameraAndroid') : t('limits.cameraIos')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('limits.howItWorks')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  cameraRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  previewBox: {
    width: previewSide,
    height: previewSide,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  cameraStatus: { flex: 1, gap: 2 },
  bigValue: { fontSize: 44, lineHeight: 52, fontWeight: '700', fontVariant: ['tabular-nums'] },
  smallText: { fontSize: 13, lineHeight: 18 },
  buttonColumn: { gap: 8 },
});
