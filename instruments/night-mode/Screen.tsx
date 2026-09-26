import { AlphaType, Canvas, ColorType, Image as SkiaImageView, type SkImage, Skia } from '@shopify/react-native-skia';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { centeredSquareCrop, type PixelRect, type PixelSize, photoRectToViewRect } from '@/core/camera/photoCropGeometry';
import { useDeviceSteadiness } from '@/core/camera/useDeviceSteadiness';
import { type PhotoBurstTimings, usePhotoBurst } from '@/core/camera/usePhotoBurst';
import { useResultImageViewer } from '@/core/camera/useResultImageViewer';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { floatImageToRgba } from '@/processing/image/burstSuperResolution';
import type { FloatRgbImage } from '@/processing/image/lunarStacking';
import {
  denoiseNightImage,
  handheldFrameCount,
  measureNightToneStatistics,
  type NightExposurePlan,
  type NightHoldingMode,
  type NightStackResult,
  planNightModeExposure,
  stackNightBurst,
  toneMapNightImage,
  tripodFrameCount,
} from '@/processing/image/nightModeStacking';
import { AppButton, BodyText, Card, LoadingState, SectionTitle } from '@/ui/components';
import { CameraOverlayButton, CameraOverlayText, CameraScreenLayout } from '@/ui/FullScreenCamera';
import { useThemePalette } from '@/ui/theme';

import type { NightModeMeasurementValues } from './schema';

export const nightModeInstrumentId = 'night-mode';

/** El visor se carga al abrirlo (arrastra módulos nativos que no existen en los tests). */
const ImageViewer = lazy(() => import('@/ui/ImageViewer').then((viewerModule) => ({ default: viewerModule.ImageViewer })));

/**
 * Qué parte de la foto se apila. «Toda»: el cuadrado central de lado la anchura de la foto,
 * reducido en nativo (reducir ya promedia algo de ruido); «centro»: un recorte a resolución
 * completa, con más detalle y menos escena.
 */
type FramingOptionId = 'wholeSmall' | 'wholeLarge' | 'center';
const framingOptionIds: readonly FramingOptionId[] = ['wholeSmall', 'wholeLarge', 'center'];
const wholeOutputSides: Record<Exclude<FramingOptionId, 'center'>, number> = { wholeSmall: 768, wholeLarge: 1024 };
const centerCropSize = 768;
type HoldingChoice = 'auto' | NightHoldingMode;
const holdingChoices: readonly HoldingChoice[] = ['auto', 'tripod', 'handheld'];
/** «Ambiente»: de parecer de noche (0) a parecer de día (1). */
const ambienceLevels: readonly { id: string; value: number }[] = [
  { id: 'night', value: 0 },
  { id: 'dusk', value: 0.25 },
  { id: 'evening', value: 0.5 },
  { id: 'cloudy', value: 0.75 },
  { id: 'day', value: 1 },
];
const defaultAmbienceId = 'evening';
type NoiseReductionLevel = 'off' | 'soft' | 'medium';
const noiseReductionLevels: readonly NoiseReductionLevel[] = ['off', 'soft', 'medium'];
const noiseReductionStrengths: Record<NoiseReductionLevel, number> = { off: 0, soft: 0.4, medium: 0.8 };
type DisplayedVersion = 'night' | 'singleSameLook' | 'singleRaw';
const displayedVersions: readonly DisplayedVersion[] = ['night', 'singleSameLook', 'singleRaw'];
const captureCountdownSeconds = 2;
/** Tras fijar la exposición, unos fotogramas hasta que la cámara la aplica. */
const exposureSettleMilliseconds = 400;
const meteringMarkerRadius = 28;

interface NightModeOutcome {
  stack: NightStackResult;
  holdingMode: NightHoldingMode;
  exposurePlan: NightExposurePlan | null;
  hasLockedWhiteBalance: boolean;
  burstTimings: PhotoBurstTimings;
}

