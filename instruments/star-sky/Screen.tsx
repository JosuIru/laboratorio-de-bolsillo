import type { SkImage } from '@shopify/react-native-skia';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, useCameraDevice } from 'react-native-vision-camera';

import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { type PhotoBurstCrop, usePhotoBurst } from '@/core/camera/usePhotoBurst';
import { useResultImageViewer } from '@/core/camera/useResultImageViewer';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { AttachmentDraft } from '@/core/measurements/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import { type FieldOfView, fieldOfViewForRegion, typicalPhoneFocalLength35mm } from '@/processing/astronomy/starFieldStatistics';
import { meteorsPerHour } from '@/processing/image/meteorDetection';
import { stackStarFrames, type StarStackResult, StarTrailAccumulator } from '@/processing/image/starStacking';
import { AppButton, BodyText, LoadingState, SectionTitle } from '@/ui/components';
import { CameraOverlayButton, CameraOverlayText, CameraScreenLayout } from '@/ui/FullScreenCamera';

import { starSkyInstrumentId } from './instrumentId';
import { NightSkyAdvice } from './NightSkyAdvice';
import type { StarSkyMeasurementValues } from './schema';
import {
  captureRegionFor,
  defaultIsoChoice,
  defaultStackFrameCount,
  formatElapsedTime,
  frameSourceFromGrayFrames,
  grayBytesFromRgb,
  isoChoices,
  photosPerBurstChunk,
  type SkyFieldChoice,
  skyFieldChoices,
  type SkyMode,
  skyModes,
  stackFrameCountChoices,
  type StoredGrayFrame,
} from './skyCapturePlanning';
import { SkyChoiceChips } from './SkyChoiceChips';
import { createSkyImage, SkyResultImage } from './SkyResultImage';
import { type StackSummary, summarizeStarStack } from './stackSummary';
import { useMeteorWatch, type WatchedMeteorEvent } from './useMeteorWatch';
import { type AppliedNightSettings, useNightCamera } from './useNightCamera';

/**
 * El visor se carga al abrirlo: arrastra módulos nativos (galería, compartir) que no hacen falta
 * hasta entonces y que no existen en los tests que importan todos los instrumentos.
 */
const ImageViewer = lazy(() => import('@/ui/ImageViewer').then((viewerModule) => ({ default: viewerModule.ImageViewer })));

/** Eventos de meteoros que se adjuntan al guardar la sesión. */
const maximumSavedMeteorFrames = 10;

type SkyActivity = 'idle' | 'capturing' | 'processing' | 'watching';
type StackVersion = 'stacked' | 'single';
type OnOffChoice = 'on' | 'off';
const onOffChoices: readonly OnOffChoice[] = ['on', 'off'];

interface CaptureGeometry {
  fieldOfView: FieldOfView;
  /** Píxeles del resultado por píxel de la foto (< 1 si se redujo el campo entero). */
  outputScale: number;
}

interface StackOutcome {
  stackResult: StarStackResult;
  summary: StackSummary;
  geometry: CaptureGeometry;
  capturedFrameCount: number;
  nightSettings: AppliedNightSettings | null;
  stackedSkiaImage: SkImage | null;
  singleSkiaImage: SkImage | null;
}

interface TrailOutcome {
  skiaImage: SkImage | null;
  frameCount: number;
  insertedCopyCount: number;
  elapsedMilliseconds: number;
  isFinished: boolean;
  nightSettings: AppliedNightSettings | null;
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMilliseconds));
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function exposureValues(nightSettings: AppliedNightSettings | null): Pick<StarSkyMeasurementValues, 'exposureMilliseconds' | 'iso'> {
  if (!nightSettings || nightSettings.exposureSeconds === null || nightSettings.iso === null) return {};
  return { exposureMilliseconds: roundTo(nightSettings.exposureSeconds * 1000, 1), iso: nightSettings.iso };
}

