import { AlphaType, Canvas, ColorType, Image as SkiaImageView, type SkImage, Skia } from '@shopify/react-native-skia';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { useCameraZoomAndExposure } from '@/core/camera/useCameraZoomAndExposure';
import { useDeviceSteadiness } from '@/core/camera/useDeviceSteadiness';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import {
  defaultSuperResolutionOptions,
  floatImageToRgba,
  sharpeningSigmaForScale,
  superResolveBurst,
  type SuperResolutionResult,
} from '@/processing/image/burstSuperResolution';
import { type FloatRgbImage, sharpenImage } from '@/processing/image/lunarStacking';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { SuperzoomMeasurementValues } from './schema';
import { useBurstFrames } from './useBurstFrames';

export const superzoomInstrumentId = 'superzoom';

const previewHeight = 340;
/** Lado del recorte central de cada fotograma; el resultado mide el doble. */
const cropSizePixels = 384;
/** Fotogramas de cada ráfaga (~0,5 s); se fusiona la fracción más nítida. */
const capturedFrameTarget = 12;
/** Cuenta atrás antes de capturar, para que el toque en la pantalla no mueva la imagen. */
const captureCountdownSeconds = 2;
const zoomStepFactor = Math.SQRT2;
const meteringMarkerRadius = 28;
const sharpeningLevels = [
  { labelKey: 'sharpening.none', amount: 0 },
  { labelKey: 'sharpening.soft', amount: 0.5 },
  { labelKey: 'sharpening.medium', amount: 1 },
  { labelKey: 'sharpening.strong', amount: 1.6 },
] as const;
const defaultSharpeningLevelIndex = 1;

type DisplayedVersion = 'superzoom' | 'singleFrame';

interface SuperzoomOutcome {
  result: SuperResolutionResult;
  capturedFrameCount: number;
  zoomFactor: number;
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

/** Recuadro que marca en la vista previa la zona que se amplía (la vista usa `contain`). */
function CropFrameOverlay({
  previewWidth,
  frameWidth,
  frameHeight,
}: {
  previewWidth: number;
  frameWidth: number;
  frameHeight: number;
}) {
  const displayScale = Math.min(previewWidth / frameWidth, previewHeight / frameHeight);
  const cropSideOnScreen = cropSizePixels * displayScale;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.cropFrame,
        {
          width: cropSideOnScreen,
          height: cropSideOnScreen,
          left: (previewWidth - cropSideOnScreen) / 2,
          top: (previewHeight - cropSideOnScreen) / 2,
        },
      ]}
    />
  );
}

