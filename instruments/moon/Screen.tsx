import { Canvas, Image as SkiaImageView, type SkImage } from '@shopify/react-native-skia';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { formatExposureValue, stepExposure } from '@/core/camera/exposureScale';
import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { type PixelSize, scalePointBetweenImages, squareCropAround } from '@/core/camera/photoCropGeometry';
import { containedFrameRect } from '@/core/camera/previewGeometry';
import { useCameraZoomAndExposure } from '@/core/camera/useCameraZoomAndExposure';
import { useDeviceSteadiness } from '@/core/camera/useDeviceSteadiness';
import { type PhotoBurstTimings, usePhotoBurst } from '@/core/camera/usePhotoBurst';
import { useResultImageViewer } from '@/core/camera/useResultImageViewer';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { PointingGuidance } from '@/processing/astronomy/pointingGuide';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { formatExposureDuration, initialLunarExposureSeconds } from '@/processing/image/lunarExposure';
import { locateMoonInRegion, medianValue, moonCropFromRegion, moonSearchRegionSide } from '@/processing/image/lunarPhotoCrops';
import {
  type AlignedCrop,
  chooseCropSize,
  type FloatRgbImage,
  sharpenImage,
  sharpeningSigmaForCropSize,
  stackSharpestCrops,
} from '@/processing/image/lunarStacking';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { moonInstrumentId } from './instrumentId';
import { MoonInfoCard, useMoonReport, useObserverLocation } from './MoonInfoCard';
import type { MoonMeasurementValues } from './schema';
import { createSkiaImage } from './stackedImage';
import { type LiveMoonDetection, useMoonFrames } from './useMoonFrames';
import { useLunarManualExposure } from './useLunarManualExposure';
import { useMoonPointingGuide } from './useMoonPointingGuide';

/**
 * El visor se carga al abrirlo: arrastra módulos nativos (galería, compartir) que no hacen falta
 * hasta entonces y que no existen en los tests que importan todos los instrumentos.
 */
const ImageViewer = lazy(() => import('@/ui/ImageViewer').then((viewerModule) => ({ default: viewerModule.ImageViewer })));

const previewHeight = 340;

/**
 * Sin óptica, la cámara del móvil ve la Luna de unas decenas de píxeles: fase y mares. Con el
 * móvil en el ocular de unos prismáticos o un telescopio («digiscoping») la Luna es mucho más
 * grande y se ven cráteres; se apilan más fotos y se realza más.
 */
type MoonCaptureMode = 'nakedEye' | 'telescope';

interface CaptureModeSettings {
  /** Fotos de cada ráfaga, a resolución completa (unos 3-6 s). */
  photoCount: number;
  /** Lado máximo del recorte que se apila (el cálculo crece con el área). */
  maximumStackCropSize: number;
  defaultSharpeningLevelIndex: number;
  /** Exposición con la que empieza el ajuste automático sobre la Luna. */
  initialExposureSeconds: number;
}

const captureModeSettings: Record<MoonCaptureMode, CaptureModeSettings> = {
  nakedEye: {
    photoCount: 12,
    maximumStackCropSize: 600,
    defaultSharpeningLevelIndex: 2,
    initialExposureSeconds: initialLunarExposureSeconds,
  },
  telescope: {
    photoCount: 20,
    maximumStackCropSize: 1024,
    defaultSharpeningLevelIndex: 3,
    // Resuelta por el ocular, la Luna no se reparte en un borrón: sus píxeles salen más claros.
    initialExposureSeconds: initialLunarExposureSeconds / 2,
  },
};
const captureModes: readonly MoonCaptureMode[] = ['nakedEye', 'telescope'];
/** Fracción más nítida que se apila; el resto se descarta por la turbulencia o el temblor. */
const keptFrameFraction = 0.5;
/** Zonas de búsqueda más grandes se reducen (en nativo) a este lado antes de pasarlas a JS. */
const maximumSearchRegionOutputSide = 1024;
/** Detecciones con un radio muy distinto del típico de la ráfaga son reflejos o errores. */
const radiusToleranceFraction = 0.3;
/** Niveles de realce del detalle (máscara de enfoque) que se pueden elegir tras apilar. */
const sharpeningLevels = [
  { labelKey: 'sharpening.none', amount: 0 },
  { labelKey: 'sharpening.soft', amount: 0.6 },
  { labelKey: 'sharpening.medium', amount: 1.2 },
  { labelKey: 'sharpening.strong', amount: 2 },
] as const;
/** Cuenta atrás antes de capturar, para que el toque en la pantalla no mueva la imagen. */
const captureCountdownSeconds = 3;
const zoomStepFactor = Math.SQRT2;
/** Por encima de esta fracción de píxeles saturados, los mares y cráteres se pierden. */
const overexposedSaturatedFraction = 0.02;
/** Brillo máximo (R+G+B) por debajo del cual la Luna sale demasiado oscura. */
const underexposedPeakBrightness = 300;
/** Por debajo de esta distancia angular la Luna ya está en el centro de la imagen. */
const centeredGuideDegrees = 4;
/** Correcciones más pequeñas no se indican (la brújula no es tan precisa). */
const negligibleCorrectionDegrees = 2;
/** En modo telescopio, a partir de esta distancia al centro (fracción del lado corto) se avisa. */
const offCenterFraction = 0.15;
/** Diámetro del círculo guía del ocular, como fracción del lado corto de la imagen. */
const eyepieceGuideFraction = 0.8;

