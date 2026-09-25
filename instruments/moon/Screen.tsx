import { Canvas, Image as SkiaImageView, type SkImage } from '@shopify/react-native-skia';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { PointingGuidance } from '@/processing/astronomy/pointingGuide';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { chooseCropSize, stackSharpestCrops } from '@/processing/image/lunarStacking';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { moonInstrumentId } from './instrumentId';
import { MoonInfoCard, useMoonReport, useObserverLocation } from './MoonInfoCard';
import type { MoonMeasurementValues } from './schema';
import { createSkiaImage, writeImageToCachePng } from './stackedImage';
import { useMoonFrames } from './useMoonFrames';
import { useMoonPointingGuide } from './useMoonPointingGuide';

const previewHeight = 340;
/** Fotogramas que se capturan en cada toma (~1-3 s según el móvil). */
const capturedFrameTarget = 30;
/** Fracción más nítida que se apila; el resto se descarta por la turbulencia. */
const keptFrameFraction = 0.5;
const sharpeningAmount = 1.2;
/** La Luna suele quemarse: se empieza con la exposición bajada (sin pasar del mínimo del móvil). */
const initialExposureBias = -2;
const exposureBiasStep = 0.5;
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
  stackedSkiaImage: SkImage;
  bestSingleSkiaImage: SkImage;
  capturedFrameCount: number;
  stackedFrameCount: number;
  moonDiameterPixels: number;
  zoomFactor: number;
  exposureBias?: number;
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
  const { frameOutput, liveDetection, isCapturing, captureProgress, captureCrops, stopCapture } = useMoonFrames();
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
  const [requestedExposureBias, setRequestedExposureBias] = useState(initialExposureBias);
  const exposureBias = supportsExposureBias
    ? clampNumber(requestedExposureBias, minimumExposureBias, maximumExposureBias)
    : undefined;

  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [stackingOutcome, setStackingOutcome] = useState<StackingOutcome | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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
    const capturedCrops = await captureCrops(capturedFrameTarget, cropSize);
    if (capturedCrops.length === 0) {
      setStatusMessage(t('moonLostDuringCapture'));
      return;
    }
    setIsProcessing(true);
    // Deja que se pinte el indicador antes del cálculo, que ocupa el hilo JS un par de segundos.
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const stackingResult = stackSharpestCrops(capturedCrops, cropSize, keptFrameFraction, sharpeningAmount);
      const stackedSkiaImage = createSkiaImage(stackingResult.stackedImage);
      const bestSingleSkiaImage = createSkiaImage(stackingResult.bestSingleImage);
      if (!stackedSkiaImage || !bestSingleSkiaImage) throw new Error('Skia no pudo crear la imagen');
      setStackingOutcome({
        stackedSkiaImage,
        bestSingleSkiaImage,
        capturedFrameCount: capturedCrops.length,
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
    if (!stackingOutcome) return;
    setIsSaving(true);
    setStatusMessage(null);
    const roundTo = (numericValue: number, fractionDigits: number) =>
      Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    const horizontalPosition = moonReport.horizontalPosition;
    try {
      const pngFile = writeImageToCachePng(stackingOutcome.stackedSkiaImage);
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
          ...(stackingOutcome.exposureBias !== undefined ? { exposureBias: stackingOutcome.exposureBias } : {}),
        },
        attachments: [
          {
            kind: 'photo',
            sourceUri: pngFile.uri,
            fileName: 'luna.png',
            mimeType: 'image/png',
            metadata: {
              widthPixels: stackingOutcome.stackedSkiaImage.width(),
              heightPixels: stackingOutcome.stackedSkiaImage.height(),
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
  const exposureHint = !liveDetection
    ? null
    : liveDetection.saturatedFraction > overexposedSaturatedFraction
      ? t('overexposedHint')
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
          label={t('exposureLabel', { exposure: `${exposureBias > 0 ? '+' : ''}${exposureBias.toFixed(1)}` })}
          onDecrease={() => setRequestedExposureBias(Math.max(minimumExposureBias, exposureBias - exposureBiasStep))}
          onIncrease={() => setRequestedExposureBias(Math.min(maximumExposureBias, exposureBias + exposureBiasStep))}
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
              })}
            </BodyText>
          </View>
          <View style={styles.buttonCell}>
            <AppButton label={t('stopCapture')} onPress={stopCapture} variant="secondary" />
          </View>
        </View>
      ) : (
        <AppButton
          label={t('captureAndStack', { count: capturedFrameTarget })}
          onPress={() => void handleCapture()}
          isBusy={isProcessing}
          isDisabled={!liveDetection || isProcessing}
        />
      )}

      {stackingOutcome ? (
        <Card>
          <SectionTitle>{t('resultTitle')}</SectionTitle>
          <View style={styles.resultRow}>
            <ResultImage label={t('bestSingleFrame')} skiaImage={stackingOutcome.bestSingleSkiaImage} />
            <ResultImage
              label={t('stackedFrames', { count: stackingOutcome.stackedFrameCount })}
              skiaImage={stackingOutcome.stackedSkiaImage}
            />
          </View>
          <BodyText tone="secondary">
            {t('stackingExplanation', {
              captured: stackingOutcome.capturedFrameCount,
              stacked: stackingOutcome.stackedFrameCount,
            })}
          </BodyText>
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
  resultRow: { flexDirection: 'row', gap: 8 },
  resultColumn: { flex: 1, alignItems: 'center', gap: 4 },
  resultImageFrame: { width: '100%', aspectRatio: 1, backgroundColor: '#000000', borderRadius: 8, overflow: 'hidden' },
});