function StepperRow({
  label,
  decreaseLabel,
  increaseLabel,
  onDecrease,
  onIncrease,
  isDecreaseDisabled,
  isIncreaseDisabled,
}: {
  label: string;
  decreaseLabel: string;
  increaseLabel: string;
  onDecrease(): void;
  onIncrease(): void;
  isDecreaseDisabled: boolean;
  isIncreaseDisabled: boolean;
}) {
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

function ChoiceChips<TOption extends string | number>({
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
            key={String(option)}
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

export function SuperzoomScreen({ saveMeasurement, sensorAvailability }: InstrumentScreenProps<SuperzoomMeasurementValues>) {
  const { t } = useTranslation(superzoomInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const hasGyroscope = sensorAvailability.gyroscope.status === 'available';
  const { isSteadyForDisplay } = useDeviceSteadiness(isCameraAllowed, hasGyroscope);
  const { frameOutput, frameDimensions, isCapturing, captureProgress, captureBurst, stopCapture } = useBurstFrames();
  const { zoomFactor, minimumZoom, maximumZoom, setRequestedZoom, exposureBias, handleCameraStarted } =
    useCameraZoomAndExposure(cameraRef, cameraDevice);

  const [previewWidth, setPreviewWidth] = useState(0);
  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [superzoomOutcome, setSuperzoomOutcome] = useState<SuperzoomOutcome | null>(null);
  const [displayedVersion, setDisplayedVersion] = useState<DisplayedVersion>('superzoom');
  const [sharpeningLevelIndex, setSharpeningLevelIndex] = useState(defaultSharpeningLevelIndex);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const sharpeningAmount = sharpeningLevels[sharpeningLevelIndex]?.amount ?? 0;
  // Se realza al mostrar (con el mismo nivel en las dos versiones, para compararlas con justicia).
  const displayedSkiaImage = useMemo(() => {
    if (!superzoomOutcome) return null;
    const baseImage =
      displayedVersion === 'superzoom' ? superzoomOutcome.result.image : superzoomOutcome.result.singleFrameImage;
    const sharpeningSigma = sharpeningSigmaForScale(defaultSuperResolutionOptions.scale);
    return createSkiaImage(sharpeningAmount > 0 ? sharpenImage(baseImage, sharpeningSigma, sharpeningAmount) : baseImage);
  }, [superzoomOutcome, displayedVersion, sharpeningAmount]);

  const isFrameLargeEnough =
    frameDimensions === null || Math.min(frameDimensions.frameWidth, frameDimensions.frameHeight) >= cropSizePixels;
  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);
  const isBusy = isCapturing || isProcessing || countdownSecondsLeft !== null;

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    if (!canMeter || !cameraDevice) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    setMeteringViewPoint(viewPoint);
    try {
      // Enfoque y exposición fijos: si cambian durante la ráfaga, los fotogramas no casan.
      await cameraRef.current?.focusTo(viewPoint, {
        modes: meteringModes,
        responsiveness: 'snappy',
        adaptiveness: 'locked',
        autoResetAfter: null,
      });
      if (exposureBias !== undefined) await cameraRef.current?.controller?.setExposureBias(exposureBias);
    } catch {
      // Cancelado por otro toque o no admitido: la vista previa sigue funcionando.
    }
  }

  async function handleUnlockMetering() {
    setMeteringViewPoint(null);
    try {
      await cameraRef.current?.resetFocus();
    } catch {
      // La cámara puede no estar lista; no hay nada que deshacer.
    }
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function handleCapture() {
    const captureZoomFactor = zoomFactor;
    setSuperzoomOutcome(null);
    setStatusMessage(null);
    for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
      setCountdownSecondsLeft(secondsLeft);
      await waitMilliseconds(1000);
    }
    setCountdownSecondsLeft(null);
    const capturedFrames = await captureBurst(capturedFrameTarget, cropSizePixels);
    if (capturedFrames.length === 0) {
      setStatusMessage(t('noFramesCaptured'));
      return;
    }
    setIsProcessing(true);
    // Deja que se pinte el indicador antes del cálculo, que ocupa el hilo JS unos segundos.
    await waitMilliseconds(50);
    try {
      const result = superResolveBurst(capturedFrames, cropSizePixels, defaultSuperResolutionOptions);
      setDisplayedVersion('superzoom');
      setSuperzoomOutcome({ result, capturedFrameCount: capturedFrames.length, zoomFactor: captureZoomFactor });
    } catch (processingError) {
      setStatusMessage(t('core:common.error', { message: String(processingError) }));
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleSave() {
    if (!superzoomOutcome) return;
    const sharpenedImage =
      sharpeningAmount > 0
        ? sharpenImage(
            superzoomOutcome.result.image,
            sharpeningSigmaForScale(defaultSuperResolutionOptions.scale),
            sharpeningAmount,
          )
        : superzoomOutcome.result.image;
    const savedSkiaImage = createSkiaImage(sharpenedImage);
    if (!savedSkiaImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const pngFile = writeImageToCachePng(savedSkiaImage, 'superzoom');
      await saveMeasurement({
        values: {
          capturedFrameCount: superzoomOutcome.capturedFrameCount,
          mergedFrameCount: superzoomOutcome.result.usedFrameCount,
          cropSizePixels,
          outputSizePixels: superzoomOutcome.result.image.size,
          zoomFactor: Math.round(superzoomOutcome.zoomFactor * 100) / 100,
          meanShiftPixels: Math.round(superzoomOutcome.result.meanShiftPixels * 10) / 10,
          sharpeningAmount,
        },
        attachments: [
          {
            kind: 'photo',
            sourceUri: pngFile.uri,
            fileName: 'superzoom.png',
            mimeType: 'image/png',
            metadata: {
              widthPixels: savedSkiaImage.width(),
              heightPixels: savedSkiaImage.height(),
              mergedFrameCount: superzoomOutcome.result.usedFrameCount,
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

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('intro')}</BodyText>

      <View
        style={[styles.previewContainer, { borderColor: themePalette.border }]}
        onLayout={(layoutEvent: LayoutChangeEvent) => setPreviewWidth(layoutEvent.nativeEvent.layout.width)}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={cameraDevice ?? 'back'}
          isActive={isCameraAllowed}
          outputs={[frameOutput]}
          zoom={zoomFactor}
          exposure={exposureBias}
          onError={handleCameraError}
          onStarted={handleCameraStarted}
          resizeMode="contain"
        />
        {frameDimensions && previewWidth > 0 ? (
          <CropFrameOverlay
            previewWidth={previewWidth}
            frameWidth={frameDimensions.frameWidth}
            frameHeight={frameDimensions.frameHeight}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tapToFocusHint')}
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
      </View>

      <BodyText tone="secondary">{t('tapToFocusHint')}</BodyText>
      {meteringViewPoint ? (
        <View style={styles.buttonRow}>
          <BodyText style={styles.flexText}>{t('focusLocked')}</BodyText>
          <View style={styles.unlockButton}>
            <AppButton label={t('unlockFocus')} onPress={() => void handleUnlockMetering()} variant="secondary" />
          </View>
        </View>
      ) : null}
      {!isFrameLargeEnough ? <BodyText tone="danger">{t('frameTooSmall')}</BodyText> : null}
      {hasGyroscope && !isBusy ? (
        <BodyText tone={isSteadyForDisplay ? 'secondary' : 'danger'}>
          {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
        </BodyText>
      ) : null}

      <StepperRow
        label={t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}
        decreaseLabel={t('zoomOut')}
        increaseLabel={t('zoomIn')}
        onDecrease={() => setRequestedZoom(Math.max(minimumZoom, zoomFactor / zoomStepFactor))}
        onIncrease={() => setRequestedZoom(Math.min(maximumZoom, zoomFactor * zoomStepFactor))}
        isDecreaseDisabled={zoomFactor <= minimumZoom || isBusy}
        isIncreaseDisabled={zoomFactor >= maximumZoom || isBusy}
      />
      <BodyText tone="secondary">{t('zoomHint')}</BodyText>

      {countdownSecondsLeft !== null ? (
        <Card style={styles.centeredCard}>
          <BodyText tone="secondary">{t('holdStill')}</BodyText>
          <BodyText style={styles.countdownValue}>{countdownSecondsLeft}</BodyText>
        </Card>
      ) : null}
      {isCapturing && captureProgress ? (
        <View style={styles.buttonRow}>
          <BodyText style={styles.flexText}>
            {t('capturingProgress', {
              captured: captureProgress.capturedFrameCount,
              target: captureProgress.targetFrameCount,
            })}
          </BodyText>
          <View style={styles.unlockButton}>
            <AppButton label={t('stopCapture')} onPress={stopCapture} variant="secondary" />
          </View>
        </View>
      ) : null}
      {isProcessing ? <LoadingState label={t('processing')} /> : null}
      {!isBusy ? (
        <AppButton
          label={t('capture', { count: capturedFrameTarget })}
          onPress={() => void handleCapture()}
          isDisabled={!isCameraAllowed || !isFrameLargeEnough}
        />
      ) : null}

      {superzoomOutcome && displayedSkiaImage ? (
        <>
          <SectionTitle>{t('resultTitle')}</SectionTitle>
          <ChoiceChips<DisplayedVersion>
            options={['superzoom', 'singleFrame']}
            selectedOption={displayedVersion}
            labelFor={(version) => t(`versions.${version}`)}
            onSelect={setDisplayedVersion}
          />
          <ResultImage label={t(`versions.${displayedVersion}`)} skiaImage={displayedSkiaImage} />
          <BodyText tone="secondary">{t('compareHint')}</BodyText>
          <BodyText tone="secondary">{t('sharpeningTitle')}</BodyText>
          <ChoiceChips<number>
            options={sharpeningLevels.map((_level, levelIndex) => levelIndex)}
            selectedOption={sharpeningLevelIndex}
            labelFor={(levelIndex) => t(sharpeningLevels[levelIndex]?.labelKey ?? 'sharpening.none')}
            onSelect={setSharpeningLevelIndex}
          />
          <BodyText tone="secondary">
            {t('mergeExplanation', {
              captured: superzoomOutcome.capturedFrameCount,
              merged: superzoomOutcome.result.usedFrameCount,
              size: superzoomOutcome.result.image.size,
            })}
          </BodyText>
          <BodyText tone="secondary">
            {superzoomOutcome.result.meanShiftPixels < 0.5
              ? t('tooLittleMovement')
              : t('handMovement', { shift: superzoomOutcome.result.meanShiftPixels.toFixed(1) })}
          </BodyText>
          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
        </>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('howItWorks')}
      </BodyText>
    </ScreenContainer>
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

const styles = StyleSheet.create({
  previewContainer: {
    height: previewHeight,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  cropFrame: { position: 'absolute', borderWidth: 2, borderColor: '#FACC15', borderRadius: 4 },
  meteringMarker: {
    position: 'absolute',
    width: meteringMarkerRadius * 2,
    height: meteringMarkerRadius * 2,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#4ADE80',
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 110 },
  stepperLabel: { flex: 1, textAlign: 'center', fontWeight: '600', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexText: { flex: 1 },
  unlockButton: { width: 110 },
  centeredCard: { alignItems: 'center', paddingVertical: 16, gap: 4 },
  countdownValue: { fontSize: 48, lineHeight: 56, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  resultImageFrame: { width: '100%', aspectRatio: 1, backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
  smallText: { fontSize: 13 },
});