interface StackingOutcome {
  /** Apilado sin realzar: el realce se aplica después, según el nivel elegido. */
  stackedBaseImage: FloatRgbImage;
  sharpeningSigma: number;
  bestSingleSkiaImage: SkImage;
  capturedFrameCount: number;
  rejectedFrameCount: number;
  stackedFrameCount: number;
  /** Diámetro de la Luna en píxeles de la foto a resolución completa. */
  moonDiameterPixels: number;
  zoomFactor: number;
  captureMode: MoonCaptureMode;
  burstTimings: PhotoBurstTimings;
  exposureBias?: number;
  /** Con exposición manual: tiempo de exposición en segundos e ISO. */
  exposureSeconds?: number;
  iso?: number;
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

/** Diámetro de la Luna detectada en la vista previa, llevado a píxeles de la foto. */
function moonDiameterInPhotoPixels(detection: LiveMoonDetection, photoSize: PixelSize): number {
  return Math.round(detection.radiusPixels * 2 * (photoSize.width / detection.frameWidth));
}

export function MoonScreen({ saveMeasurement, sensorAvailability }: InstrumentScreenProps<MoonMeasurementValues>) {
  const { t } = useTranslation(moonInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const { observerLocation, isLocating, requestLocation, canAskForLocation } = useObserverLocation(
    sensorAvailability.location,
  );
  const moonReport = useMoonReport(observerLocation);
  const hasGyroscope = sensorAvailability.gyroscope.status === 'available';
  const { isDeviceSteady, isSteadyForDisplay } = useDeviceSteadiness(isCameraAllowed, hasGyroscope);
  const [captureMode, setCaptureMode] = useState<MoonCaptureMode>('nakedEye');
  const modeSettings = captureModeSettings[captureMode];
  // Desde la cuenta atrás hasta el final de la captura, la exposición no cambia.
  const [isCaptureInProgress, setIsCaptureInProgress] = useState(false);
  // La captura espera varias veces (cuenta atrás, ráfaga): si se sale de la pantalla entretanto,
  // no se sigue (ni se ocupa el hilo JS apilando) en la pantalla siguiente.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  // La exposición automática mide sobre todo el cielo negro y quema la Luna, incluso con la
  // compensación al mínimo. Si el móvil lo admite, se fija el tiempo de exposición midiendo solo la Luna.
  const lunarManualExposure = useLunarManualExposure(cameraRef, cameraDevice, isCaptureInProgress);
  const { frameOutput, liveDetection } = useMoonFrames(lunarManualExposure.handleBrightnessReading);
  // La ráfaga lee la última detección al empezar (tras la cuenta atrás), no la del toque.
  const latestDetectionRef = useRef<LiveMoonDetection | null>(null);
  useEffect(() => {
    latestDetectionRef.current = liveDetection;
  }, [liveDetection]);
  const photoBurst = usePhotoBurst();
  const resultImageViewer = useResultImageViewer();
  const hasOrientationSensors =
    sensorAvailability.accelerometer.status === 'available' && sensorAvailability.magnetometer.status === 'available';
  const pointingGuidance = useMoonPointingGuide(
    moonReport.horizontalPosition,
    isCameraAllowed && hasOrientationSensors && captureMode === 'nakedEye',
  );

  // La Luna es muy brillante sobre fondo negro: con la exposición automática sale quemada.
  const {
    zoomFactor,
    minimumZoom,
    maximumZoom,
    setRequestedZoom,
    exposureScale,
    exposureBias,
    minimumExposureBias,
    maximumExposureBias,
    setRequestedExposureBias,
    handleCameraStarted: handleZoomAndExposureCameraStarted,
  } = useCameraZoomAndExposure(cameraRef, cameraDevice, true);

  function handleCameraStarted() {
    handleZoomAndExposureCameraStarted();
    lunarManualExposure.handleCameraStarted();
    photoBurst.handleCameraStarted();
  }

  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [stackingOutcome, setStackingOutcome] = useState<StackingOutcome | null>(null);
  const [sharpeningLevelIndex, setSharpeningLevelIndex] = useState(captureModeSettings.nakedEye.defaultSharpeningLevelIndex);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<PixelSize>({ width: 0, height: 0 });

  const stackedSkiaImage = useMemo(() => {
    if (!stackingOutcome) return null;
    const sharpeningAmount = sharpeningLevels[sharpeningLevelIndex]?.amount ?? 0;
    const displayedImage =
      sharpeningAmount > 0
        ? sharpenImage(stackingOutcome.stackedBaseImage, stackingOutcome.sharpeningSigma, sharpeningAmount)
        : stackingOutcome.stackedBaseImage;
    return createSkiaImage(displayedImage);
  }, [stackingOutcome, sharpeningLevelIndex]);

  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);
  const isBusy = isCaptureInProgress || isProcessing;

  function handleSelectCaptureMode(nextCaptureMode: MoonCaptureMode) {
    if (nextCaptureMode === captureMode || isBusy) return;
    setCaptureMode(nextCaptureMode);
    setSharpeningLevelIndex(captureModeSettings[nextCaptureMode].defaultSharpeningLevelIndex);
    // Por el ocular la Luna es otra: se vuelve a ajustar la luz desde una exposición corta.
    lunarManualExposure.restartAutomatic(captureModeSettings[nextCaptureMode].initialExposureSeconds);
  }

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    if (!canMeter || !cameraDevice || isBusy) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    // Con la exposición manual, tocar solo enfoca: la luz ya se mide sobre la Luna.
    if (cameraDevice.supportsExposureMetering && !lunarManualExposure.isManualExposureActive) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    setMeteringViewPoint(viewPoint);
    try {
      // Mide y enfoca en la Luna y lo deja fijo: el cielo negro ya no engaña a la exposición automática.
      await cameraRef.current?.focusTo(viewPoint, {
        modes: meteringModes,
        responsiveness: 'snappy',
        adaptiveness: 'locked',
        autoResetAfter: null,
      });
      // Tras medir sobre la Luna, se vuelve a aplicar la compensación sobre esa medida.
      if (!lunarManualExposure.isManualExposureActive && exposureBias !== undefined) {
        await cameraRef.current?.controller?.setExposureBias(exposureBias);
      }
    } catch {
      // Cancelado por otro toque o no admitido: la vista previa sigue funcionando.
    }
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function handleUnlockMetering() {
    setMeteringViewPoint(null);
    try {
      await cameraRef.current?.resetFocus();
    } catch {
      // La cámara puede no estar lista; no hay nada que deshacer.
    } finally {
      // `resetFocus` también quita la exposición manual (aunque falle después de quitarla).
      lunarManualExposure.reapplyExposure();
    }
  }

  async function handleCapture() {
    if (!liveDetection) return;
    const captureSettings = modeSettings;
    const captureModeAtStart = captureMode;
    const captureZoomFactor = zoomFactor;
    const captureExposureBias = exposureBias;
    setStackingOutcome(null);
    setStatusMessage(null);
    setIsCaptureInProgress(true);
    const captureExposureSeconds = lunarManualExposure.isManualExposureActive
      ? lunarManualExposure.exposureSeconds
      : undefined;
    const captureIso = lunarManualExposure.isManualExposureActive ? lunarManualExposure.iso : undefined;
    for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
      setCountdownSecondsLeft(secondsLeft);
      await waitMilliseconds(1000);
      if (!isMountedRef.current) return;
    }
    setCountdownSecondsLeft(null);
    const detectionAtBurstStart = latestDetectionRef.current;
    if (!detectionAtBurstStart) {
      setIsCaptureInProgress(false);
      setStatusMessage(t('moonLostDuringCapture'));
      return;
    }
    const detectionFrameSize = { width: detectionAtBurstStart.frameWidth, height: detectionAtBurstStart.frameHeight };
    let burstResult;
    try {
      burstResult = await photoBurst.captureBurst({
        photoCount: captureSettings.photoCount,
        // Una foto tomada mientras el móvil se mueve sale corrida: no aporta, emborrona.
        isPhotoUsable: isDeviceSteady,
        maximumOutputSide: maximumSearchRegionOutputSide,
        // Solo se decodifica la zona donde estaba la Luna en la vista previa, con margen.
        planCrop: (uprightPhotoSize) => {
          const photoPixelsPerFramePixel = uprightPhotoSize.width / detectionFrameSize.width;
          const expectedCenter = scalePointBetweenImages(
            { x: detectionAtBurstStart.centerX, y: detectionAtBurstStart.centerY },
            detectionFrameSize,
            uprightPhotoSize,
          );
          const searchRegionSide = moonSearchRegionSide(
            detectionAtBurstStart.radiusPixels * photoPixelsPerFramePixel,
            Math.min(uprightPhotoSize.width, uprightPhotoSize.height),
          );
          return squareCropAround(expectedCenter, searchRegionSide, uprightPhotoSize);
        },
      });
    } catch (burstError) {
      setIsCaptureInProgress(false);
      setStatusMessage(t('core:common.error', { message: String(burstError) }));
      return;
    }
    if (!isMountedRef.current) return;
    setIsCaptureInProgress(false);
    const steadyCrops = burstResult.crops.filter((photoCrop) => photoCrop.wasMarkedUsable);
    const rejectedFrameCount = burstResult.crops.length - steadyCrops.length;
    if (steadyCrops.length === 0) {
      setStatusMessage(
        rejectedFrameCount > 0
          ? t('tooMuchMovement')
          : burstResult.firstErrorMessage
            ? t('burstFailed', { message: burstResult.firstErrorMessage })
            : t('moonLostDuringCapture'),
      );
      return;
    }
    setIsProcessing(true);
    // Deja que se pinte el indicador antes del cálculo, que ocupa el hilo JS unos segundos.
    await waitMilliseconds(50);
    if (!isMountedRef.current) return;
    try {
      const moonDetections = steadyCrops.map((photoCrop) =>
        locateMoonInRegion(photoCrop.rgbPixels, photoCrop.width, photoCrop.height),
      );
      const typicalRadius = medianValue(
        moonDetections.flatMap((moonDetection) => (moonDetection ? [moonDetection.radiusPixels] : [])),
      );
      if (typicalRadius <= 0) {
        setStatusMessage(t('moonLostDuringCapture'));
        return;
      }
      const cropSize = chooseCropSize(typicalRadius, 96, captureSettings.maximumStackCropSize);
      const alignedCrops: AlignedCrop[] = [];
      steadyCrops.forEach((photoCrop, cropIndex) => {
        const moonDetection = moonDetections[cropIndex];
        // Un radio muy distinto del típico es un reflejo, una nube o la Luna cortada por el borde.
        if (!moonDetection || Math.abs(moonDetection.radiusPixels - typicalRadius) > typicalRadius * radiusToleranceFraction) {
          return;
        }
        const moonCrop = moonCropFromRegion(photoCrop.rgbPixels, photoCrop.width, photoCrop.height, cropSize, moonDetection);
        if (moonCrop) alignedCrops.push(moonCrop.alignedCrop);
      });
      if (alignedCrops.length === 0) {
        setStatusMessage(t('moonLostDuringCapture'));
        return;
      }
      const stackingResult = stackSharpestCrops(alignedCrops, cropSize, keptFrameFraction, 0);
      const bestSingleSkiaImage = createSkiaImage(stackingResult.bestSingleImage);
      if (!bestSingleSkiaImage) throw new Error('Skia no pudo crear la imagen');
      const outputScale = steadyCrops[0]?.outputScale ?? 1;
      setSharpeningLevelIndex(captureSettings.defaultSharpeningLevelIndex);
      setStackingOutcome({
        stackedBaseImage: stackingResult.stackedImage,
        sharpeningSigma: sharpeningSigmaForCropSize(cropSize),
        bestSingleSkiaImage,
        capturedFrameCount: burstResult.timings.capturedPhotoCount,
        rejectedFrameCount,
        stackedFrameCount: stackingResult.usedCropCount,
        moonDiameterPixels: Math.round((typicalRadius * 2) / outputScale),
        zoomFactor: captureZoomFactor,
        captureMode: captureModeAtStart,
        burstTimings: burstResult.timings,
        ...(captureExposureSeconds !== undefined && captureIso !== undefined
          ? { exposureSeconds: captureExposureSeconds, iso: captureIso }
          : captureExposureBias !== undefined
            ? { exposureBias: captureExposureBias }
            : {}),
      });
    } catch (processingError) {
      setStatusMessage(t('core:common.error', { message: String(processingError) }));
    } finally {
      setIsProcessing(false);
    }
  }

