import { AlphaType, Canvas, ColorType, Image as SkiaImageView, type SkImage, Skia } from '@shopify/react-native-skia';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { writeImageToCachePng } from '@/core/camera/imageFiles';
import { centeredFrameSquareInView, type PreviewPoint } from '@/core/camera/previewGeometry';
import { useCameraZoomAndExposure } from '@/core/camera/useCameraZoomAndExposure';
import { useCameraPointsInView } from '@/core/camera/useCameraPointsInView';
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
import { AppButton, BodyText, Card, LoadingState, SectionTitle } from '@/ui/components';
import { CameraOverlayButton, CameraOverlayText, CameraScreenLayout } from '@/ui/FullScreenCamera';
import { useThemePalette } from '@/ui/theme';

import type { SuperzoomMeasurementValues } from './schema';
import { useBurstFrames } from './useBurstFrames';

export const superzoomInstrumentId = 'superzoom';

/**
 * Lado del recorte central de cada fotograma (el resultado mide el doble). Más grande abarca más
 * escena, pero el cálculo crece con el área: el grande tarda unas cuatro veces lo que el pequeño.
 */
const cropSizeOptions = [
  { labelKey: 'cropSizes.small', cropSizePixels: 512 },
  { labelKey: 'cropSizes.medium', cropSizePixels: 768 },
  { labelKey: 'cropSizes.large', cropSizePixels: 1024 },
] as const;
const defaultCropSizeOptionIndex = 1;
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
  cropSizePixels: number;
  zoomFactor: number;
  processingSeconds: number;
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
  previewHeight,
  frameWidth,
  frameHeight,
  cropSizePixels,
}: {
  previewWidth: number;
  previewHeight: number;
  frameWidth: number;
  frameHeight: number;
  cropSizePixels: number;
}) {
  const cropRect = centeredFrameSquareInView({
    viewWidth: previewWidth,
    viewHeight: previewHeight,
    frameWidth,
    frameHeight,
    squareSidePixels: cropSizePixels,
  });
  return <View pointerEvents="none" style={[styles.cropFrame, cropRect]} />;
}