interface DevelopedImages {
  nightImage: FloatRgbImage;
  singleSameLookImage: FloatRgbImage;
  developMilliseconds: number;
}

function secondsText(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(1);
}

function exposureTimeText(exposureSeconds: number): string {
  return exposureSeconds >= 0.1 ? `${Math.round(exposureSeconds * 1000)} ms` : `1/${Math.round(1 / exposureSeconds)} s`;
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

function createSkiaImage(image: FloatRgbImage): SkImage | null {
  return Skia.Image.MakeImage(
    { width: image.size, height: image.size, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(floatImageToRgba(image)),
    image.size * 4,
  );
}

function cropRectFor(framingOptionId: FramingOptionId, photoSize: PixelSize): PixelRect {
  if (framingOptionId === 'center') return centeredSquareCrop(photoSize, centerCropSize);
  return centeredSquareCrop(photoSize, Math.min(photoSize.width, photoSize.height));
}

/**
 * Revelado del apilado y de la foto suelta con los mismos ajustes (reducción de ruido y
 * «Ambiente», con las estadísticas del apilado), para compararlos en igualdad.
 */
function developImages(stack: NightStackResult, noiseReductionLevel: NoiseReductionLevel, ambience: number): DevelopedImages {
  const developStartTime = Date.now();
  const strength = noiseReductionStrengths[noiseReductionLevel];
  const denoisedStack = denoiseNightImage(stack.stackedImage, strength);
  const toneStatistics = measureNightToneStatistics(denoisedStack);
  const nightImage = toneMapNightImage(denoisedStack, toneStatistics, ambience);
  const singleSameLookImage = toneMapNightImage(denoiseNightImage(stack.referenceImage, strength), toneStatistics, ambience);
  return { nightImage, singleSameLookImage, developMilliseconds: Date.now() - developStartTime };
}

function imageForVersion(outcome: NightModeOutcome, developed: DevelopedImages, version: DisplayedVersion): FloatRgbImage {
  if (version === 'night') return developed.nightImage;
  if (version === 'singleSameLook') return developed.singleSameLookImage;
  return outcome.stack.referenceImage;
}

function ChoiceChips<TOption extends string>({
  options,
  selectedOption,
  labelFor,
  onSelect,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  labelFor(option: TOption): string;
  onSelect(option: TOption): void;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
            <BodyText tone={isSelected ? 'accent' : 'secondary'}>{labelFor(option)}</BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

function ResultImage({ label, skiaImage }: { label: string; skiaImage: SkImage }) {
  const [imageSide, setImageSide] = useState(0);
  return (
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
  );
}

export function NightModeScreen({ saveMeasurement, sensorAvailability }: InstrumentScreenProps<NightModeMeasurementValues>) {
  const { t } = useTranslation(nightModeInstrumentId);
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const hasGyroscope = sensorAvailability.gyroscope.status === 'available';
  const { isDeviceSteady, isSteadyForDisplay } = useDeviceSteadiness(isCameraAllowed, hasGyroscope);
  const photoBurst = usePhotoBurst();
  const { isCapturing, captureProgress, stopCapture, uprightPhotoSize } = photoBurst;
  const resultImageViewer = useResultImageViewer();

  const [framingOptionId, setFramingOptionId] = useState<FramingOptionId>('wholeSmall');
  const [holdingChoice, setHoldingChoice] = useState<HoldingChoice>('auto');
  const [ambienceId, setAmbienceId] = useState(defaultAmbienceId);
  const [noiseReductionLevel, setNoiseReductionLevel] = useState<NoiseReductionLevel>('soft');
  const [isMeteringLocked, setIsMeteringLocked] = useState(false);
  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [isPreparingExposure, setIsPreparingExposure] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [outcome, setOutcome] = useState<NightModeOutcome | null>(null);
  const [displayedVersion, setDisplayedVersion] = useState<DisplayedVersion>('night');
  const [resultSequenceNumber, setResultSequenceNumber] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const ambience = ambienceLevels.find((ambienceLevel) => ambienceLevel.id === ambienceId)?.value ?? 0.5;
  // El revelado se rehace al cambiar la reducción de ruido o el «Ambiente» (menos de un segundo).
  const developedImages = useMemo(
    () => (outcome ? developImages(outcome.stack, noiseReductionLevel, ambience) : null),
    [outcome, noiseReductionLevel, ambience],
  );
  const displayedSkiaImage = useMemo(
    () => (outcome && developedImages ? createSkiaImage(imageForVersion(outcome, developedImages, displayedVersion)) : null),
    [outcome, developedImages, displayedVersion],
  );

  const isBusy = isCapturing || isProcessing || isPreparingExposure || countdownSecondsLeft !== null;
  const cropRect = cropRectFor(framingOptionId, uprightPhotoSize);
  const isFrameLargeEnough = framingOptionId !== 'center' || Math.min(uprightPhotoSize.width, uprightPhotoSize.height) >= centerCropSize;
  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);
  const supportsExposureLocking = Boolean(cameraDevice?.supportsExposureLocking);
  const predictedHoldingMode: NightHoldingMode = holdingChoice === 'auto' ? (isSteadyForDisplay ? 'tripod' : 'handheld') : holdingChoice;

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    if (!canMeter || !cameraDevice || isBusy) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    setIsMeteringLocked(true);
    setMeteringViewPoint(viewPoint);
    try {
      // De noche el enfoque automático duda: mejor fijarlo tocando algo con luz.
      await cameraRef.current?.focusTo(viewPoint, { modes: meteringModes, responsiveness: 'snappy', adaptiveness: 'locked', autoResetAfter: null });
    } catch {
      // Cancelado por otro toque o no admitido.
    }
  }

  async function handleUnlockMetering() {
    setIsMeteringLocked(false);
    setMeteringViewPoint(null);
    try {
      await cameraRef.current?.resetFocus();
    } catch {
      // La cámara puede no estar lista.
    }
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function handleCapture() {
    const captureFramingOptionId = framingOptionId;
    const planCrop = (photoSize: PixelSize) => cropRectFor(captureFramingOptionId, photoSize);
    const maximumOutputSide = captureFramingOptionId === 'center' ? undefined : wholeOutputSides[captureFramingOptionId];
    setOutcome(null);
    setStatusMessage(null);
    for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
      setCountdownSecondsLeft(secondsLeft);
      await waitMilliseconds(1000);
      if (!isMountedRef.current) return;
    }
    setCountdownSecondsLeft(null);
    // Se decide justo antes de disparar, pasada la cuenta atrás (el toque ya no mueve el móvil).
    const holdingMode: NightHoldingMode = holdingChoice === 'auto' ? (isDeviceSteady() ? 'tripod' : 'handheld') : holdingChoice;
    const cameraController = cameraRef.current?.controller;
    let exposurePlan: NightExposurePlan | null = null;
    let hasLockedWhiteBalance = false;
    setIsPreparingExposure(true);
    try {
      if (cameraController && supportsExposureLocking && cameraController.maxExposureDuration > 0) {
        exposurePlan = planNightModeExposure(
          { exposureSeconds: cameraController.exposureDuration, iso: cameraController.iso },
          {
            minimumExposureSeconds: cameraController.minExposureDuration,
            maximumExposureSeconds: cameraController.maxExposureDuration,
            minimumIso: cameraController.minISO,
            maximumIso: cameraController.maxISO,
          },
          holdingMode,
        );
        if (exposurePlan) {
          await cameraController.setExposureLocked(exposurePlan.exposureSeconds, exposurePlan.iso);
          await waitMilliseconds(exposureSettleMilliseconds);
        }
      }
    } catch {
      // No admitido: se dispara con la exposición automática.
      exposurePlan = null;
    }
    if (cameraDevice?.supportsWhiteBalanceLocking) {
      try {
        await cameraController?.lockCurrentWhiteBalance();
        hasLockedWhiteBalance = true;
      } catch {
        // No admitido: las ganancias por canal se igualan al apilar.
      }
    }
    setIsPreparingExposure(false);
    if (!isMountedRef.current) return;
    const photoCount = exposurePlan?.frameCount ?? (holdingMode === 'tripod' ? tripodFrameCount : handheldFrameCount);
    let burstResult;
    try {
      burstResult = await photoBurst.captureBurst({ photoCount, planCrop, maximumOutputSide });
    } catch (burstError) {
      setStatusMessage(t('core:common.error', { message: String(burstError) }));
      return;
    } finally {
      // Vuelta a la exposición y el balance automáticos (lo que también suelta el enfoque fijado).
      if (exposurePlan || hasLockedWhiteBalance) {
        cameraRef.current?.resetFocus().catch(() => undefined);
        setIsMeteringLocked(false);
        setMeteringViewPoint(null);
      }
    }
    if (!isMountedRef.current) return;
    const firstCropWidth = burstResult.crops[0]?.width ?? 0;
    const squareCrops = burstResult.crops.filter((photoCrop) => photoCrop.width === firstCropWidth && photoCrop.height === firstCropWidth);
    if (squareCrops.length === 0) {
      setStatusMessage(burstResult.firstErrorMessage ? t('burstFailed', { message: burstResult.firstErrorMessage }) : t('noFramesCaptured'));
      return;
    }
    setIsProcessing(true);
    await waitMilliseconds(50);
    if (!isMountedRef.current) return;
    try {
      const stack = stackNightBurst(
        squareCrops.map((photoCrop) => photoCrop.rgbPixels),
        firstCropWidth,
      );
      setDisplayedVersion('night');
      setOutcome({ stack, holdingMode, exposurePlan, hasLockedWhiteBalance, burstTimings: burstResult.timings });
      setResultSequenceNumber((previousNumber) => previousNumber + 1);
    } catch (processingError) {
      setStatusMessage(t('core:common.error', { message: String(processingError) }));
    } finally {
      setIsProcessing(false);
    }
  }

  function handleOpenFullSize() {
    if (!outcome || !developedImages) return;
    const orderedVersions = [displayedVersion, ...displayedVersions.filter((version) => version !== displayedVersion)];
    const resultImages = orderedVersions.flatMap((version) => {
      const skiaImage = createSkiaImage(imageForVersion(outcome, developedImages, version));
      return skiaImage ? [{ skiaImage, caption: t(`versions.${version}`), fileNamePrefix: `noche-${version}` }] : [];
    });
    if (resultImages.length > 0) resultImageViewer.openViewer(resultImages);
  }

  async function handleSave() {
    if (!outcome || !developedImages) return;
    const nightSkiaImage = createSkiaImage(developedImages.nightImage);
    const singleSkiaImage = createSkiaImage(developedImages.singleSameLookImage);
    if (!nightSkiaImage || !singleSkiaImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const nightFile = writeImageToCachePng(nightSkiaImage, 'noche');
      const singleFile = writeImageToCachePng(singleSkiaImage, 'noche-una-foto');
      const { stack, exposurePlan, burstTimings } = outcome;
      await saveMeasurement({
        values: {
          capturedFrameCount: stack.usedFrameCount,
          holdingMode: outcome.holdingMode,
          ...(exposurePlan
            ? { exposureSeconds: Math.round(exposurePlan.exposureSeconds * 10000) / 10000, iso: exposurePlan.iso }
            : {}),
          outputSizePixels: stack.stackedImage.size,
          noiseReductionFactor: Math.round(stack.noiseReductionFactor * 10) / 10,
          rejectedPercent: Math.round(stack.rejectedFraction * 1000) / 10,
          locallyAlignedFrameCount: stack.locallyAlignedFrameCount,
          ambience,
          noiseReductionLevel,
          captureSeconds: Math.round((burstTimings.captureMilliseconds + burstTimings.decodeMilliseconds) / 100) / 10,
          processingSeconds: Math.round((stack.timings.totalMilliseconds + developedImages.developMilliseconds) / 100) / 10,
        },
        attachments: [
          {
            kind: 'photo',
            sourceUri: nightFile.uri,
            fileName: 'modo-noche.png',
            mimeType: 'image/png',
            metadata: { widthPixels: nightSkiaImage.width(), heightPixels: nightSkiaImage.height(), frameCount: stack.usedFrameCount },
          },
          {
            kind: 'photo',
            sourceUri: singleFile.uri,
            fileName: 'modo-noche-una-foto.png',
            mimeType: 'image/png',
            metadata: { widthPixels: singleSkiaImage.width(), heightPixels: singleSkiaImage.height(), frameCount: 1 },
          },
        ],
      });
      nightFile.delete();
      singleFile.delete();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const captureLabel = t('capture');
  const isCaptureDisabled = !isCameraAllowed || !isFrameLargeEnough;
  const progressText = captureProgress
    ? t(captureProgress.phase === 'capturing' ? 'capturingProgress' : 'decodingProgress', {
        captured: captureProgress.completedCount,
        target: captureProgress.totalCount,
      })
    : '';
  const holdingText = (
    <BodyText tone="secondary">
      {t(`holdingPrediction.${predictedHoldingMode}`)}
      {holdingChoice === 'auto' && !hasGyroscope ? ` ${t('noGyroscope')}` : ''}
    </BodyText>
  );
  const exposureLockText = !supportsExposureLocking ? <BodyText tone="danger">{t('exposureLockingUnsupported')}</BodyText> : null;
  const frameTooSmallText = !isFrameLargeEnough ? <BodyText tone="danger">{t('frameTooSmall')}</BodyText> : null;
  const focusLockRow = isMeteringLocked ? (
    <View style={styles.buttonRow}>
      <BodyText style={styles.flexText}>{t('focusLocked')}</BodyText>
      <View style={styles.smallButton}>
        <AppButton label={t('unlockFocus')} onPress={() => void handleUnlockMetering()} variant="secondary" />
      </View>
    </View>
  ) : null;
  const settingsSection = !isBusy ? (
    <>
      <BodyText tone="secondary">{t('framingTitle')}</BodyText>
      <ChoiceChips<FramingOptionId> options={framingOptionIds} selectedOption={framingOptionId} labelFor={(option) => t(`framingOptions.${option}`)} onSelect={setFramingOptionId} />
      <BodyText tone="secondary">{t('holdingTitle')}</BodyText>
      <ChoiceChips<HoldingChoice> options={holdingChoices} selectedOption={holdingChoice} labelFor={(choice) => t(`holdingChoices.${choice}`)} onSelect={setHoldingChoice} />
    </>
  ) : null;
  const processingIndicator = isProcessing ? <LoadingState label={t('processing')} /> : null;

  let resultSection: ReactNode = null;
  if (outcome && developedImages && displayedSkiaImage) {
    const { stack, exposurePlan, burstTimings } = outcome;
    resultSection = (
      <>
        <SectionTitle>{t('resultTitle')}</SectionTitle>
        <ChoiceChips<DisplayedVersion> options={displayedVersions} selectedOption={displayedVersion} labelFor={(version) => t(`versions.${version}`)} onSelect={setDisplayedVersion} />
        <Pressable accessibilityRole="button" accessibilityLabel={t('openFullSize')} onPress={handleOpenFullSize}>
          <ResultImage label={t(`versions.${displayedVersion}`)} skiaImage={displayedSkiaImage} />
        </Pressable>
        <BodyText tone="secondary" style={styles.smallText}>
          {t(`versionHints.${displayedVersion}`)}
        </BodyText>
        <AppButton label={t('openFullSize')} onPress={handleOpenFullSize} variant="secondary" />
        <BodyText tone="secondary">{t('ambienceTitle')}</BodyText>
        <ChoiceChips<string>
          options={ambienceLevels.map((ambienceLevel) => ambienceLevel.id)}
          selectedOption={ambienceId}
          labelFor={(levelId) => t(`ambienceLevels.${levelId}`)}
          onSelect={setAmbienceId}
        />
        <BodyText tone="secondary">{t('noiseReductionTitle')}</BodyText>
        <ChoiceChips<NoiseReductionLevel>
          options={noiseReductionLevels}
          selectedOption={noiseReductionLevel}
          labelFor={(level) => t(`noiseReductionLevels.${level}`)}
          onSelect={setNoiseReductionLevel}
        />
        <BodyText tone="secondary">
          {exposurePlan
            ? t('exposureSummary', {
                mode: t(`holdingChoices.${outcome.holdingMode}`),
                count: stack.usedFrameCount,
                exposure: exposureTimeText(exposurePlan.exposureSeconds),
                iso: exposurePlan.iso,
              })
            : t('exposureAutomaticSummary', { mode: t(`holdingChoices.${outcome.holdingMode}`), count: stack.usedFrameCount })}
        </BodyText>
        {exposurePlan && exposurePlan.brightnessRelativeToAutomatic < 0.5 ? (
          <BodyText tone="secondary">{t('isoCeilingReached')}</BodyText>
        ) : null}
        <BodyText tone="secondary">
          {t('stackSummary', {
            noise: stack.noiseReductionFactor.toFixed(1),
            ideal: Math.sqrt(stack.usedFrameCount).toFixed(1),
            rejected: (stack.rejectedFraction * 100).toFixed(1),
            local: stack.locallyAlignedFrameCount,
            others: stack.usedFrameCount - 1,
            shift: stack.meanShiftPixels.toFixed(1),
          })}
        </BodyText>
        <BodyText tone="secondary">{t(outcome.hasLockedWhiteBalance ? 'whiteBalanceLocked' : 'whiteBalanceNotLocked')}</BodyText>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('timings', {
            captureSeconds: secondsText(burstTimings.captureMilliseconds),
            decodeSeconds: secondsText(burstTimings.decodeMilliseconds),
            alignSeconds: secondsText(stack.timings.globalAlignmentMilliseconds),
            localSeconds: secondsText(stack.timings.localAlignmentMilliseconds),
            mergeSeconds: secondsText(stack.timings.mergeMilliseconds),
            developSeconds: secondsText(developedImages.developMilliseconds),
          })}
        </BodyText>
        <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
      </>
    );
  }
  const statusText = statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null;
  const howItWorksText = (
    <BodyText tone="secondary" style={styles.smallText}>
      {t('howItWorks')}
    </BodyText>
  );

  let fullScreenReadout: ReactNode;
  if (countdownSecondsLeft !== null) {
    fullScreenReadout = (
      <>
        <CameraOverlayText>{t('holdStill')}</CameraOverlayText>
        <CameraOverlayText style={styles.readoutCountdown}>{countdownSecondsLeft}</CameraOverlayText>
      </>
    );
  } else if (isCapturing && captureProgress) {
    fullScreenReadout = <CameraOverlayText style={styles.readoutValue}>{progressText}</CameraOverlayText>;
  } else if (isProcessing) {
    fullScreenReadout = <CameraOverlayText>{t('processing')}</CameraOverlayText>;
  } else {
    fullScreenReadout = <CameraOverlayText style={styles.readoutValue}>{t(`holdingPrediction.${predictedHoldingMode}`)}</CameraOverlayText>;
  }

  return (
    <CameraScreenLayout
      title={t('name')}
      aboveNormalPreview={<BodyText tone="secondary">{t('intro')}</BodyText>}
      renderPreview={({ previewWidth, previewHeight }) => (
        <>
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={cameraDevice ?? 'back'}
            isActive={isCameraAllowed}
            outputs={[photoBurst.photoOutput]}
            orientationSource="interface"
            onError={handleCameraError}
            onStarted={photoBurst.handleCameraStarted}
            resizeMode="contain"
          />
          {previewWidth > 0 && previewHeight > 0 ? (
            <View
              pointerEvents="none"
              style={[styles.cropFrame, photoRectToViewRect(cropRect, uprightPhotoSize, { width: previewWidth, height: previewHeight })]}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tapToFocusHint')}
            accessibilityState={{ disabled: isBusy }}
            disabled={isBusy}
            style={StyleSheet.absoluteFill}
            onPress={(pressEvent) => void handlePreviewPress(pressEvent)}>
            {meteringViewPoint ? (
              <View
                pointerEvents="none"
                style={[styles.meteringMarker, { left: meteringViewPoint.x - meteringMarkerRadius, top: meteringViewPoint.y - meteringMarkerRadius }]}
              />
            ) : null}
          </Pressable>
          {resultImageViewer.openedIndex !== null ? (
            <Suspense fallback={null}>
              <ImageViewer images={resultImageViewer.viewerImages} openedIndex={resultImageViewer.openedIndex} onClose={resultImageViewer.closeViewer} />
            </Suspense>
          ) : null}
        </>
      )}
      topActions={
        isMeteringLocked && !isBusy ? (
          <CameraOverlayButton label={t('unlockFocus')} accessibilityLabel={`${t('focusLocked')} ${t('unlockFocus')}`} onPress={() => void handleUnlockMetering()} />
        ) : null
      }
      readout={fullScreenReadout}
      primaryActions={
        <View style={styles.captureActionCell}>
          {isCapturing ? (
            <AppButton label={t('stopCapture')} onPress={stopCapture} variant="danger" />
          ) : (
            <AppButton label={captureLabel} onPress={() => void handleCapture()} isDisabled={isCaptureDisabled} isBusy={isBusy} />
          )}
        </View>
      }
      panelContent={
        <>
          <BodyText tone="secondary">{t('tapToFocusHint')}</BodyText>
          {focusLockRow}
          {holdingText}
          {exposureLockText}
          {frameTooSmallText}
          {settingsSection}
          {processingIndicator}
          {resultSection}
          {statusText}
          {howItWorksText}
        </>
      }
      panelOpenRequestKey={resultSequenceNumber > 0 ? resultSequenceNumber : null}>
      <BodyText tone="secondary">{t('tapToFocusHint')}</BodyText>
      {focusLockRow}
      {holdingText}
      {exposureLockText}
      {frameTooSmallText}
      {settingsSection}
      {countdownSecondsLeft !== null ? (
        <Card style={styles.centeredCard}>
          <BodyText tone="secondary">{t('holdStill')}</BodyText>
          <BodyText style={styles.countdownValue}>{countdownSecondsLeft}</BodyText>
        </Card>
      ) : null}
      {isCapturing && captureProgress ? (
        <View style={styles.buttonRow}>
          <BodyText style={styles.flexText}>{progressText}</BodyText>
          <View style={styles.smallButton}>
            <AppButton label={t('stopCapture')} onPress={stopCapture} variant="secondary" />
          </View>
        </View>
      ) : null}
      {processingIndicator}
      {!isBusy ? <AppButton label={captureLabel} onPress={() => void handleCapture()} isDisabled={isCaptureDisabled} /> : null}
      {resultSection}
      {statusText}
      {howItWorksText}
    </CameraScreenLayout>
  );
}

const styles = StyleSheet.create({
  cropFrame: { position: 'absolute', borderWidth: 2, borderColor: '#A5B4FC', borderRadius: 4 },
  meteringMarker: {
    position: 'absolute',
    width: meteringMarkerRadius * 2,
    height: meteringMarkerRadius * 2,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#4ADE80',
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  resultImageFrame: { width: '100%', aspectRatio: 1, backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
  smallText: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexText: { flex: 1 },
  smallButton: { width: 110 },
  centeredCard: { alignItems: 'center', paddingVertical: 16, gap: 4 },
  countdownValue: { fontSize: 48, lineHeight: 56, fontWeight: '700', fontVariant: ['tabular-nums'] },
  captureActionCell: { flex: 1 },
  readoutCountdown: { fontSize: 40, lineHeight: 46, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutValue: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
