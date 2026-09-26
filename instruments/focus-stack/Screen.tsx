import { AlphaType, Canvas, ColorType, Image as SkiaImageView, type SkImage, Skia } from '@shopify/react-native-skia';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { centeredSquareCrop, type PixelRect, type PixelSize, photoRectToViewRect } from '@/core/camera/photoCropGeometry';
import { usePhotoBurst } from '@/core/camera/usePhotoBurst';
import { useResultImageViewer } from '@/core/camera/useResultImageViewer';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { floatImageToRgba } from '@/processing/image/burstSuperResolution';
import { depthColorForFrame, type FocusStackResult, renderSourceIndexMap, stackFocusBracket } from '@/processing/image/focusStacking';
import { approximateFocusDistanceCentimeters } from '@/processing/image/focusSweepPlanning';
import type { FloatRgbImage } from '@/processing/image/lunarStacking';
import { AppButton, BodyText, Card, LoadingState, SectionTitle } from '@/ui/components';
import { CameraOverlayButton, CameraOverlayText, CameraScreenLayout } from '@/ui/FullScreenCamera';
import { useThemePalette } from '@/ui/theme';

import type { FocusStackMeasurementValues } from './schema';
import { type FocusRangeMode, type FocusSweepOutcome, useFocusSweep } from './useFocusSweep';

export const focusStackInstrumentId = 'focus-stack';

/** El visor se carga al abrirlo (arrastra módulos nativos que no existen en los tests). */
const ImageViewer = lazy(() => import('@/ui/ImageViewer').then((viewerModule) => ({ default: viewerModule.ImageViewer })));

/**
 * Zona de cada foto que se apila. Las tres primeras, recortes centrales a resolución completa;
 * «toda», el cuadrado central de lado la anchura de la foto, reducido a 1024 px. El cálculo
 * crece con el área: la grande tarda unas cuatro veces lo que la pequeña.
 */
type CropOptionId = 'small' | 'medium' | 'large' | 'whole';
const cropOptionIds: readonly CropOptionId[] = ['small', 'medium', 'large', 'whole'];
const fixedCropSizes: Record<Exclude<CropOptionId, 'whole'>, number> = { small: 512, medium: 768, large: 1024 };
const wholePhotoOutputSide = 1024;
const rangeModes: readonly FocusRangeMode[] = ['auto', 'macro', 'near'];
/** Cuenta atrás antes de empezar, para que el toque no mueva el móvil. */
const captureCountdownSeconds = 2;
const meteringMarkerRadius = 28;

type DisplayedVersion = 'stacked' | 'bestSingle' | 'depthMap';
const displayedVersions: readonly DisplayedVersion[] = ['stacked', 'bestSingle', 'depthMap'];

interface FocusStackOutcome {
  stack: FocusStackResult;
  sweep: FocusSweepOutcome;
  rangeMode: FocusRangeMode;
  depthMapImage: FloatRgbImage;
  processingMilliseconds: number;
}

function secondsText(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(1);
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

function distanceText(lensPosition: number): string {
  const distanceCentimeters = approximateFocusDistanceCentimeters(lensPosition);
  return Number.isFinite(distanceCentimeters) ? distanceCentimeters.toFixed(0) : '∞';
}

function createSkiaImage(image: FloatRgbImage): SkImage | null {
  return Skia.Image.MakeImage(
    { width: image.size, height: image.size, alphaType: AlphaType.Opaque, colorType: ColorType.RGBA_8888 },
    Skia.Data.fromBytes(floatImageToRgba(image)),
    image.size * 4,
  );
}

function imageForVersion(outcome: FocusStackOutcome | null, version: DisplayedVersion): FloatRgbImage | null {
  if (!outcome) return null;
  if (version === 'stacked') return outcome.stack.stackedImage;
  if (version === 'bestSingle') return outcome.stack.bestSingleImage;
  return outcome.depthMapImage;
}

/** Recorte de la foto derecha según la opción elegida. */
function cropRectFor(cropOptionId: CropOptionId, photoSize: PixelSize): PixelRect {
  if (cropOptionId === 'whole') return centeredSquareCrop(photoSize, Math.min(photoSize.width, photoSize.height));
  return centeredSquareCrop(photoSize, fixedCropSizes[cropOptionId]);
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

/** Leyenda del mapa de profundidad: un color por foto, de cerca a lejos. */
function DepthLegend({ frameCount, lensPositions }: { frameCount: number; lensPositions: readonly number[] }) {
  const { t } = useTranslation(focusStackInstrumentId);
  const firstPosition = lensPositions[0] ?? 0;
  const lastPosition = lensPositions[lensPositions.length - 1] ?? 1;
  return (
    <View style={styles.legendRow}>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('depthLegendNear', { distance: distanceText(firstPosition) })}
      </BodyText>
      <View style={styles.legendSwatches}>
        {Array.from({ length: frameCount }, (_unused, frameIndex) => {
          const [red, green, blue] = depthColorForFrame(frameIndex, frameCount);
          return <View key={frameIndex} style={[styles.legendSwatch, { backgroundColor: `rgb(${red}, ${green}, ${blue})` }]} />;
        })}
      </View>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('depthLegendFar', { distance: distanceText(lastPosition) })}
      </BodyText>
    </View>
  );
}