  function handleOpenFullSize() {
    if (!stackingOutcome || !stackedSkiaImage) return;
    resultImageViewer.openViewer([
      {
        skiaImage: stackedSkiaImage,
        caption: t('stackedFrames', { count: stackingOutcome.stackedFrameCount }),
        fileNamePrefix: 'luna-apilada',
      },
      { skiaImage: stackingOutcome.bestSingleSkiaImage, caption: t('bestSingleFrame'), fileNamePrefix: 'luna-mejor' },
    ]);
  }

  async function handleSave() {
    if (!stackingOutcome || !stackedSkiaImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    const roundTo = (numericValue: number, fractionDigits: number) =>
      Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    const horizontalPosition = moonReport.horizontalPosition;
    try {
      const pngFile = writeImageToCachePng(stackedSkiaImage, 'luna');
      await saveMeasurement({
        values: {
          phaseName: moonReport.phaseName,
          illuminatedPercent: roundTo(moonReport.illuminatedFraction * 100, 1),
          ageDays: roundTo(moonReport.ageDays, 2),
          distanceKilometers: Math.round(moonReport.distanceKilometers),
          apparentDiameterArcminutes: roundTo(moonReport.apparentDiameterArcminutes, 2),
          ...(horizontalPosition
            ? {
                moonAltitudeDegrees: roundTo(horizontalPosition.altitudeDegrees, 1),
                moonAzimuthDegrees: roundTo(horizontalPosition.azimuthDegrees, 1),
              }
            : {}),
          capturedFrameCount: stackingOutcome.capturedFrameCount,
          stackedFrameCount: stackingOutcome.stackedFrameCount,
          moonDiameterPixels: stackingOutcome.moonDiameterPixels,
          zoomFactor: roundTo(stackingOutcome.zoomFactor, 2),
          ...(stackingOutcome.exposureSeconds !== undefined && stackingOutcome.iso !== undefined
            ? { exposureMilliseconds: roundTo(stackingOutcome.exposureSeconds * 1000, 3), iso: stackingOutcome.iso }
            : {}),
          ...(stackingOutcome.exposureBias === undefined
            ? {}
            : exposureScale.isStepIndex
              ? { exposureCompensationSteps: stackingOutcome.exposureBias }
              : { exposureBias: stackingOutcome.exposureBias }),
          sharpeningAmount: sharpeningLevels[sharpeningLevelIndex]?.amount ?? 0,
          throughOptics: stackingOutcome.captureMode === 'telescope',
        },
        attachments: [
          {
            kind: 'photo',
            sourceUri: pngFile.uri,
            fileName: 'luna.png',
            mimeType: 'image/png',
            metadata: {
              widthPixels: stackedSkiaImage.width(),
              heightPixels: stackedSkiaImage.height(),
              stackedFrameCount: stackingOutcome.stackedFrameCount,
            },
          },
        ],
      });
      pngFile.delete();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const moonDiameterPixels = liveDetection ? moonDiameterInPhotoPixels(liveDetection, photoBurst.uprightPhotoSize) : 0;
  const isExposureAtMinimum = exposureBias === undefined || exposureBias <= minimumExposureBias;
  const exposureHint = !liveDetection
    ? null
    : lunarManualExposure.isManualExposureActive
      ? liveDetection.saturatedFraction > overexposedSaturatedFraction && !lunarManualExposure.isAutomatic
        ? t('overexposedHint')
        : null
      : liveDetection.saturatedFraction > overexposedSaturatedFraction
      ? t(isExposureAtMinimum ? 'overexposedAtMinimumHint' : 'overexposedHint')
      : liveDetection.peakBrightness < underexposedPeakBrightness
        ? t('underexposedHint')
        : null;
  const isMoonOffCenter =
    liveDetection !== null &&
    Math.hypot(
      liveDetection.centerX - liveDetection.frameWidth / 2,
      liveDetection.centerY - liveDetection.frameHeight / 2,
    ) >
      offCenterFraction * Math.min(liveDetection.frameWidth, liveDetection.frameHeight);
  const captureProgress = photoBurst.captureProgress;

  return (
    <ScreenContainer>
      <MoonInfoCard
        moonReport={moonReport}
        hasObserverLocation={observerLocation !== null}
        isLocating={isLocating}
        canAskForLocation={canAskForLocation}
        onRequestLocation={() => void requestLocation()}
      />

      <SectionTitle>{t('captureModeTitle')}</SectionTitle>
      <View style={styles.chipRow}>
        {captureModes.map((modeOption) => {
          const isSelectedMode = modeOption === captureMode;
          return (
            <Pressable
              key={modeOption}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedMode, disabled: isBusy }}
              disabled={isBusy}
              onPress={() => handleSelectCaptureMode(modeOption)}
              style={[styles.chip, { borderColor: isSelectedMode ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelectedMode ? 'accent' : 'secondary'}>{t(`captureModes.${modeOption}`)}</BodyText>
            </Pressable>
          );
        })}
      </View>
      <BodyText tone="secondary">{t(captureMode === 'nakedEye' ? 'nakedEyeLimitation' : 'telescopeIntro')}</BodyText>

      <View
        style={[styles.previewContainer, { borderColor: themePalette.border }]}
        onLayout={(layoutEvent: LayoutChangeEvent) => {
          const { width, height } = layoutEvent.nativeEvent.layout;
          setPreviewSize((previousSize) =>
            previousSize.width === width && previousSize.height === height ? previousSize : { width, height },
          );
        }}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={cameraDevice ?? 'back'}
          isActive={isCameraAllowed}
          outputs={[frameOutput, photoBurst.photoOutput]}
          // Fotos orientadas como la pantalla (vertical) aunque se apunte al cielo o se gire el móvil.
          orientationSource="interface"
          zoom={zoomFactor}
          exposure={exposureBias}
          onError={handleCameraError}
          onStarted={handleCameraStarted}
          resizeMode="contain"
        />
        {captureMode === 'telescope' && previewSize.width > 0 ? (
          <TelescopeGuideOverlay previewSize={previewSize} liveDetection={liveDetection} isMoonOffCenter={isMoonOffCenter} />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tapToMeterHint')}
          style={StyleSheet.absoluteFill}
          onPress={(pressEvent) => void handlePreviewPress(pressEvent)}>
          {meteringViewPoint ? (
            <View
              pointerEvents="none"
              style={[
                styles.meteringMarker,
                { left: meteringViewPoint.x - meteringMarkerRadius, top: meteringViewPoint.y - meteringMarkerRadius },
              ]}
            />
          ) : null}
        </Pressable>
        {pointingGuidance && !liveDetection ? (
          <PointingOverlay
            pointingGuidance={pointingGuidance}
            isBelowHorizon={(moonReport.horizontalPosition?.altitudeDegrees ?? 0) < 0}
          />
        ) : null}
        {resultImageViewer.openedIndex !== null ? (
          <Suspense fallback={null}>
            <ImageViewer
              images={resultImageViewer.viewerImages}
              openedIndex={resultImageViewer.openedIndex}
              onClose={resultImageViewer.closeViewer}
            />
          </Suspense>
        ) : null}
      </View>
      {pointingGuidance ? <BodyText tone="secondary">{t('compassCalibrationHint')}</BodyText> : null}
      {!moonReport.horizontalPosition && hasOrientationSensors && captureMode === 'nakedEye' ? (
        <BodyText tone="secondary">{t('guideNeedsLocation')}</BodyText>
      ) : null}

      <BodyText tone={liveDetection ? 'primary' : 'secondary'}>
        {liveDetection
          ? t('moonDetected', { diameter: moonDiameterPixels })
          : t(captureMode === 'nakedEye' ? 'moonNotDetected' : 'telescopeMoonNotDetected')}
      </BodyText>
      {captureMode === 'telescope' && isMoonOffCenter ? (
        <BodyText tone="danger">{t('telescopeOffCenter')}</BodyText>
      ) : null}
      {exposureHint ? <BodyText tone="danger">{exposureHint}</BodyText> : null}
      {liveDetection && hasGyroscope && !photoBurst.isCapturing ? (
        <BodyText tone={isSteadyForDisplay ? 'secondary' : 'danger'}>
          {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
        </BodyText>
      ) : null}

      <StepperRow
        label={t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}
        onDecrease={() => setRequestedZoom(Math.max(minimumZoom, zoomFactor / zoomStepFactor))}
        onIncrease={() => setRequestedZoom(Math.min(maximumZoom, zoomFactor * zoomStepFactor))}
        isDecreaseDisabled={isBusy || zoomFactor <= minimumZoom}
        isIncreaseDisabled={isBusy || zoomFactor >= maximumZoom}
        decreaseLabel={t('zoomOut')}
        increaseLabel={t('zoomIn')}
      />
      {lunarManualExposure.isManualExposureActive ? (
        <>
          <StepperRow
            label={t('exposureTimeLabel', {
              duration: formatExposureDuration(lunarManualExposure.exposureSeconds),
              iso: Math.round(lunarManualExposure.iso),
            })}
            onDecrease={lunarManualExposure.darken}
            onIncrease={lunarManualExposure.brighten}
            isDecreaseDisabled={isBusy || lunarManualExposure.isAtShortestExposure}
            isIncreaseDisabled={isBusy || lunarManualExposure.isAtLongestExposure}
            decreaseLabel={t('exposureDown')}
            increaseLabel={t('exposureUp')}
          />
          {lunarManualExposure.isAutomatic ? (
            <BodyText tone="secondary">{t('automaticLunarExposure')}</BodyText>
          ) : (
            <View style={styles.buttonRow}>
              <View style={styles.buttonCell}>
                <BodyText tone="secondary">{t('manualLunarExposure')}</BodyText>
              </View>
              <View style={styles.buttonCell}>
                <AppButton
                  label={t('useAutomaticLunarExposure')}
                  onPress={lunarManualExposure.enableAutomatic}
                  isDisabled={isBusy}
                  variant="secondary"
                />
              </View>
            </View>
          )}
        </>
      ) : exposureBias !== undefined ? (
        <StepperRow
          label={
            exposureScale.isStepIndex
              ? t('exposureStepsLabel', {
                  exposure: formatExposureValue(exposureScale, exposureBias),
                  minimum: formatExposureValue(exposureScale, minimumExposureBias),
                })
              : t('exposureLabel', { exposure: formatExposureValue(exposureScale, exposureBias) })
          }
          onDecrease={() => setRequestedExposureBias(stepExposure(exposureScale, exposureBias, -1))}
          onIncrease={() => setRequestedExposureBias(stepExposure(exposureScale, exposureBias, 1))}
          isDecreaseDisabled={isBusy || exposureBias <= minimumExposureBias}
          isIncreaseDisabled={isBusy || exposureBias >= maximumExposureBias}
          decreaseLabel={t('exposureDown')}
          increaseLabel={t('exposureUp')}
        />
      ) : (
        <BodyText tone="secondary">{t('exposureUnsupported')}</BodyText>
      )}
      {canMeter ? (
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <BodyText tone="secondary">{meteringViewPoint ? t('meteringLocked') : t('tapToMeterHint')}</BodyText>
          </View>
          {meteringViewPoint ? (
            <View style={styles.buttonCell}>
              <AppButton label={t('unlockMetering')} onPress={() => void handleUnlockMetering()} variant="secondary" />
            </View>
          ) : null}
        </View>
      ) : null}

      {photoBurst.isCapturing && captureProgress ? (
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <BodyText>
              {t(captureProgress.phase === 'capturing' ? 'capturingProgress' : 'decodingProgress', {
                captured: captureProgress.completedCount,
                target: captureProgress.totalCount,
              })}
            </BodyText>
          </View>
          {captureProgress.phase === 'capturing' ? (
            <View style={styles.buttonCell}>
              <AppButton label={t('stopCapture')} onPress={photoBurst.stopCapture} variant="secondary" />
            </View>
          ) : null}
        </View>
      ) : (
        <AppButton
          label={
            countdownSecondsLeft !== null
              ? t('captureCountdown', { seconds: countdownSecondsLeft })
              : t('captureAndStack', { count: modeSettings.photoCount })
          }
          onPress={() => void handleCapture()}
          isBusy={isProcessing}
          isDisabled={!liveDetection || isBusy}
        />
      )}

      {stackingOutcome && stackedSkiaImage ? (
        <Card>
          <SectionTitle>{t('resultTitle')}</SectionTitle>
          <Pressable accessibilityRole="button" accessibilityLabel={t('openFullSize')} onPress={handleOpenFullSize}>
            <View style={styles.resultRow}>
              <ResultImage label={t('bestSingleFrame')} skiaImage={stackingOutcome.bestSingleSkiaImage} />
              <ResultImage
                label={t('stackedFrames', { count: stackingOutcome.stackedFrameCount })}
                skiaImage={stackedSkiaImage}
              />
            </View>
          </Pressable>
          <AppButton label={t('openFullSize')} onPress={handleOpenFullSize} variant="secondary" />
          <BodyText tone="secondary">{t('sharpeningTitle')}</BodyText>
          <View style={styles.chipRow}>
            {sharpeningLevels.map((sharpeningLevel, levelIndex) => {
              const isSelectedLevel = levelIndex === sharpeningLevelIndex;
              return (
                <Pressable
                  key={sharpeningLevel.labelKey}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelectedLevel }}
                  onPress={() => setSharpeningLevelIndex(levelIndex)}
                  style={[styles.chip, { borderColor: isSelectedLevel ? themePalette.accent : themePalette.border }]}>
                  <BodyText tone={isSelectedLevel ? 'accent' : 'secondary'}>{t(sharpeningLevel.labelKey)}</BodyText>
                </Pressable>
              );
            })}
          </View>
          <BodyText tone="secondary">
            {t('stackingExplanation', {
              captured: stackingOutcome.capturedFrameCount,
              stacked: stackingOutcome.stackedFrameCount,
              diameter: stackingOutcome.moonDiameterPixels,
            })}
          </BodyText>
          {stackingOutcome.rejectedFrameCount > 0 ? (
            <BodyText tone="secondary">
              {t('rejectedFramesExplanation', { count: stackingOutcome.rejectedFrameCount })}
            </BodyText>
          ) : null}
          <BodyText tone="secondary">
            {t('burstTimings', {
              count: stackingOutcome.burstTimings.capturedPhotoCount,
              captureSeconds: (stackingOutcome.burstTimings.captureMilliseconds / 1000).toFixed(1),
              decodeSeconds: (stackingOutcome.burstTimings.decodeMilliseconds / 1000).toFixed(1),
            })}
          </BodyText>
          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
        </Card>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <Card>
        <SectionTitle>{t('tipsTitle')}</SectionTitle>
        <BodyText tone="secondary">{t(captureMode === 'nakedEye' ? 'tips' : 'telescopeTips')}</BodyText>
      </Card>
    </ScreenContainer>
  );
}

/**
 * Guía del modo telescopio: un círculo donde encajar el del ocular y un punto donde se ve la Luna.
 * La detección viene en píxeles del fotograma; la vista previa lo muestra con `contain`.
 */
function TelescopeGuideOverlay({
  previewSize,
  liveDetection,
  isMoonOffCenter,
}: {
  previewSize: PixelSize;
  liveDetection: LiveMoonDetection | null;
  isMoonOffCenter: boolean;
}) {
  const guideDiameter = Math.min(previewSize.width, previewSize.height) * eyepieceGuideFraction;
  let moonMarker = null;
  if (liveDetection) {
    const displayedFrame = containedFrameRect({
      viewWidth: previewSize.width,
      viewHeight: previewSize.height,
      frameWidth: liveDetection.frameWidth,
      frameHeight: liveDetection.frameHeight,
    });
    const markerRadius = Math.max(10, liveDetection.radiusPixels * displayedFrame.displayScale);
    moonMarker = (
      <View
        style={[
          styles.moonMarker,
          {
            left: displayedFrame.left + liveDetection.centerX * displayedFrame.displayScale - markerRadius,
            top: displayedFrame.top + liveDetection.centerY * displayedFrame.displayScale - markerRadius,
            width: markerRadius * 2,
            height: markerRadius * 2,
            borderRadius: markerRadius,
            borderColor: isMoonOffCenter ? '#FCA5A5' : '#4ADE80',
          },
        ]}
      />
    );
  }
  return (
    <View pointerEvents="none" style={styles.guideOverlay}>
      <View
        style={[
          styles.eyepieceGuide,
          { width: guideDiameter, height: guideDiameter, borderRadius: guideDiameter / 2 },
        ]}
      />
      {moonMarker}
    </View>
  );
}

function PointingOverlay({
  pointingGuidance,
  isBelowHorizon,
}: {
  pointingGuidance: PointingGuidance;
  isBelowHorizon: boolean;
}) {
  const { t } = useTranslation(moonInstrumentId);
  const { angularDistanceDegrees, screenArrowAngleDegrees, turnRightDegrees, raiseDegrees } = pointingGuidance;
  const isCentered = angularDistanceDegrees < centeredGuideDegrees;
  const corrections: string[] = [];
  if (Math.abs(turnRightDegrees) >= negligibleCorrectionDegrees) {
    corrections.push(t(turnRightDegrees > 0 ? 'guideTurnRight' : 'guideTurnLeft', { degrees: Math.abs(turnRightDegrees).toFixed(0) }));
  }
  if (Math.abs(raiseDegrees) >= negligibleCorrectionDegrees) {
    corrections.push(t(raiseDegrees > 0 ? 'guideRaise' : 'guideLower', { degrees: Math.abs(raiseDegrees).toFixed(0) }));
  }
  const guideMessage = isBelowHorizon
    ? t('guideBelowHorizon')
    : isCentered
      ? t('guideCentered')
      : corrections.join(' · ');
  return (
    <View pointerEvents="none" style={styles.guideOverlay}>
      {isCentered ? (
        <View style={styles.guideCenterRing} />
      ) : (
        // La flecha «➜» apunta a la derecha; RN gira en sentido horario y el ángulo es antihorario.
        <BodyText style={{ ...styles.guideArrow, transform: [{ rotate: `${-screenArrowAngleDegrees}deg` }] }}>➜</BodyText>
      )}
      {guideMessage ? (
        <View style={styles.guideLabel}>
          <BodyText style={styles.guideLabelText}>{guideMessage}</BodyText>
        </View>
      ) : null}
    </View>
  );
}

interface StepperRowProps {
  label: string;
  onDecrease(): void;
  onIncrease(): void;
  isDecreaseDisabled: boolean;
  isIncreaseDisabled: boolean;
  decreaseLabel: string;
  increaseLabel: string;
}

function StepperRow({
  label,
  onDecrease,
  onIncrease,
  isDecreaseDisabled,
  isIncreaseDisabled,
  decreaseLabel,
  increaseLabel,
}: StepperRowProps) {
  return (
    <View style={styles.stepperRow}>
      <View style={styles.stepperButton}>
        <AppButton label={decreaseLabel} onPress={onDecrease} isDisabled={isDecreaseDisabled} variant="secondary" />
      </View>
      <BodyText style={styles.stepperLabel}>{label}</BodyText>
      <View style={styles.stepperButton}>
        <AppButton label={increaseLabel} onPress={onIncrease} isDisabled={isIncreaseDisabled} variant="secondary" />
      </View>
    </View>
  );
}

function ResultImage({ label, skiaImage }: { label: string; skiaImage: SkImage }) {
  const [imageSide, setImageSide] = useState(0);
  return (
    <View style={styles.resultColumn}>
      <View
        style={styles.resultImageFrame}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        onLayout={(layoutEvent: LayoutChangeEvent) => setImageSide(layoutEvent.nativeEvent.layout.width)}>
        {imageSide > 0 ? (
          <Canvas style={{ width: imageSide, height: imageSide }}>
            <SkiaImageView image={skiaImage} x={0} y={0} width={imageSide} height={imageSide} fit="contain" />
          </Canvas>
        ) : null}
      </View>
      <BodyText tone="secondary">{label}</BodyText>
    </View>
  );
}

const meteringMarkerRadius = 28;

const styles = StyleSheet.create({
  previewContainer: {
    height: previewHeight,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  meteringMarker: {
    position: 'absolute',
    width: meteringMarkerRadius * 2,
    height: meteringMarkerRadius * 2,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#FACC15',
  },
  guideOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  guideArrow: { fontSize: 72, lineHeight: 84, color: '#FACC15' },
  guideCenterRing: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, borderColor: '#4ADE80' },
  guideLabel: {
    position: 'absolute',
    bottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  guideLabelText: { color: '#FFFFFF', fontWeight: '600' },
  eyepieceGuide: { borderWidth: 2, borderColor: 'rgba(250, 204, 21, 0.8)', borderStyle: 'dashed' },
  moonMarker: { position: 'absolute', borderWidth: 2 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 110 },
  stepperLabel: { flex: 1, textAlign: 'center', fontWeight: '600', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  buttonCell: { flex: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  resultRow: { flexDirection: 'row', gap: 8 },
  resultColumn: { flex: 1, alignItems: 'center', gap: 4 },
  resultImageFrame: { width: '100%', aspectRatio: 1, backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
});