/** Recuadro del punto de enfoque, situado a partir de su punto de cámara (no se descoloca al cambiar de tamaño). */
function MeteringMarker({
  cameraRef,
  meteringCameraPoints,
  previewWidth,
  previewHeight,
}: {
  cameraRef: RefObject<CameraRef | null>;
  meteringCameraPoints: readonly (PreviewPoint | null)[];
  previewWidth: number;
  previewHeight: number;
}) {
  const [meteringViewPoint] = useCameraPointsInView(cameraRef, meteringCameraPoints, previewWidth, previewHeight);
  if (!meteringViewPoint) return null;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.meteringMarker,
        { left: meteringViewPoint.x - meteringMarkerRadius, top: meteringViewPoint.y - meteringMarkerRadius },
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
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const hasGyroscope = sensorAvailability.gyroscope.status === 'available';
  const { isSteadyForDisplay } = useDeviceSteadiness(isCameraAllowed, hasGyroscope);
  const { frameOutput, frameDimensions, isCapturing, captureProgress, captureBurst, stopCapture } = useBurstFrames();
  const { zoomFactor, minimumZoom, maximumZoom, setRequestedZoom, exposureBias, handleCameraStarted } =
    useCameraZoomAndExposure(cameraRef, cameraDevice);

  // Enfoque fijado: se guarda el punto en coordenadas de cámara para dibujarlo bien a cualquier tamaño.
  const [isMeteringLocked, setIsMeteringLocked] = useState(false);
  const [meteringCameraPoints, setMeteringCameraPoints] = useState<(PreviewPoint | null)[]>([null]);
  // Cambia con cada resultado nuevo: en pantalla completa abre el panel para verlo.
  const [resultSequenceNumber, setResultSequenceNumber] = useState(0);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [superzoomOutcome, setSuperzoomOutcome] = useState<SuperzoomOutcome | null>(null);
  const [displayedVersion, setDisplayedVersion] = useState<DisplayedVersion>('superzoom');
  const [sharpeningLevelIndex, setSharpeningLevelIndex] = useState(defaultSharpeningLevelIndex);
  const [cropSizeOptionIndex, setCropSizeOptionIndex] = useState(defaultCropSizeOptionIndex);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // La captura espera varias veces (cuenta atrás, ráfaga): si se sale de la pantalla entretanto,
  // no se sigue (ni se ocupa el hilo JS fusionando) en la pantalla siguiente.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const sharpeningAmount = sharpeningLevels[sharpeningLevelIndex]?.amount ?? 0;
  // Se realza al mostrar (con el mismo nivel en las dos versiones, para compararlas con justicia).
  const displayedSkiaImage = useMemo(() => {
    if (!superzoomOutcome) return null;
    const baseImage =
      displayedVersion === 'superzoom' ? superzoomOutcome.result.image : superzoomOutcome.result.singleFrameImage;
    const sharpeningSigma = sharpeningSigmaForScale(defaultSuperResolutionOptions.scale);
    return createSkiaImage(sharpeningAmount > 0 ? sharpenImage(baseImage, sharpeningSigma, sharpeningAmount) : baseImage);
  }, [superzoomOutcome, displayedVersion, sharpeningAmount]);

  const cropSizePixels =
    cropSizeOptions[cropSizeOptionIndex]?.cropSizePixels ?? cropSizeOptions[defaultCropSizeOptionIndex].cropSizePixels;
  const isFrameLargeEnough =
    frameDimensions === null || Math.min(frameDimensions.frameWidth, frameDimensions.frameHeight) >= cropSizePixels;
  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);
  const isBusy = isCapturing || isProcessing || countdownSecondsLeft !== null;

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    // Reenfocar a mitad de ráfaga haría que los fotogramas dejaran de casar.
    if (!canMeter || !cameraDevice || isBusy) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    let meteringCameraPoint: PreviewPoint | null = null;
    try {
      meteringCameraPoint = cameraRef.current?.convertViewPointToCameraPoint(viewPoint) ?? null;
    } catch {
      // La vista previa aún no está lista: se enfoca igual, pero sin dibujar el recuadro.
    }
    setIsMeteringLocked(true);
    setMeteringCameraPoints([meteringCameraPoint]);
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
    setIsMeteringLocked(false);
    setMeteringCameraPoints([null]);
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
    const captureCropSizePixels = cropSizePixels;
    setSuperzoomOutcome(null);
    setStatusMessage(null);
    for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
      setCountdownSecondsLeft(secondsLeft);
      await waitMilliseconds(1000);
      if (!isMountedRef.current) return;
    }
    setCountdownSecondsLeft(null);
    const capturedFrames = await captureBurst(capturedFrameTarget, captureCropSizePixels);
    if (!isMountedRef.current) return;
    if (capturedFrames.length === 0) {
      setStatusMessage(t('noFramesCaptured'));
      return;
    }
    setIsProcessing(true);
    // Deja que se pinte el indicador antes del cálculo, que ocupa el hilo JS unos segundos.
    await waitMilliseconds(50);
    if (!isMountedRef.current) return;
    try {
      const processingStartTime = Date.now();
      const result = superResolveBurst(capturedFrames, captureCropSizePixels, defaultSuperResolutionOptions);
      setDisplayedVersion('superzoom');
      setSuperzoomOutcome({
        result,
        capturedFrameCount: capturedFrames.length,
        cropSizePixels: captureCropSizePixels,
        zoomFactor: captureZoomFactor,
        processingSeconds: (Date.now() - processingStartTime) / 1000,
      });
      setResultSequenceNumber((previousSequenceNumber) => previousSequenceNumber + 1);
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
          cropSizePixels: superzoomOutcome.cropSizePixels,
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

  function zoomOut() {
    setRequestedZoom(Math.max(minimumZoom, zoomFactor / zoomStepFactor));
  }

  function zoomIn() {
    setRequestedZoom(Math.min(maximumZoom, zoomFactor * zoomStepFactor));
  }

  const isZoomOutDisabled = zoomFactor <= minimumZoom || isBusy;
  const isZoomInDisabled = zoomFactor >= maximumZoom || isBusy;
  const captureLabel = t('capture', { count: capturedFrameTarget });
  const isCaptureDisabled = !isCameraAllowed || !isFrameLargeEnough;

  // Piezas que se reparten de forma distinta en el modo normal y en pantalla completa.
  const focusLockRow = isMeteringLocked ? (
    <View style={styles.buttonRow}>
      <BodyText style={styles.flexText}>{t('focusLocked')}</BodyText>
      <View style={styles.unlockButton}>
        <AppButton label={t('unlockFocus')} onPress={() => void handleUnlockMetering()} variant="secondary" />
      </View>
    </View>
  ) : null;
  const frameTooSmallText = !isFrameLargeEnough ? <BodyText tone="danger">{t('frameTooSmall')}</BodyText> : null;
  const steadinessText =
    hasGyroscope && !isBusy ? (
      <BodyText tone={isSteadyForDisplay ? 'secondary' : 'danger'}>
        {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
      </BodyText>
    ) : null;
  const cropSizeChooser = !isBusy ? (
    <>
      <BodyText tone="secondary">{t('cropSizeTitle')}</BodyText>
      <ChoiceChips<number>
        options={cropSizeOptions.map((_option, optionIndex) => optionIndex)}
        selectedOption={cropSizeOptionIndex}
        labelFor={(optionIndex) => t(cropSizeOptions[optionIndex]?.labelKey ?? 'cropSizes.medium')}
        onSelect={setCropSizeOptionIndex}
      />
    </>
  ) : null;
  const processingIndicator = isProcessing ? <LoadingState label={t('processing')} /> : null;
  const resultSection =
    superzoomOutcome && displayedSkiaImage ? (
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
            seconds: superzoomOutcome.processingSeconds.toFixed(1),
          })}
        </BodyText>
        <BodyText tone="secondary">
          {superzoomOutcome.result.meanShiftPixels < 0.5
            ? t('tooLittleMovement')
            : t('handMovement', { shift: superzoomOutcome.result.meanShiftPixels.toFixed(1) })}
        </BodyText>
        <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
      </>
    ) : null;
  const statusText = statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null;
  const howItWorksText = (
    <BodyText tone="secondary" style={styles.smallText}>
      {t('howItWorks')}
    </BodyText>
  );

  // Lectura flotante en pantalla completa: cuenta atrás, progreso de la ráfaga o zoom y pulso.
  let fullScreenReadout: ReactNode;
  if (countdownSecondsLeft !== null) {
    fullScreenReadout = (
      <>
        <CameraOverlayText>{t('holdStill')}</CameraOverlayText>
        <CameraOverlayText style={styles.readoutCountdown}>{countdownSecondsLeft}</CameraOverlayText>
      </>
    );
  } else if (isCapturing && captureProgress) {
    fullScreenReadout = (
      <CameraOverlayText style={styles.readoutValue}>
        {t('capturingProgress', {
          captured: captureProgress.capturedFrameCount,
          target: captureProgress.targetFrameCount,
        })}
      </CameraOverlayText>
    );
  } else if (isProcessing) {
    fullScreenReadout = <CameraOverlayText>{t('processing')}</CameraOverlayText>;
  } else {
    fullScreenReadout = (
      <>
        <CameraOverlayText style={styles.readoutValue}>{t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}</CameraOverlayText>
        {!isFrameLargeEnough ? (
          <CameraOverlayText style={styles.readoutWarning}>{t('frameTooSmall')}</CameraOverlayText>
        ) : hasGyroscope ? (
          <CameraOverlayText style={isSteadyForDisplay ? undefined : styles.readoutWarning}>
            {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
          </CameraOverlayText>
        ) : null}
      </>
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
            outputs={[frameOutput]}
            zoom={zoomFactor}
            exposure={exposureBias}
            onError={handleCameraError}
            onStarted={handleCameraStarted}
            resizeMode="contain"
          />
          {frameDimensions && previewWidth > 0 && previewHeight > 0 ? (
            <CropFrameOverlay
              previewWidth={previewWidth}
              previewHeight={previewHeight}
              frameWidth={frameDimensions.frameWidth}
              frameHeight={frameDimensions.frameHeight}
              cropSizePixels={cropSizePixels}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('tapToFocusHint')}
            accessibilityState={{ disabled: isBusy }}
            disabled={isBusy}
            style={StyleSheet.absoluteFill}
            onPress={(pressEvent) => void handlePreviewPress(pressEvent)}>
            <MeteringMarker
              cameraRef={cameraRef}
              meteringCameraPoints={meteringCameraPoints}
              previewWidth={previewWidth}
              previewHeight={previewHeight}
            />
          </Pressable>
        </>
      )}
      topActions={
        isMeteringLocked ? (
          <CameraOverlayButton
            label={t('unlockFocus')}
            accessibilityLabel={`${t('focusLocked')} ${t('unlockFocus')}`}
            onPress={() => void handleUnlockMetering()}
          />
        ) : null
      }
      readout={fullScreenReadout}
      primaryActions={
        <>
          <View style={styles.primaryActionCell}>
            <AppButton label={t('zoomOut')} onPress={zoomOut} isDisabled={isZoomOutDisabled} variant="secondary" />
          </View>
          <View style={styles.captureActionCell}>
            {isCapturing ? (
              <AppButton label={t('stopCapture')} onPress={stopCapture} variant="danger" />
            ) : (
              <AppButton
                label={captureLabel}
                onPress={() => void handleCapture()}
                isDisabled={isCaptureDisabled}
                isBusy={isBusy}
              />
            )}
          </View>
          <View style={styles.primaryActionCell}>
            <AppButton label={t('zoomIn')} onPress={zoomIn} isDisabled={isZoomInDisabled} variant="secondary" />
          </View>
        </>
      }
      panelContent={
        <>
          <BodyText tone="secondary">{t('tapToFocusHint')}</BodyText>
          {focusLockRow}
          {frameTooSmallText}
          {steadinessText}
          <BodyText tone="secondary">{t('zoomHint')}</BodyText>
          {cropSizeChooser}
          {processingIndicator}
          {resultSection}
          {statusText}
          {howItWorksText}
        </>
      }
      panelOpenRequestKey={resultSequenceNumber > 0 ? resultSequenceNumber : null}>
      <BodyText tone="secondary">{t('tapToFocusHint')}</BodyText>
      {focusLockRow}
      {frameTooSmallText}
      {steadinessText}

      <StepperRow
        label={t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}
        decreaseLabel={t('zoomOut')}
        increaseLabel={t('zoomIn')}
        onDecrease={zoomOut}
        onIncrease={zoomIn}
        isDecreaseDisabled={isZoomOutDisabled}
        isIncreaseDisabled={isZoomInDisabled}
      />
      <BodyText tone="secondary">{t('zoomHint')}</BodyText>

      {cropSizeChooser}

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
      {processingIndicator}
      {!isBusy ? <AppButton label={captureLabel} onPress={() => void handleCapture()} isDisabled={isCaptureDisabled} /> : null}

      {resultSection}
      {statusText}
      {howItWorksText}
    </CameraScreenLayout>
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
  primaryActionCell: { flex: 1 },
  captureActionCell: { flex: 1.6 },
  readoutCountdown: { fontSize: 40, lineHeight: 46, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutValue: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutWarning: { color: '#FCA5A5' },
});
