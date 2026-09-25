import { Canvas, Image as SkiaImageView, type SkImage } from '@shopify/react-native-skia';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { PointingGuidance } from '@/processing/astronomy/pointingGuide';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import {
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
import { createSkiaImage, writeImageToCachePng } from './stackedImage';
import { createExposureScale, formatExposureValue, stepExposure } from './exposureScale';
import { useDeviceSteadiness } from './useDeviceSteadiness';
import { useMoonFrames } from './useMoonFrames';
import { useMoonPointingGuide } from './useMoonPointingGuide';

const previewHeight = 340;
/** Fotogramas que se capturan en cada toma (~1-3 s según el móvil). */
const capturedFrameTarget = 30;
/** Fracción más nítida que se apila; el resto se descarta por la turbulencia. */
const keptFrameFraction = 0.5;
/** Niveles de realce del detalle (máscara de enfoque) que se pueden elegir tras apilar. */
const sharpeningLevels = [
  { labelKey: 'sharpening.none', amount: 0 },
  { labelKey: 'sharpening.soft', amount: 0.6 },
  { labelKey: 'sharpening.medium', amount: 1.2 },
  { labelKey: 'sharpening.strong', amount: 2 },
] as const;
const defaultSharpeningLevelIndex = 2;
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
/** Diámetro mínimo en píxeles para que merezca la pena apilar. */
const recommendedMoonDiameterPixels = 80;

interface StackingOutcome {
  /** Apilado sin realzar: el realce se aplica después, según el nivel elegido. */
  stackedBaseImage: FloatRgbImage;
  sharpeningSigma: number;
  bestSingleSkiaImage: SkImage;
  capturedFrameCount: number;
  rejectedFrameCount: number;
  stackedFrameCount: number;
  moonDiameterPixels: number;
  zoomFactor: number;
  exposureBias?: number;
}

function waitMilliseconds(durationMilliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMilliseconds));
}