export function StarSkyScreen({ saveMeasurement, sensorAvailability }: InstrumentScreenProps<StarSkyMeasurementValues>) {
  const { t } = useTranslation(starSkyInstrumentId);
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const photoBurst = usePhotoBurst();
  const nightCamera = useNightCamera(cameraRef);
  const meteorWatch = useMeteorWatch();
  const resultImageViewer = useResultImageViewer();

  const [mode, setMode] = useState<SkyMode>('stack');
  const [isoChoice, setIsoChoice] = useState(defaultIsoChoice);
  const [stackFrameCount, setStackFrameCount] = useState(defaultStackFrameCount);
  const [fieldChoice, setFieldChoice] = useState<SkyFieldChoice>('whole');
  const [gapFillingChoice, setGapFillingChoice] = useState<OnOffChoice>('on');
  const [activity, setActivity] = useState<SkyActivity>('idle');
  const [progressText, setProgressText] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [stackOutcome, setStackOutcome] = useState<StackOutcome | null>(null);
  const [displayedStackVersion, setDisplayedStackVersion] = useState<StackVersion>('stacked');
  const [trailOutcome, setTrailOutcome] = useState<TrailOutcome | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Cambia con cada resultado nuevo: en pantalla completa abre el panel para verlo.
  const [resultSequenceNumber, setResultSequenceNumber] = useState(0);
  const isStopRequestedRef = useRef(false);
  // La captura espera muchas veces: si se sale de la pantalla entretanto, no se sigue.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isBusy = activity !== 'idle' || meteorWatch.isWatching;
  useKeepScreenOnWhile(isBusy, starSkyInstrumentId);

  // Con la vista nocturna puesta, se vuelve a aplicar si la cámara se reinicia (al cambiar de modo).
  const nightIsoRef = useRef<number | null>(null);
  function handleCameraStarted() {
    photoBurst.handleCameraStarted();
    if (nightIsoRef.current !== null) void nightCamera.applyNightSettings(nightIsoRef.current);
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function enableNightView(): Promise<AppliedNightSettings | null> {
    nightIsoRef.current = isoChoice;
    return nightCamera.applyNightSettings(isoChoice);
  }

  async function disableNightView() {
    nightIsoRef.current = null;
    await nightCamera.resetToAutomatic();
  }

  function captureGeometryFor(firstCrop: PhotoBurstCrop): CaptureGeometry {
    // Algunos móviles no dan la focal (o dan 0): se supone la típica de la cámara principal.
    const reportedFocalLength = cameraDevice?.focalLength ?? 0;
    const fieldOfView = fieldOfViewForRegion({
      focalLength35mm: reportedFocalLength > 0 ? reportedFocalLength : typicalPhoneFocalLength35mm,
      photoWidthPixels: firstCrop.uprightPhotoSize.width,
      photoHeightPixels: firstCrop.uprightPhotoSize.height,
      regionWidthPixels: firstCrop.cropRect.width,
      regionHeightPixels: firstCrop.cropRect.height,
    });
    return { fieldOfView, outputScale: firstCrop.outputScale };
  }

  /**
   * Toma fotos en tandas de `photosPerBurstChunk` (hasta `totalPhotoCount` o hasta que se pida
   * parar) y pasa cada recorte a `handleCrop`. Devuelve cuántas se tomaron y el primer error.
   */
  async function capturePhotosInChunks(
    totalPhotoCount: number,
    captureFieldChoice: SkyFieldChoice,
    handleCrop: (photoCrop: PhotoBurstCrop) => void,
    handleChunkFinished?: () => void,
  ): Promise<{ capturedCount: number; errorMessage: string | null }> {
    const maximumOutputSide = captureRegionFor(captureFieldChoice, photoBurst.uprightPhotoSize).maximumOutputSide;
    let capturedCount = 0;
    while (capturedCount < totalPhotoCount && !isStopRequestedRef.current && isMountedRef.current) {
      const chunkPhotoCount = Math.min(photosPerBurstChunk, totalPhotoCount - capturedCount);
      const burstResult = await photoBurst.captureBurst({
        photoCount: chunkPhotoCount,
        planCrop: (uprightPhotoSize) => captureRegionFor(captureFieldChoice, uprightPhotoSize).cropRect,
        maximumOutputSide,
      });
      if (burstResult.crops.length === 0) return { capturedCount, errorMessage: burstResult.firstErrorMessage ?? t('noPhotos') };
      for (const photoCrop of burstResult.crops) handleCrop(photoCrop);
      capturedCount += burstResult.crops.length;
      handleChunkFinished?.();
      // Deja respirar a la interfaz entre tandas.
      await waitMilliseconds(30);
    }
    return { capturedCount, errorMessage: null };
  }

  async function handleStartStack() {
    const captureFrameCount = stackFrameCount;
    const captureFieldChoice = fieldChoice;
    isStopRequestedRef.current = false;
    setStatusMessage(null);
    setStackOutcome(null);
    setActivity('capturing');
    try {
      const nightSettings = await enableNightView();
      const storedFrames: StoredGrayFrame[] = [];
      // En un objeto: TypeScript no sigue las asignaciones hechas dentro de la función de abajo.
      const captureState: { firstCrop: PhotoBurstCrop | null } = { firstCrop: null };
      const { errorMessage } = await capturePhotosInChunks(captureFrameCount, captureFieldChoice, (photoCrop) => {
        const firstCrop = (captureState.firstCrop ??= photoCrop);
        if (photoCrop.width !== firstCrop.width || photoCrop.height !== firstCrop.height) return;
        storedFrames.push({
          grayBytes: grayBytesFromRgb(photoCrop.rgbPixels, photoCrop.width * photoCrop.height),
          width: photoCrop.width,
          height: photoCrop.height,
        });
        setProgressText(t('progress.photos', { captured: storedFrames.length, target: captureFrameCount }));
      });
      if (!isMountedRef.current) return;
      const { firstCrop } = captureState;
      if (!firstCrop || storedFrames.length === 0) {
        setStatusMessage(t('burstFailed', { message: errorMessage ?? t('noPhotos') }));
        return;
      }
      setActivity('processing');
      const stackResult = await stackStarFrames(
        frameSourceFromGrayFrames(storedFrames),
        {},
        (stackProgress) => {
          setProgressText(
            t(`progress.stack.${stackProgress.phase}`, {
              completed: stackProgress.completedCount + 1,
              total: stackProgress.totalCount,
            }),
          );
        },
        () => waitMilliseconds(0),
      );
      if (!isMountedRef.current) return;
      const geometry = captureGeometryFor(firstCrop);
      setDisplayedStackVersion('stacked');
      setStackOutcome({
        stackResult,
        summary: summarizeStarStack(stackResult, geometry.fieldOfView),
        geometry,
        capturedFrameCount: storedFrames.length,
        nightSettings,
        stackedSkiaImage: createSkyImage(stackResult.stacked.stretchedBytes, stackResult.width, stackResult.height, 1),
        singleSkiaImage: createSkyImage(stackResult.singleFrame.stretchedBytes, stackResult.width, stackResult.height, 1),
      });
      setResultSequenceNumber((previousNumber) => previousNumber + 1);
    } catch (captureError) {
      if (isMountedRef.current) setStatusMessage(t('core:common.error', { message: String(captureError) }));
    } finally {
      if (isMountedRef.current) {
        setActivity('idle');
        setProgressText(null);
      }
    }
  }

  async function handleStartTrails() {
    const captureFieldChoice = fieldChoice;
    const shouldFillGaps = gapFillingChoice === 'on';
    isStopRequestedRef.current = false;
    setStatusMessage(null);
    setTrailOutcome(null);
    setActivity('capturing');
    const startTime = Date.now();
    // En un objeto: TypeScript no sigue las asignaciones hechas dentro de las funciones de abajo.
    const trailState: { accumulator: StarTrailAccumulator | null; nightSettings: AppliedNightSettings | null } = {
      accumulator: null,
      nightSettings: null,
    };
    const publishTrails = (isFinished: boolean) => {
      const trailAccumulator = trailState.accumulator;
      if (!trailAccumulator || !isMountedRef.current) return;
      const trailStatistics = trailAccumulator.statistics();
      setTrailOutcome({
        skiaImage: createSkyImage(trailAccumulator.trailBytes(), trailAccumulator.width, trailAccumulator.height, 3),
        frameCount: trailStatistics.frameCount,
        insertedCopyCount: trailStatistics.insertedCopyCount,
        elapsedMilliseconds: Date.now() - startTime,
        isFinished,
        nightSettings: trailState.nightSettings,
      });
    };
    try {
      trailState.nightSettings = await enableNightView();
      const { errorMessage } = await capturePhotosInChunks(
        Number.POSITIVE_INFINITY,
        captureFieldChoice,
        (photoCrop) => {
          const trailAccumulator = (trailState.accumulator ??= new StarTrailAccumulator(photoCrop.width, photoCrop.height, 3, {
            fillGaps: shouldFillGaps,
          }));
          if (photoCrop.width !== trailAccumulator.width || photoCrop.height !== trailAccumulator.height) return;
          trailAccumulator.addFrame(photoCrop.rgbPixels);
        },
        () => {
          publishTrails(false);
          setProgressText(
            t('progress.trails', {
              frames: trailState.accumulator?.statistics().frameCount ?? 0,
              elapsed: formatElapsedTime(Date.now() - startTime),
            }),
          );
        },
      );
      if (!isMountedRef.current) return;
      if (!trailState.accumulator) {
        setStatusMessage(t('burstFailed', { message: errorMessage ?? t('noPhotos') }));
        return;
      }
      if (errorMessage) setStatusMessage(t('burstFailed', { message: errorMessage }));
      publishTrails(true);
      setResultSequenceNumber((previousNumber) => previousNumber + 1);
    } catch (captureError) {
      if (isMountedRef.current) setStatusMessage(t('core:common.error', { message: String(captureError) }));
    } finally {
      if (isMountedRef.current) {
        setActivity('idle');
        setProgressText(null);
      }
    }
  }

  async function handleStartMeteorWatch() {
    setStatusMessage(null);
    await enableNightView();
    meteorWatch.startWatching();
  }

  function handleStopMeteorWatch() {
    meteorWatch.stopWatching();
    setResultSequenceNumber((previousNumber) => previousNumber + 1);
  }

  function handleStart() {
    if (mode === 'stack') void handleStartStack();
    else if (mode === 'trails') void handleStartTrails();
    else void handleStartMeteorWatch();
  }

  function handleStop() {
    if (mode === 'meteors') {
      handleStopMeteorWatch();
      return;
    }
    isStopRequestedRef.current = true;
    photoBurst.stopCapture();
  }

  function openViewer(images: { skiaImage: SkImage | null; caption: string; fileNamePrefix: string }[], initialIndex = 0) {
    const availableImages = images.flatMap((image) => (image.skiaImage ? [{ ...image, skiaImage: image.skiaImage }] : []));
    if (availableImages.length > 0) resultImageViewer.openViewer(availableImages, initialIndex);
  }

  function handleOpenStackViewer() {
    if (!stackOutcome) return;
    const versions: StackVersion[] = displayedStackVersion === 'stacked' ? ['stacked', 'single'] : ['single', 'stacked'];
    openViewer(
      versions.map((version) => ({
        skiaImage: version === 'stacked' ? stackOutcome.stackedSkiaImage : stackOutcome.singleSkiaImage,
        caption: t(`stack.versions.${version}`),
        fileNamePrefix: `cielo-${version}`,
      })),
    );
  }

  function meteorEventImage(meteorEvent: WatchedMeteorEvent): SkImage | null {
    return createSkyImage(meteorEvent.frameBytes, meteorEvent.width, meteorEvent.height, 1);
  }

  function handleOpenMeteorViewer(eventIndex: number) {
    const events = meteorWatch.session?.events ?? [];
    openViewer(
      events.map((meteorEvent) => ({
        skiaImage: meteorEventImage(meteorEvent),
        caption: t('meteors.eventCaption', { time: meteorEvent.detectedAt.toLocaleTimeString() }),
        fileNamePrefix: 'meteoro',
      })),
      eventIndex,
    );
  }

  async function saveWithAttachments(values: StarSkyMeasurementValues, images: { skiaImage: SkImage | null; fileName: string; metadata?: Record<string, number | string> }[]) {
    setIsSaving(true);
    setStatusMessage(null);
    const pngFiles: ReturnType<typeof writeImageToCachePng>[] = [];
    try {
      const attachments: AttachmentDraft[] = [];
      for (const image of images) {
        if (!image.skiaImage) continue;
        const pngFile = writeImageToCachePng(image.skiaImage, 'cielo');
        pngFiles.push(pngFile);
        attachments.push({
          kind: 'photo',
          sourceUri: pngFile.uri,
          fileName: image.fileName,
          mimeType: 'image/png',
          metadata: { widthPixels: image.skiaImage.width(), heightPixels: image.skiaImage.height(), ...image.metadata },
        });
      }
      await saveMeasurement({ values, attachments });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      for (const pngFile of pngFiles) {
        try {
          pngFile.delete();
        } catch {
          // Fichero temporal de la caché: lo borrará el sistema.
        }
      }
      setIsSaving(false);
    }
  }

  function handleSaveStack() {
    if (!stackOutcome) return;
    const { summary, stackResult, geometry } = stackOutcome;
    void saveWithAttachments(
      {
        mode: 'stack',
        capturedFrameCount: stackOutcome.capturedFrameCount,
        ...exposureValues(stackOutcome.nightSettings),
        stackedFrameCount: stackResult.stackedFrameCount,
        starsInStack: summary.starsInStack,
        starsInSingleFrame: summary.starsInSingleFrame,
        ...(summary.limitingMagnitudeStack !== null ? { limitingMagnitudeStack: roundTo(summary.limitingMagnitudeStack, 1) } : {}),
        ...(summary.limitingMagnitudeSingle !== null ? { limitingMagnitudeSingle: roundTo(summary.limitingMagnitudeSingle, 1) } : {}),
        noiseReductionFactor: roundTo(summary.noiseReductionFactor, 2),
        largestRotationDegrees: roundTo(stackResult.largestRotationDegrees, 3),
        fieldWidthDegrees: roundTo(geometry.fieldOfView.widthDegrees, 1),
        fieldHeightDegrees: roundTo(geometry.fieldOfView.heightDegrees, 1),
      },
      [
        { skiaImage: stackOutcome.stackedSkiaImage, fileName: 'cielo-apilado.png', metadata: { stackedFrameCount: stackResult.stackedFrameCount } },
        { skiaImage: stackOutcome.singleSkiaImage, fileName: 'cielo-foto-suelta.png' },
      ],
    );
  }

  function handleSaveTrails() {
    if (!trailOutcome) return;
    void saveWithAttachments(
      {
        mode: 'trails',
        capturedFrameCount: trailOutcome.frameCount,
        ...exposureValues(trailOutcome.nightSettings),
        trailDurationSeconds: Math.round(trailOutcome.elapsedMilliseconds / 1000),
      },
      [{ skiaImage: trailOutcome.skiaImage, fileName: 'trazos-de-estrellas.png', metadata: { frameCount: trailOutcome.frameCount } }],
    );
  }

  function handleSaveMeteors() {
    const session = meteorWatch.session;
    if (!session) return;
    const { statistics } = session;
    const hourlyRate = meteorsPerHour(statistics.meteorCount, statistics.watchedMilliseconds);
    void saveWithAttachments(
      {
        mode: 'meteors',
        capturedFrameCount: statistics.processedFrameCount,
        ...exposureValues(nightCamera.appliedSettings),
        meteorCount: statistics.meteorCount,
        ...(hourlyRate !== null ? { meteorsPerHour: roundTo(hourlyRate, 1) } : {}),
        watchedMinutes: roundTo(statistics.watchedMilliseconds / 60_000, 1),
        rejectedSlowMoverCount: statistics.rejectedSlowMoverCount,
      },
      session.events.slice(0, maximumSavedMeteorFrames).map((meteorEvent, eventIndex) => ({
        skiaImage: meteorEventImage(meteorEvent),
        fileName: `meteoro-${eventIndex + 1}.png`,
        metadata: {
          detectedAt: meteorEvent.detectedAt.toISOString(),
          lengthPixels: Math.round(meteorEvent.segment.lengthPixels),
        },
      })),
    );
  }

  const displayedStackImage = stackOutcome
    ? displayedStackVersion === 'stacked'
      ? stackOutcome.stackedSkiaImage
      : stackOutcome.singleSkiaImage
    : null;

  const nightSettingsText = nightCamera.appliedSettings ? <NightSettingsText settings={nightCamera.appliedSettings} /> : null;
  const isStopVisible = activity === 'capturing' || meteorWatch.isWatching;
  const startLabel = t(`start.${mode}`, { frames: stackFrameCount });

  const settingsSection = !isBusy ? (
    <>
      <BodyText tone="secondary">{t('modeTitle')}</BodyText>
      <SkyChoiceChips<SkyMode> options={skyModes} selectedOption={mode} labelFor={(skyMode) => t(`modes.${skyMode}`)} onSelect={setMode} />
      <BodyText tone="secondary" style={styles.smallText}>
        {t(`modeHints.${mode}`)}
      </BodyText>
      <BodyText tone="secondary">{t('isoTitle')}</BodyText>
      <SkyChoiceChips<number> options={isoChoices} selectedOption={isoChoice} labelFor={(iso) => `ISO ${iso}`} onSelect={setIsoChoice} />
      {mode === 'stack' ? (
        <>
          <BodyText tone="secondary">{t('frameCountTitle')}</BodyText>
          <SkyChoiceChips<number>
            options={stackFrameCountChoices}
            selectedOption={stackFrameCount}
            labelFor={(frameCount) => String(frameCount)}
            onSelect={setStackFrameCount}
          />
        </>
      ) : null}
      {mode !== 'meteors' ? (
        <>
          <BodyText tone="secondary">{t('fieldTitle')}</BodyText>
          <SkyChoiceChips<SkyFieldChoice>
            options={skyFieldChoices}
            selectedOption={fieldChoice}
            labelFor={(choice) => t(`fieldChoices.${choice}`)}
            onSelect={setFieldChoice}
          />
        </>
      ) : null}
      {mode === 'trails' ? (
        <>
          <BodyText tone="secondary">{t('gapFillingTitle')}</BodyText>
          <SkyChoiceChips<OnOffChoice>
            options={onOffChoices}
            selectedOption={gapFillingChoice}
            labelFor={(choice) => t(`choices.${choice}`)}
            onSelect={setGapFillingChoice}
          />
        </>
      ) : null}
      <View style={styles.buttonRow}>
        <View style={styles.flexCell}>
          <AppButton
            label={t(nightCamera.appliedSettings ? 'nightView.disable' : 'nightView.enable')}
            onPress={() => void (nightCamera.appliedSettings ? disableNightView() : enableNightView())}
            variant="secondary"
            isDisabled={!isCameraAllowed}
          />
        </View>
      </View>
    </>
  ) : null;

  const progressSection = progressText ? <BodyText style={styles.progressText}>{progressText}</BodyText> : null;
  const processingIndicator = activity === 'processing' ? <LoadingState label={progressText ?? t('processing')} /> : null;
  const statusText = statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null;

  let resultSection: ReactNode = null;
  if (mode === 'stack' && stackOutcome && displayedStackImage) {
    resultSection = (
      <StackResultSection
        outcome={stackOutcome}
        displayedVersion={displayedStackVersion}
        displayedImage={displayedStackImage}
        onSelectVersion={setDisplayedStackVersion}
        onOpenViewer={handleOpenStackViewer}
        onSave={handleSaveStack}
        isSaving={isSaving}
      />
    );
  } else if (mode === 'trails' && trailOutcome?.skiaImage) {
    resultSection = (
      <>
        <SectionTitle>{t('trails.title')}</SectionTitle>
        <SkyResultImage
          skiaImage={trailOutcome.skiaImage}
          label={t('trails.title')}
          onPress={() => openViewer([{ skiaImage: trailOutcome.skiaImage, caption: t('trails.title'), fileNamePrefix: 'trazos' }])}
        />
        <BodyText tone="secondary">
          {t('trails.summary', {
            frames: trailOutcome.frameCount,
            elapsed: formatElapsedTime(trailOutcome.elapsedMilliseconds),
            copies: trailOutcome.insertedCopyCount,
          })}
        </BodyText>
        {trailOutcome.isFinished ? (
          <AppButton label={t('core:common.save')} onPress={handleSaveTrails} isBusy={isSaving} />
        ) : null}
      </>
    );
  } else if (mode === 'meteors' && meteorWatch.session) {
    resultSection = (
      <MeteorSection
        session={meteorWatch.session}
        isWatching={meteorWatch.isWatching}
        onOpenEvent={handleOpenMeteorViewer}
        onSave={handleSaveMeteors}
        isSaving={isSaving}
      />
    );
  }

  const primaryAction = isStopVisible ? (
    <AppButton label={t('stop')} onPress={handleStop} variant="danger" />
  ) : (
    <AppButton label={startLabel} onPress={handleStart} isDisabled={!isCameraAllowed} isBusy={activity === 'processing'} />
  );

  let fullScreenReadout: ReactNode;
  if (progressText) {
    fullScreenReadout = <CameraOverlayText style={styles.readoutValue}>{progressText}</CameraOverlayText>;
  } else if (meteorWatch.isWatching && meteorWatch.session) {
    fullScreenReadout = (
      <CameraOverlayText style={styles.readoutValue}>
        {t('meteors.liveCount', {
          meteors: meteorWatch.session.statistics.meteorCount,
          elapsed: formatElapsedTime(meteorWatch.session.statistics.watchedMilliseconds),
        })}
      </CameraOverlayText>
    );
  } else {
    fullScreenReadout = <CameraOverlayText>{t(`modes.${mode}`)}</CameraOverlayText>;
  }

  const cameraOutputs = mode === 'meteors' ? [meteorWatch.frameOutput] : [photoBurst.photoOutput];

  return (
    <CameraScreenLayout
      title={t('name')}
      aboveNormalPreview={<BodyText tone="secondary">{t('intro')}</BodyText>}
      renderPreview={() => (
        <>
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={cameraDevice ?? 'back'}
            isActive={isCameraAllowed}
            outputs={cameraOutputs}
            // Fotos orientadas como la pantalla (vertical), no según cómo se sujete el móvil.
            orientationSource="interface"
            onError={handleCameraError}
            onStarted={handleCameraStarted}
            resizeMode="contain"
          />
          {/* Aquí porque la vista previa está montada en los dos modos (el visor es un Modal). */}
          {resultImageViewer.openedIndex !== null ? (
            <Suspense fallback={null}>
              <ImageViewer
                images={resultImageViewer.viewerImages}
                openedIndex={resultImageViewer.openedIndex}
                onClose={resultImageViewer.closeViewer}
              />
            </Suspense>
          ) : null}
        </>
      )}
      topActions={
        !isBusy ? (
          <CameraOverlayButton
            label={t(nightCamera.appliedSettings ? 'nightView.disable' : 'nightView.enable')}
            onPress={() => void (nightCamera.appliedSettings ? disableNightView() : enableNightView())}
          />
        ) : null
      }
      readout={fullScreenReadout}
      primaryActions={<View style={styles.primaryActionCell}>{primaryAction}</View>}
      panelContent={
        <>
          {settingsSection}
          {nightSettingsText}
          {processingIndicator}
          {resultSection}
          {statusText}
          <NightSkyAdvice locationAvailability={sensorAvailability.location} />
        </>
      }
      panelOpenRequestKey={resultSequenceNumber > 0 ? resultSequenceNumber : null}>
      {settingsSection}
      {nightSettingsText}
      {progressSection}
      {processingIndicator}
      {primaryAction}
      {resultSection}
      {statusText}
      <NightSkyAdvice locationAvailability={sensorAvailability.location} />
      <BodyText tone="secondary" style={styles.smallText}>
        {t('howItWorks')}
      </BodyText>
    </CameraScreenLayout>
  );
}

function NightSettingsText({ settings }: { settings: AppliedNightSettings }) {
  const { t } = useTranslation(starSkyInstrumentId);
  const parts: string[] = [];
  parts.push(
    settings.exposureSeconds !== null && settings.iso !== null
      ? t('nightView.exposure', { milliseconds: Math.round(settings.exposureSeconds * 1000), iso: settings.iso })
      : t('nightView.automaticExposure'),
  );
  parts.push(t(settings.isFocusAtInfinity ? 'nightView.focusInfinity' : 'nightView.focusAutomatic'));
  if (settings.isWhiteBalanceLocked) parts.push(t('nightView.whiteBalanceLocked'));
  return (
    <BodyText tone="secondary" style={styles.smallText}>
      {parts.join(' · ')}
    </BodyText>
  );
}

function StackResultSection({
  outcome,
  displayedVersion,
  displayedImage,
  onSelectVersion,
  onOpenViewer,
  onSave,
  isSaving,
}: {
  outcome: StackOutcome;
  displayedVersion: StackVersion;
  displayedImage: SkImage;
  onSelectVersion(version: StackVersion): void;
  onOpenViewer(): void;
  onSave(): void;
  isSaving: boolean;
}) {
  const { t } = useTranslation(starSkyInstrumentId);
  const { summary, stackResult, geometry } = outcome;
  const magnitudeText = (limitingMagnitude: number | null) =>
    limitingMagnitude === null ? t('stack.magnitudeUnknown') : t('stack.magnitudeValue', { magnitude: limitingMagnitude.toFixed(1) });
  return (
    <>
      <SectionTitle>{t('stack.title')}</SectionTitle>
      <SkyChoiceChips<StackVersion>
        options={['stacked', 'single']}
        selectedOption={displayedVersion}
        labelFor={(version) => t(`stack.versions.${version}`)}
        onSelect={onSelectVersion}
      />
      <SkyResultImage skiaImage={displayedImage} label={t(`stack.versions.${displayedVersion}`)} onPress={onOpenViewer} />
      <BodyText tone="secondary" style={styles.smallText}>
        {t('stack.compareHint')}
      </BodyText>
      <BodyText>
        {t('stack.starCounts', { stacked: summary.starsInStack, single: summary.starsInSingleFrame })}
      </BodyText>
      <BodyText>
        {t('stack.limitingMagnitudes', {
          stacked: magnitudeText(summary.limitingMagnitudeStack),
          single: magnitudeText(summary.limitingMagnitudeSingle),
        })}
      </BodyText>
      <BodyText tone="secondary">
        {t('stack.noiseReduction', {
          factor: summary.noiseReductionFactor.toFixed(1),
          expected: Math.sqrt(stackResult.stackedFrameCount).toFixed(1),
          gain: summary.expectedGainMagnitudes.toFixed(1),
        })}
      </BodyText>
      <BodyText tone="secondary">
        {t('stack.alignment', {
          stacked: stackResult.stackedFrameCount,
          captured: outcome.capturedFrameCount,
          rotation: stackResult.largestRotationDegrees.toFixed(2),
          shift: stackResult.largestCenterShiftPixels.toFixed(1),
        })}
      </BodyText>
      {summary.unalignedFrameCount > 0 ? (
        <BodyText tone="danger">{t('stack.unaligned', { frames: summary.unalignedFrameCount })}</BodyText>
      ) : null}
      <BodyText tone="secondary">
        {t('stack.field', {
          width: geometry.fieldOfView.widthDegrees.toFixed(0),
          height: geometry.fieldOfView.heightDegrees.toFixed(0),
          scale: (geometry.fieldOfView.pixelScaleArcseconds / Math.max(1e-6, geometry.outputScale)).toFixed(0),
          gradient: stackResult.stacked.gradientRangeLevels.toFixed(0),
          rejected: (stackResult.rejectedSampleFraction * 100).toFixed(1),
        })}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('stack.magnitudeCaveat')}
      </BodyText>
      <AppButton label={t('core:common.save')} onPress={onSave} isBusy={isSaving} />
    </>
  );
}