export function FocusStackScreen({ saveMeasurement }: InstrumentScreenProps<FocusStackMeasurementValues>) {
  const { t } = useTranslation(focusStackInstrumentId);
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const photoBurst = usePhotoBurst();
  const { uprightPhotoSize } = photoBurst;
  const focusSweep = useFocusSweep(cameraRef, cameraDevice, photoBurst.captureBurst);
  const resultImageViewer = useResultImageViewer();

  const [cropOptionId, setCropOptionId] = useState<CropOptionId>('medium');
  const [rangeMode, setRangeMode] = useState<FocusRangeMode>('auto');
  const [meteringCameraPoint, setMeteringCameraPoint] = useState<{ x: number; y: number } | null>(null);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [outcome, setOutcome] = useState<FocusStackOutcome | null>(null);
  const [displayedVersion, setDisplayedVersion] = useState<DisplayedVersion>('stacked');
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

  const isBusy = focusSweep.isRunning || isProcessing || countdownSecondsLeft !== null;
  const cropRect = cropRectFor(cropOptionId, uprightPhotoSize);
  const isFrameLargeEnough = cropOptionId === 'whole' || Math.min(uprightPhotoSize.width, uprightPhotoSize.height) >= fixedCropSizes[cropOptionId];
  const canMeter = Boolean(cameraDevice?.supportsFocusMetering || cameraDevice?.supportsExposureMetering);

  const displayedSkiaImage = useMemo(() => {
    const image = imageForVersion(outcome, displayedVersion);
    return image ? createSkiaImage(image) : null;
  }, [outcome, displayedVersion]);

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    if (!canMeter || !cameraDevice || isBusy) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    setMeteringCameraPoint(viewPoint);
    try {
      // Luz medida en el objeto (el barrido fija luego el enfoque a mano).
      await cameraRef.current?.focusTo(viewPoint, { modes: meteringModes, responsiveness: 'snappy', adaptiveness: 'locked', autoResetAfter: null });
    } catch {
      // Cancelado por otro toque o no admitido.
    }
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function handleCapture() {
    const captureCropOptionId = cropOptionId;
    const captureRangeMode = rangeMode;
    const planCrop = (photoSize: PixelSize) => cropRectFor(captureCropOptionId, photoSize);
    const maximumOutputSide = captureCropOptionId === 'whole' ? wholePhotoOutputSide : undefined;
    setOutcome(null);
    setStatusMessage(null);
    for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
      setCountdownSecondsLeft(secondsLeft);
      await waitMilliseconds(1000);
      if (!isMountedRef.current) return;
    }
    setCountdownSecondsLeft(null);
    let sweepOutcome: FocusSweepOutcome | null;
    try {
      sweepOutcome = await focusSweep.runSweep(captureRangeMode, planCrop, maximumOutputSide);
    } catch (sweepError) {
      setStatusMessage(t('core:common.error', { message: String(sweepError) }));
      return;
    } finally {
      setMeteringCameraPoint(null);
    }
    if (!isMountedRef.current || !sweepOutcome) return;
    const firstCropWidth = sweepOutcome.crops[0]?.width ?? 0;
    const usableIndices = sweepOutcome.crops.flatMap((photoCrop, cropIndex) =>
      photoCrop.width === firstCropWidth && photoCrop.height === firstCropWidth ? [cropIndex] : [],
    );
    if (usableIndices.length < 2) {
      setStatusMessage(sweepOutcome.firstErrorMessage ? t('sweepFailed', { message: sweepOutcome.firstErrorMessage }) : t('tooFewPhotos'));
      return;
    }
    const usableSweep: FocusSweepOutcome = {
      ...sweepOutcome,
      crops: usableIndices.map((cropIndex) => sweepOutcome.crops[cropIndex]!),
      lensPositions: usableIndices.map((cropIndex) => sweepOutcome.lensPositions[cropIndex]!),
    };
    setIsProcessing(true);
    // Deja que se pinte el indicador antes del cálculo, que ocupa el hilo JS varios segundos.
    await waitMilliseconds(50);
    if (!isMountedRef.current) return;
    try {
      const processingStartTime = Date.now();
      const stack = stackFocusBracket(
        usableSweep.crops.map((photoCrop) => photoCrop.rgbPixels),
        firstCropWidth,
      );
      const depthMapImage = renderSourceIndexMap(stack, usableSweep.crops.length);
      setDisplayedVersion('stacked');
      setOutcome({ stack, sweep: usableSweep, rangeMode: captureRangeMode, depthMapImage, processingMilliseconds: Date.now() - processingStartTime });
      setResultSequenceNumber((previousNumber) => previousNumber + 1);
    } catch (processingError) {
      setStatusMessage(t('core:common.error', { message: String(processingError) }));
    } finally {
      setIsProcessing(false);
    }
  }

  function handleOpenFullSize() {
    const orderedVersions = [displayedVersion, ...displayedVersions.filter((version) => version !== displayedVersion)];
    const resultImages = orderedVersions.flatMap((version) => {
      const image = imageForVersion(outcome, version);
      const skiaImage = image ? createSkiaImage(image) : null;
      return skiaImage ? [{ skiaImage, caption: t(`versions.${version}`), fileNamePrefix: `macro-${version}` }] : [];
    });
    if (resultImages.length > 0) resultImageViewer.openViewer(resultImages);
  }

  async function handleSave() {
    if (!outcome) return;
    const stackedSkiaImage = createSkiaImage(outcome.stack.stackedImage);
    const depthSkiaImage = createSkiaImage(outcome.depthMapImage);
    if (!stackedSkiaImage || !depthSkiaImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const stackedFile = writeImageToCachePng(stackedSkiaImage, 'macro');
      const depthFile = writeImageToCachePng(depthSkiaImage, 'macro-profundidad');
      const { stack, sweep } = outcome;
      await saveMeasurement({
        values: {
          capturedFrameCount: sweep.crops.length,
          outputSizePixels: stack.stackedImage.size,
          rangeMode: outcome.rangeMode,
          nearLensPosition: Math.round(sweep.plan.nearPosition * 1000) / 1000,
          farLensPosition: Math.round(sweep.plan.farPosition * 1000) / 1000,
          focusStepPosition: Math.round(sweep.plan.stepPosition * 1000) / 1000,
          focusBreathingPercent: Math.round(stack.focusBreathingPercent * 100) / 100,
          bestSingleFrameIndex: stack.bestSingleFrameIndex,
          captureSeconds: Math.round((sweep.probeMilliseconds + sweep.sweepMilliseconds) / 100) / 10,
          processingSeconds: Math.round(outcome.processingMilliseconds / 100) / 10,
        },
        attachments: [
          {
            kind: 'photo',
            sourceUri: stackedFile.uri,
            fileName: 'macro-enfocado.png',
            mimeType: 'image/png',
            metadata: { widthPixels: stackedSkiaImage.width(), heightPixels: stackedSkiaImage.height(), frameCount: sweep.crops.length },
          },
          {
            kind: 'photo',
            sourceUri: depthFile.uri,
            fileName: 'macro-profundidad.png',
            mimeType: 'image/png',
            metadata: { widthPixels: depthSkiaImage.width(), heightPixels: depthSkiaImage.height() },
          },
        ],
      });
      stackedFile.delete();
      depthFile.delete();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const progressText = focusSweep.progress
    ? t(focusSweep.progress.phase === 'probing' ? 'probingProgress' : 'sweepingProgress', {
        completed: focusSweep.progress.completedCount + 1,
        total: focusSweep.progress.totalCount,
      })
    : '';
  const captureLabel = t('capture');
  const isCaptureDisabled = !isCameraAllowed || !focusSweep.isSupported || !isFrameLargeEnough;

  const unsupportedText = !focusSweep.isSupported ? <BodyText tone="danger">{t('focusLockingUnsupported')}</BodyText> : null;
  const frameTooSmallText = !isFrameLargeEnough ? <BodyText tone="danger">{t('frameTooSmall')}</BodyText> : null;
  const settingsSection = !isBusy ? (
    <>
      <BodyText tone="secondary">{t('cropTitle')}</BodyText>
      <ChoiceChips<CropOptionId> options={cropOptionIds} selectedOption={cropOptionId} labelFor={(option) => t(`cropOptions.${option}`)} onSelect={setCropOptionId} />
      <BodyText tone="secondary">{t('rangeTitle')}</BodyText>
      <ChoiceChips<FocusRangeMode> options={rangeModes} selectedOption={rangeMode} labelFor={(mode) => t(`rangeModes.${mode}`)} onSelect={setRangeMode} />
      <BodyText tone="secondary" style={styles.smallText}>
        {t(`rangeHints.${rangeMode}`)}
      </BodyText>
    </>
  ) : null;
  const processingIndicator = isProcessing ? <LoadingState label={t('processing')} /> : null;

  let resultSection: ReactNode = null;
  if (outcome && displayedSkiaImage) {
    const { stack, sweep } = outcome;
    const frameCount = sweep.crops.length;
    resultSection = (
      <>
        <SectionTitle>{t('resultTitle')}</SectionTitle>
        <ChoiceChips<DisplayedVersion>
          options={displayedVersions}
          selectedOption={displayedVersion}
          labelFor={(version) => t(`versions.${version}`)}
          onSelect={setDisplayedVersion}
        />
        <Pressable accessibilityRole="button" accessibilityLabel={t('openFullSize')} onPress={handleOpenFullSize}>
          <ResultImage label={t(`versions.${displayedVersion}`)} skiaImage={displayedSkiaImage} />
        </Pressable>
        {displayedVersion === 'depthMap' ? <DepthLegend frameCount={frameCount} lensPositions={sweep.lensPositions} /> : null}
        <BodyText tone="secondary" style={styles.smallText}>
          {t(`versionHints.${displayedVersion}`, { index: stack.bestSingleFrameIndex + 1, count: frameCount })}
        </BodyText>
        <AppButton label={t('openFullSize')} onPress={handleOpenFullSize} variant="secondary" />
        <BodyText tone="secondary">
          {t('sweepSummary', {
            count: frameCount,
            near: sweep.plan.nearPosition.toFixed(2),
            far: sweep.plan.farPosition.toFixed(2),
            nearDistance: distanceText(sweep.plan.nearPosition),
            farDistance: distanceText(sweep.plan.farPosition),
            step: sweep.plan.stepPosition.toFixed(3),
          })}
        </BodyText>
        {outcome.rangeMode === 'auto' ? (
          <BodyText tone="secondary">
            {sweep.plan.isFallback ? t('probeFallback') : t('probeSummary', { photos: sweep.probePhotoCount, tiles: sweep.plan.usedTileCount })}
          </BodyText>
        ) : null}
        {sweep.plan.hasFocusGaps ? <BodyText tone="danger">{t('focusGapsWarning')}</BodyText> : null}
        {sweep.wasStopped ? <BodyText tone="secondary">{t('sweepStopped')}</BodyText> : null}
        <BodyText tone="secondary">
          {t('alignmentSummary', { breathing: stack.focusBreathingPercent.toFixed(2), shift: stack.maximumShiftPixels.toFixed(1) })}
        </BodyText>
        <BodyText tone="secondary">
          {t(sweep.hasLockedExposure ? 'exposureLocked' : 'exposureNotLocked')} {t(sweep.hasLockedWhiteBalance ? 'whiteBalanceLocked' : 'whiteBalanceNotLocked')}
        </BodyText>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('timings', {
            probeSeconds: secondsText(sweep.probeMilliseconds),
            sweepSeconds: secondsText(sweep.sweepMilliseconds),
            decodeSeconds: secondsText(sweep.decodeMilliseconds),
            alignSeconds: secondsText(stack.timings.alignmentMilliseconds),
            sharpnessSeconds: secondsText(stack.timings.sharpnessMilliseconds),
            blendSeconds: secondsText(stack.timings.blendMilliseconds),
            totalSeconds: secondsText(outcome.processingMilliseconds),
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
  } else if (focusSweep.isRunning) {
    fullScreenReadout = <CameraOverlayText style={styles.readoutValue}>{progressText}</CameraOverlayText>;
  } else if (isProcessing) {
    fullScreenReadout = <CameraOverlayText>{t('processing')}</CameraOverlayText>;
  } else {
    fullScreenReadout = (
      <CameraOverlayText style={focusSweep.isSupported ? undefined : styles.readoutWarning}>
        {focusSweep.isSupported ? t(`rangeModes.${rangeMode}`) : t('focusLockingUnsupported')}
      </CameraOverlayText>
    );
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
            accessibilityLabel={t('tapToMeterHint')}
            accessibilityState={{ disabled: isBusy }}
            disabled={isBusy}
            style={StyleSheet.absoluteFill}
            onPress={(pressEvent) => void handlePreviewPress(pressEvent)}>
            {meteringCameraPoint ? (
              <View
                pointerEvents="none"
                style={[styles.meteringMarker, { left: meteringCameraPoint.x - meteringMarkerRadius, top: meteringCameraPoint.y - meteringMarkerRadius }]}
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
        focusSweep.isRunning ? <CameraOverlayButton label={t('stop')} accessibilityLabel={t('stop')} onPress={focusSweep.stopSweep} /> : null
      }
      readout={fullScreenReadout}
      primaryActions={
        <View style={styles.captureActionCell}>
          {focusSweep.isRunning ? (
            <AppButton label={t('stop')} onPress={focusSweep.stopSweep} variant="danger" />
          ) : (
            <AppButton label={captureLabel} onPress={() => void handleCapture()} isDisabled={isCaptureDisabled} isBusy={isBusy} />
          )}
        </View>
      }
      panelContent={
        <>
          <BodyText tone="secondary">{t('tapToMeterHint')}</BodyText>
          {unsupportedText}
          {frameTooSmallText}
          {settingsSection}
          {processingIndicator}
          {resultSection}
          {statusText}
          {howItWorksText}
        </>
      }
      panelOpenRequestKey={resultSequenceNumber > 0 ? resultSequenceNumber : null}>
      <BodyText tone="secondary">{t('tapToMeterHint')}</BodyText>
      {unsupportedText}
      {frameTooSmallText}
      {settingsSection}
      {countdownSecondsLeft !== null ? (
        <Card style={styles.centeredCard}>
          <BodyText tone="secondary">{t('holdStill')}</BodyText>
          <BodyText style={styles.countdownValue}>{countdownSecondsLeft}</BodyText>
        </Card>
      ) : null}
      {focusSweep.isRunning ? (
        <View style={styles.buttonRow}>
          <BodyText style={styles.flexText}>{progressText}</BodyText>
          <View style={styles.stopButton}>
            <AppButton label={t('stop')} onPress={focusSweep.stopSweep} variant="secondary" />
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
  cropFrame: { position: 'absolute', borderWidth: 2, borderColor: '#38BDF8', borderRadius: 4 },
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
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendSwatches: { flex: 1, flexDirection: 'row', height: 14, borderRadius: 4, overflow: 'hidden' },
  legendSwatch: { flex: 1 },
  smallText: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexText: { flex: 1 },
  stopButton: { width: 110 },
  centeredCard: { alignItems: 'center', paddingVertical: 16, gap: 4 },
  countdownValue: { fontSize: 48, lineHeight: 56, fontWeight: '700', fontVariant: ['tabular-nums'] },
  captureActionCell: { flex: 1 },
  readoutCountdown: { fontSize: 40, lineHeight: 46, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutValue: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutWarning: { color: '#FCA5A5' },
});