function clampNumber(value: number, minimumValue: number, maximumValue: number): number {
  return Math.min(maximumValue, Math.max(minimumValue, value));
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
  const { frameOutput, liveDetection, isCapturing, captureProgress, captureCrops, stopCapture } =
    useMoonFrames(isDeviceSteady);
  const hasOrientationSensors =
    sensorAvailability.accelerometer.status === 'available' && sensorAvailability.magnetometer.status === 'available';
  const pointingGuidance = useMoonPointingGuide(moonReport.horizontalPosition, isCameraAllowed && hasOrientationSensors);

  const minimumZoom = cameraDevice?.minZoom ?? 1;
  const maximumZoom = cameraDevice?.maxZoom ?? 1;
  const [requestedZoom, setRequestedZoom] = useState(1);
  const zoomFactor = clampNumber(requestedZoom, minimumZoom, maximumZoom);

  const supportsExposureBias = cameraDevice?.supportsExposureBias ?? false;
  const minimumExposureBias = cameraDevice?.minExposureBias ?? 0;
  const maximumExposureBias = cameraDevice?.maxExposureBias ?? 0;
  // En Android la compensación va en pasos enteros de tamaño desconocido; en iOS, en EV.
  const exposureScale = useMemo(
    () => createExposureScale(minimumExposureBias, maximumExposureBias, Platform.OS === 'android'),
    [minimumExposureBias, maximumExposureBias],
  );
  const [requestedExposureBias, setRequestedExposureBias] = useState<number | null>(null);
  const exposureBias = supportsExposureBias
    ? clampNumber(requestedExposureBias ?? exposureScale.initialValue, minimumExposureBias, maximumExposureBias)
    : undefined;

  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [stackingOutcome, setStackingOutcome] = useState<StackingOutcome | null>(null);
  const [sharpeningLevelIndex, setSharpeningLevelIndex] = useState(defaultSharpeningLevelIndex);
  const [countdownSecondsLeft, setCountdownSecondsLeft] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    if (!canMeter || !cameraDevice) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
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
    }
  }

  async function handleCapture() {
    if (!liveDetection) return;
    const moonDiameterPixels = Math.round(liveDetection.radiusPixels * 2);
    const cropSize = chooseCropSize(liveDetection.radiusPixels);
    const captureZoomFactor = zoomFactor;
    const captureExposureBias = exposureBias;
    setStackingOutcome(null);
    setStatusMessage(null);
    for (let secondsLeft = captureCountdownSeconds; secondsLeft > 0; secondsLeft--) {
      setCountdownSecondsLeft(secondsLeft);
      await waitMilliseconds(1000);
    }
    setCountdownSecondsLeft(null);
    const { crops: capturedCrops, rejectedCropCount: rejectedFrameCount } = await captureCrops(
      capturedFrameTarget,
      cropSize,
    );
    if (capturedCrops.length === 0) {
      setStatusMessage(t(rejectedFrameCount > 0 ? 'tooMuchMovement' : 'moonLostDuringCapture'));
      return;
    }
    setIsProcessing(true);
    // Deja que se pinte el indicador antes del cálculo, que ocupa el hilo JS un par de segundos.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const stackingResult = stackSharpestCrops(capturedCrops, cropSize, keptFrameFraction, 0);
      const bestSingleSkiaImage = createSkiaImage(stackingResult.bestSingleImage);
      if (!bestSingleSkiaImage) throw new Error('Skia no pudo crear la imagen');
      setStackingOutcome({
        stackedBaseImage: stackingResult.stackedImage,
        sharpeningSigma: sharpeningSigmaForCropSize(cropSize),
        bestSingleSkiaImage,
        capturedFrameCount: capturedCrops.length,
        rejectedFrameCount,
        stackedFrameCount: stackingResult.usedCropCount,
        moonDiameterPixels,
        zoomFactor: captureZoomFactor,
        ...(captureExposureBias !== undefined ? { exposureBias: captureExposureBias } : {}),
      });
    } catch (processingError) {
      setStatusMessage(t('core:common.error', { message: String(processingError) }));
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleSave() {
    if (!stackingOutcome || !stackedSkiaImage) return;
    setIsSaving(true);
    setStatusMessage(null);
    const roundTo = (numericValue: number, fractionDigits: number) =>
      Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    const horizontalPosition = moonReport.horizontalPosition;
    try {
      const pngFile = writeImageToCachePng(stackedSkiaImage);
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
          ...(stackingOutcome.exposureBias === undefined
            ? {}
            : exposureScale.isStepIndex
              ? { exposureCompensationSteps: stackingOutcome.exposureBias }
              : { exposureBias: stackingOutcome.exposureBias }),
          sharpeningAmount: sharpeningLevels[sharpeningLevelIndex]?.amount ?? 0,
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

  const moonDiameterPixels = liveDetection ? Math.round(liveDetection.radiusPixels * 2) : 0;
  const isExposureAtMinimum = exposureBias === undefined || exposureBias <= minimumExposureBias;
  const exposureHint = !liveDetection
    ? null
    : liveDetection.saturatedFraction > overexposedSaturatedFraction
      ? t(isExposureAtMinimum ? 'overexposedAtMinimumHint' : 'overexposedHint')
      : liveDetection.peakBrightness < underexposedPeakBrightness
        ? t('underexposedHint')
        : null;

  return (
    <ScreenContainer>
      <MoonInfoCard
        moonReport={moonReport}
        hasObserverLocation={observerLocation !== null}
        isLocating={isLocating}
        canAskForLocation={canAskForLocation}
        onRequestLocation={() => void requestLocation()}
      />

      <View style={[styles.previewContainer, { borderColor: themePalette.border }]}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={cameraDevice ?? 'back'}
          isActive={isCameraAllowed}
          outputs={[frameOutput]}
          zoom={zoomFactor}
          exposure={exposureBias}
          onError={handleCameraError}
          resizeMode="contain"
        />
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
      </View>
      {pointingGuidance ? <BodyText tone="secondary">{t('compassCalibrationHint')}</BodyText> : null}
      {!moonReport.horizontalPosition && hasOrientationSensors ? (
        <BodyText tone="secondary">{t('guideNeedsLocation')}</BodyText>
      ) : null}

      <BodyText tone={liveDetection ? 'primary' : 'secondary'}>
        {liveDetection ? t('moonDetected', { diameter: moonDiameterPixels }) : t('moonNotDetected')}
      </BodyText>
      {exposureHint ? <BodyText tone="danger">{exposureHint}</BodyText> : null}
      {liveDetection && hasGyroscope && !isCapturing ? (
        <BodyText tone={isSteadyForDisplay ? 'secondary' : 'danger'}>
          {t(isSteadyForDisplay ? 'deviceSteady' : 'deviceMoving')}
        </BodyText>
      ) : null}
      {liveDetection && moonDiameterPixels < recommendedMoonDiameterPixels ? (
        <BodyText tone="secondary">{t('moonTooSmallHint')}</BodyText>
      ) : null}

      <StepperRow
        label={t('zoomLabel', { zoom: zoomFactor.toFixed(1) })}
        onDecrease={() => setRequestedZoom(Math.max(minimumZoom, zoomFactor / zoomStepFactor))}
        onIncrease={() => setRequestedZoom(Math.min(maximumZoom, zoomFactor * zoomStepFactor))}
        isDecreaseDisabled={zoomFactor <= minimumZoom}
        isIncreaseDisabled={zoomFactor >= maximumZoom}
        decreaseLabel={t('zoomOut')}
        increaseLabel={t('zoomIn')}
      />
      {exposureBias !== undefined ? (
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
          isDecreaseDisabled={exposureBias <= minimumExposureBias}
          isIncreaseDisabled={exposureBias >= maximumExposureBias}
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

      {isCapturing ? (
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <BodyText>
              {t('capturingProgress', {
                captured: captureProgress?.capturedCropCount ?? 0,
                target: captureProgress?.targetCropCount ?? capturedFrameTarget,
                rejected: captureProgress?.rejectedCropCount ?? 0,
              })}
            </BodyText>
          </View>
          <View style={styles.buttonCell}>
            <AppButton label={t('stopCapture')} onPress={stopCapture} variant="secondary" />
          </View>
        </View>
      ) : (
        <AppButton
          label={
            countdownSecondsLeft !== null
              ? t('captureCountdown', { seconds: countdownSecondsLeft })
              : t('captureAndStack', { count: capturedFrameTarget })
          }
          onPress={() => void handleCapture()}
          isBusy={isProcessing}
          isDisabled={!liveDetection || isProcessing || countdownSecondsLeft !== null}
        />
      )}

      {stackingOutcome && stackedSkiaImage ? (
        <Card>
          <SectionTitle>{t('resultTitle')}</SectionTitle>
          <View style={styles.resultRow}>
            <ResultImage label={t('bestSingleFrame')} skiaImage={stackingOutcome.bestSingleSkiaImage} />
            <ResultImage
              label={t('stackedFrames', { count: stackingOutcome.stackedFrameCount })}
              skiaImage={stackedSkiaImage}
            />
          </View>
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
            })}
          </BodyText>
          {stackingOutcome.rejectedFrameCount > 0 ? (
            <BodyText tone="secondary">
              {t('rejectedFramesExplanation', { count: stackingOutcome.rejectedFrameCount })}
            </BodyText>
          ) : null}
          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
        </Card>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <Card>
        <SectionTitle>{t('tipsTitle')}</SectionTitle>
        <BodyText tone="secondary">{t('tips')}</BodyText>
      </Card>
    </ScreenContainer>
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