function MeteorSection({
  session,
  isWatching,
  onOpenEvent,
  onSave,
  isSaving,
}: {
  session: NonNullable<ReturnType<typeof useMeteorWatch>['session']>;
  isWatching: boolean;
  onOpenEvent(eventIndex: number): void;
  onSave(): void;
  isSaving: boolean;
}) {
  const { t } = useTranslation(starSkyInstrumentId);
  const { statistics, events } = session;
  const hourlyRate = meteorsPerHour(statistics.meteorCount, statistics.watchedMilliseconds);
  const latestEvent = events[events.length - 1];
  const latestEventImage = useMemo(
    () => (latestEvent ? createSkyImage(latestEvent.frameBytes, latestEvent.width, latestEvent.height, 1) : null),
    [latestEvent],
  );
  return (
    <>
      <SectionTitle>{t('meteors.title')}</SectionTitle>
      <BodyText style={styles.progressText}>
        {t('meteors.count', { meteors: statistics.meteorCount, elapsed: formatElapsedTime(statistics.watchedMilliseconds) })}
      </BodyText>
      <BodyText tone="secondary">
        {hourlyRate === null ? t('meteors.rateTooShort') : t('meteors.rate', { rate: hourlyRate.toFixed(1) })}
      </BodyText>
      <BodyText tone="secondary">
        {t('meteors.statistics', {
          frames: statistics.processedFrameCount,
          skipped: statistics.skippedFrameCount,
          slow: statistics.rejectedSlowMoverCount,
        })}
      </BodyText>
      {isWatching && statistics.processedFrameCount === 0 ? <BodyText tone="secondary">{t('meteors.warmingUp')}</BodyText> : null}
      {latestEvent && latestEventImage ? (
        <>
          <BodyText tone="secondary">{t('meteors.latest', { time: latestEvent.detectedAt.toLocaleTimeString() })}</BodyText>
          <SkyResultImage
            skiaImage={latestEventImage}
            label={t('meteors.latest', { time: latestEvent.detectedAt.toLocaleTimeString() })}
            highlightedSegment={latestEvent.segment}
            onPress={() => onOpenEvent(events.length - 1)}
          />
        </>
      ) : null}
      {events.map((meteorEvent, eventIndex) => (
        <AppButton
          key={`${meteorEvent.frameIndex}-${meteorEvent.timestampMilliseconds}`}
          label={t('meteors.eventRow', {
            number: eventIndex + 1,
            time: meteorEvent.detectedAt.toLocaleTimeString(),
            length: Math.round(meteorEvent.segment.lengthPixels),
          })}
          onPress={() => onOpenEvent(eventIndex)}
          variant="secondary"
        />
      ))}
      {!isWatching ? <AppButton label={t('core:common.save')} onPress={onSave} isBusy={isSaving} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13 },
  progressText: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexCell: { flex: 1 },
  primaryActionCell: { flex: 1 },
  readoutValue: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
