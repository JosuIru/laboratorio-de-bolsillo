import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, type MeteringMode, useCameraDevice } from 'react-native-vision-camera';

import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import { useDeviceSteadiness } from '@/core/camera/useDeviceSteadiness';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import {
  convertFrequencyToDisplayUnit,
  type FrequencyDisplayUnit,
  type MagnificationBandId,
  magnificationBandPresets,
  vibrationCutoffChoicesHz,
} from '@/processing/eulerian/bands';
import type { DominantFrequencyEstimate } from '@/processing/eulerian/dominantFrequency';
import {
  centralRegionFraction,
  createMagnificationEngine,
  type MagnificationEngine,
  type MagnificationStatus,
} from '@/processing/eulerian/magnificationEngine';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { createDisplayedImageStore, MagnifiedView } from './MagnifiedView';
import type { MotionMagnifierMeasurementValues } from './schema';
import { type DeliveredGridFrame, useMagnifierFrames } from './useMagnifierFrames';

export const motionMagnifierInstrumentId = 'motion-magnifier';

const previewHeight = 380;
const meteringMarkerRadius = 28;
/** Cadencia pedida a la cámara: de sobra para pulso y respiración; limita la vibración a ~13 Hz. */
const requestedFramesPerSecond = 30;
const cameraConstraints = [{ fps: requestedFramesPerSecond }];
/** Cada cuánto se recalcula la frecuencia dominante en el modo de medida. */
const measurementUpdateMilliseconds = 1000;
/** Cada cuánto se actualiza el estado (cadencia, avisos) en pantalla. */
const statusUpdateMilliseconds = 1000;
/** Umbrales de calidad del pico (potencia del pico / mediana de la banda). */
const clearPeakRatio = 8;
const acceptablePeakRatio = 4;

type ViewMode = 'amplified' | 'overlay' | 'camera';
type ScreenMode = 'view' | 'measure';
type CameraPosition = 'back' | 'front';

interface EngineStatusForDisplay {
  status: MagnificationStatus;
  framesPerSecond: number | null;
  effectiveHighCutoffHz: number | null;
}

const bandIds: readonly MagnificationBandId[] = ['pulse', 'breathing', 'vibration'];

function formatRate(rateValue: number, displayUnit: FrequencyDisplayUnit): string {
  if (displayUnit === 'beatsPerMinute') return rateValue.toFixed(0);
  if (displayUnit === 'breathsPerMinute') return rateValue.toFixed(1);
  return rateValue.toFixed(2);
}

function formatHertz(frequencyHz: number): string {
  return Number.isInteger(frequencyHz) ? String(frequencyHz) : frequencyHz.toFixed(1);
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

export function MotionMagnifierScreen({
  saveMeasurement,
  sensorAvailability,
}: InstrumentScreenProps<MotionMagnifierMeasurementValues>) {
  const { t } = useTranslation(motionMagnifierInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const [cameraPosition, setCameraPosition] = useState<CameraPosition>('back');
  const cameraDevice = useCameraDevice(cameraPosition);
  const isCameraAllowed = useIsCameraAllowed();
  const hasGyroscope = sensorAvailability.gyroscope.status === 'available';
  const { isDeviceSteady, isSteadyForDisplay } = useDeviceSteadiness(isCameraAllowed, hasGyroscope);

  const [bandId, setBandId] = useState<MagnificationBandId>('pulse');
  const [vibrationLowCutoffHz, setVibrationLowCutoffHz] = useState(
    magnificationBandPresets.vibration.defaultLowCutoffHz,
  );
  const [vibrationHighCutoffHz, setVibrationHighCutoffHz] = useState(
    magnificationBandPresets.vibration.defaultHighCutoffHz,
  );
  const [amplificationByBand, setAmplificationByBand] = useState<Record<MagnificationBandId, number>>({
    pulse: magnificationBandPresets.pulse.defaultAmplification,
    breathing: magnificationBandPresets.breathing.defaultAmplification,
    vibration: magnificationBandPresets.vibration.defaultAmplification,
  });
  const [viewMode, setViewMode] = useState<ViewMode>('amplified');
  const [screenMode, setScreenMode] = useState<ScreenMode>('view');
  // La ventana de medida dura hasta 30 s: si la pantalla se apagara, la cámara se cerraría.
  useKeepScreenOnWhile(screenMode === 'measure', 'motion-magnifier');
  const [previewWidth, setPreviewWidth] = useState(0);
  const [frameDimensions, setFrameDimensions] = useState<{ frameWidth: number; frameHeight: number } | null>(null);
  const [engineStatusState, setEngineStatusState] = useState<{
    sourceEngine: MagnificationEngine;
    status: EngineStatusForDisplay;
  } | null>(null);
  const [estimateState, setEstimateState] = useState<{
    sourceEngine: MagnificationEngine;
    estimate: DominantFrequencyEstimate | null;
  } | null>(null);
  const [estimateRevision, setEstimateRevision] = useState(0);
  const [measurementProgress, setMeasurementProgress] = useState({ storedSeconds: 0, windowSeconds: 1 });
  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const bandPreset = magnificationBandPresets[bandId];
  const lowCutoffHz = bandId === 'vibration' ? vibrationLowCutoffHz : bandPreset.defaultLowCutoffHz;
  const highCutoffHz = bandId === 'vibration' ? vibrationHighCutoffHz : bandPreset.defaultHighCutoffHz;
  const amplificationFactor = amplificationByBand[bandId];

  // Un motor nuevo (historia y filtros vacíos) al cambiar de banda o de cámara.
  const magnificationEngine = useMemo(
    () =>
      createMagnificationEngine({
        lowCutoffHz,
        highCutoffHz,
        amplifiedSignal: bandPreset.amplifiedSignal,
        amplificationFactor: bandPreset.defaultAmplification,
        maximumAddedLevels: bandPreset.maximumAddedLevels,
        measurementWindowSeconds: bandPreset.measurementWindowSeconds,
        pixelCombination: bandPreset.pixelCombination,
      }),
    // La cámara no entra en la configuración, pero cambiarla invalida toda la historia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bandPreset, lowCutoffHz, highCutoffHz, cameraPosition],
  );
  useEffect(() => {
    magnificationEngine.setAmplificationFactor(amplificationFactor);
  }, [magnificationEngine, amplificationFactor]);
  // El estado y la medida mostrados solo valen para el motor que los produjo.
  const engineStatus = engineStatusState?.sourceEngine === magnificationEngine ? engineStatusState.status : null;
  const latestEstimate = estimateState?.sourceEngine === magnificationEngine ? estimateState.estimate : null;

  const [imageStore] = useState(createDisplayedImageStore);
  const viewModeRef = useRef<ViewMode>(viewMode);
  const screenModeRef = useRef<ScreenMode>(screenMode);
  useEffect(() => {
    screenModeRef.current = screenMode;
  }, [screenMode]);
  useEffect(() => {
    viewModeRef.current = viewMode;
    if (viewMode === 'camera') imageStore.publish(null);
  }, [viewMode, imageStore]);
  const lastStatusUpdateTime = useRef(0);

  const handleGridFrame = useCallback(
    (gridFrame: DeliveredGridFrame) => {
      const currentViewMode = viewModeRef.current;
      // Si el móvil se mueve, la ventana de medida queda contaminada: se empieza de nuevo.
      if (screenModeRef.current === 'measure' && !isDeviceSteady()) {
        magnificationEngine.restartMeasurementWindow();
      }
      const processedFrame = magnificationEngine.processFrame(gridFrame, {
        wantsAmplifiedImage: currentViewMode === 'amplified',
        wantsOverlay: currentViewMode === 'overlay',
      });
      if (currentViewMode === 'amplified' && processedFrame.amplifiedRgba) {
        imageStore.publish({
          rgba: processedFrame.amplifiedRgba,
          width: gridFrame.baseWidth,
          height: gridFrame.baseHeight,
          isOpaque: true,
        });
      } else if (currentViewMode === 'overlay') {
        imageStore.publish(
          processedFrame.overlayRgba
            ? {
                rgba: processedFrame.overlayRgba,
                width: gridFrame.levelWidth,
                height: gridFrame.levelHeight,
                isOpaque: false,
              }
            : null,
        );
      }

      const currentTime = Date.now();
      if (currentTime - lastStatusUpdateTime.current < statusUpdateMilliseconds) return;
      lastStatusUpdateTime.current = currentTime;
      setEngineStatusState({
        sourceEngine: magnificationEngine,
        status: {
          status: processedFrame.status,
          framesPerSecond: processedFrame.framesPerSecond,
          effectiveHighCutoffHz: processedFrame.effectiveHighCutoffHz,
        },
      });
      setFrameDimensions((previousDimensions) =>
        previousDimensions?.frameWidth === gridFrame.frameWidth && previousDimensions.frameHeight === gridFrame.frameHeight
          ? previousDimensions
          : { frameWidth: gridFrame.frameWidth, frameHeight: gridFrame.frameHeight },
      );
    },
    [magnificationEngine, imageStore, isDeviceSteady],
  );

  const frameOutput = useMagnifierFrames(bandPreset.pyramidReductionCount, bandPreset.amplifiedSignal, handleGridFrame);

  useEffect(() => {
    if (screenMode !== 'measure') return;
    const measurementTimer = setInterval(() => {
      setEstimateState({ sourceEngine: magnificationEngine, estimate: magnificationEngine.estimateFrequency() });
      setMeasurementProgress(magnificationEngine.measurementProgress());
      setEstimateRevision((previousRevision) => previousRevision + 1);
    }, measurementUpdateMilliseconds);
    return () => clearInterval(measurementTimer);
  }, [screenMode, magnificationEngine]);

  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    if (!canMeter || !cameraDevice) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    setMeteringViewPoint(viewPoint);
    try {
      // Exposición fija: si la cámara la reajusta, el cambio de brillo se amplificaría también.
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

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  function handleCameraPositionChange(nextCameraPosition: CameraPosition) {
    setMeteringViewPoint(null);
    setCameraPosition(nextCameraPosition);
  }

  function changeVibrationCutoff(which: 'low' | 'high', direction: 1 | -1) {
    const currentValue = which === 'low' ? vibrationLowCutoffHz : vibrationHighCutoffHz;
    const currentIndex = vibrationCutoffChoicesHz.indexOf(currentValue);
    const nextValue = vibrationCutoffChoicesHz[currentIndex + direction];
    if (nextValue === undefined) return;
    if (which === 'low' && nextValue < vibrationHighCutoffHz) setVibrationLowCutoffHz(nextValue);
    if (which === 'high' && nextValue > vibrationLowCutoffHz) setVibrationHighCutoffHz(nextValue);
  }

  const estimatedRate = latestEstimate
    ? convertFrequencyToDisplayUnit(latestEstimate.frequencyHz, bandPreset.displayUnit)
    : null;
  const peakQuality = latestEstimate
    ? latestEstimate.peakToMedianPowerRatio >= clearPeakRatio
      ? 'clear'
      : latestEstimate.peakToMedianPowerRatio >= acceptablePeakRatio
        ? 'fair'
        : 'weak'
    : null;

  async function handleSave() {
    if (!latestEstimate || estimatedRate === null || !isDeviceSteady()) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          band: bandId,
          dominantFrequencyHz: Math.round(latestEstimate.frequencyHz * 1000) / 1000,
          displayedRate: Number(formatRate(estimatedRate, bandPreset.displayUnit)),
          displayedUnit: t(`units.${bandPreset.displayUnit}`),
          peakToMedianPowerRatio: Math.round(Math.min(999, latestEstimate.peakToMedianPowerRatio) * 10) / 10,
          analysisWindowSeconds: Math.round(latestEstimate.durationSeconds * 10) / 10,
          framesPerSecond: Math.round(latestEstimate.sampleRateHz * 10) / 10,
          lowCutoffHz,
          highCutoffHz: engineStatus?.effectiveHighCutoffHz ?? highCutoffHz,
          amplificationFactor,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  // Rectángulo que ocupa el fotograma en la vista previa (`contain`) y, dentro, la región central.
  const frameRectangle = useMemo(() => {
    if (!frameDimensions || previewWidth <= 0) return null;
    const displayScale = Math.min(
      previewWidth / frameDimensions.frameWidth,
      previewHeight / frameDimensions.frameHeight,
    );
    const displayedWidth = frameDimensions.frameWidth * displayScale;
    const displayedHeight = frameDimensions.frameHeight * displayScale;
    return {
      left: (previewWidth - displayedWidth) / 2,
      top: (previewHeight - displayedHeight) / 2,
      width: displayedWidth,
      height: displayedHeight,
    };
  }, [frameDimensions, previewWidth]);

  const frameRateText = engineStatus?.framesPerSecond
    ? t('frameRate', { framesPerSecond: engineStatus.framesPerSecond.toFixed(0) })
    : null;
  const isHighCutoffLimited =
    engineStatus?.effectiveHighCutoffHz != null && engineStatus.effectiveHighCutoffHz < highCutoffHz - 0.01;

  return (
    <ScreenContainer>
      <Card>
        <BodyText style={styles.disclaimerText}>{t('notMedical')}</BodyText>
      </Card>
      <BodyText tone="secondary">{t('intro')}</BodyText>

      <SectionTitle>{t('bandTitle')}</SectionTitle>
      <ChoiceChips<MagnificationBandId>
        options={bandIds}
        selectedOption={bandId}
        labelFor={(optionBandId) => t(`bands.${optionBandId}.label`)}
        onSelect={setBandId}
      />
      <BodyText tone="secondary">{t(`bands.${bandId}.hint`)}</BodyText>
      {bandId === 'vibration' ? (
        <>
          <StepperRow
            label={t('lowCutoff', { frequency: formatHertz(vibrationLowCutoffHz) })}
            decreaseLabel="−"
            increaseLabel="+"
            onDecrease={() => changeVibrationCutoff('low', -1)}
            onIncrease={() => changeVibrationCutoff('low', 1)}
            isDecreaseDisabled={vibrationLowCutoffHz <= (vibrationCutoffChoicesHz[0] ?? 0)}
            isIncreaseDisabled={
              (vibrationCutoffChoicesHz[vibrationCutoffChoicesHz.indexOf(vibrationLowCutoffHz) + 1] ?? Infinity) >=
              vibrationHighCutoffHz
            }
          />
          <StepperRow
            label={t('highCutoff', { frequency: formatHertz(vibrationHighCutoffHz) })}
            decreaseLabel="−"
            increaseLabel="+"
            onDecrease={() => changeVibrationCutoff('high', -1)}
            onIncrease={() => changeVibrationCutoff('high', 1)}
            isDecreaseDisabled={
              (vibrationCutoffChoicesHz[vibrationCutoffChoicesHz.indexOf(vibrationHighCutoffHz) - 1] ?? -Infinity) <=
              vibrationLowCutoffHz
            }
            isIncreaseDisabled={
              vibrationHighCutoffHz >= (vibrationCutoffChoicesHz[vibrationCutoffChoicesHz.length - 1] ?? Infinity)
            }
          />
          <BodyText tone="secondary">{t('vibrationLimits')}</BodyText>
        </>
      ) : null}

      <View
        style={[styles.previewContainer, { borderColor: themePalette.border }]}
        onLayout={(layoutEvent: LayoutChangeEvent) => setPreviewWidth(layoutEvent.nativeEvent.layout.width)}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={cameraDevice ?? cameraPosition}
          isActive={isCameraAllowed}
          outputs={[frameOutput]}
          constraints={cameraConstraints}
          onError={handleCameraError}
          resizeMode="contain"
        />
        {viewMode !== 'camera' ? (
          <MagnifiedView imageStore={imageStore} viewWidth={previewWidth} viewHeight={previewHeight} />
        ) : null}
        {screenMode === 'measure' && frameRectangle ? (
          <View
            pointerEvents="none"
            style={[
              styles.measurementRegion,
              {
                left: frameRectangle.left + (frameRectangle.width * (1 - centralRegionFraction)) / 2,
                top: frameRectangle.top + (frameRectangle.height * (1 - centralRegionFraction)) / 2,
                width: frameRectangle.width * centralRegionFraction,
                height: frameRectangle.height * centralRegionFraction,
              },
            ]}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tapToLockHint')}
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

      {hasGyroscope && !isSteadyForDisplay ? <BodyText tone="danger">{t('deviceMoving')}</BodyText> : null}
      {engineStatus?.status === 'estimatingFrameRate' || !engineStatus ? (
        <BodyText tone="secondary">{t('startingUp')}</BodyText>
      ) : null}
      {engineStatus?.status === 'bandAboveFrameRate' ? (
        <BodyText tone="danger">{t('bandAboveFrameRate', { framesPerSecond: engineStatus.framesPerSecond?.toFixed(0) ?? '?' })}</BodyText>
      ) : null}
      {isHighCutoffLimited && engineStatus?.effectiveHighCutoffHz ? (
        <BodyText tone="secondary">
          {t('highCutoffLimited', { frequency: engineStatus.effectiveHighCutoffHz.toFixed(1) })}
        </BodyText>
      ) : null}
      {meteringViewPoint ? (
        <View style={styles.buttonRow}>
          <BodyText style={styles.flexText}>{t('exposureLocked')}</BodyText>
          <View style={styles.unlockButton}>
            <AppButton label={t('unlockExposure')} onPress={() => void handleUnlockMetering()} variant="secondary" />
          </View>
        </View>
      ) : (
        <BodyText tone="secondary">{t('tapToLockHint')}</BodyText>
      )}

      <SectionTitle>{t('displayTitle')}</SectionTitle>
      <ChoiceChips<ViewMode>
        options={['amplified', 'overlay', 'camera']}
        selectedOption={viewMode}
        labelFor={(optionViewMode) => t(`viewModes.${optionViewMode}`)}
        onSelect={setViewMode}
      />
      <BodyText tone="secondary">{t(`viewModeHints.${viewMode}`)}</BodyText>
      <BodyText tone="secondary">{t('amplificationTitle')}</BodyText>
      <ChoiceChips<number>
        options={bandPreset.amplificationChoices}
        selectedOption={amplificationFactor}
        labelFor={(amplificationChoice) => `×${amplificationChoice}`}
        onSelect={(amplificationChoice) =>
          setAmplificationByBand((previousAmplifications) => ({ ...previousAmplifications, [bandId]: amplificationChoice }))
        }
      />
      <BodyText tone="secondary">{t('cameraTitle')}</BodyText>
      <ChoiceChips<CameraPosition>
        options={['back', 'front']}
        selectedOption={cameraPosition}
        labelFor={(optionCameraPosition) => t(`cameras.${optionCameraPosition}`)}
        onSelect={handleCameraPositionChange}
      />
      {frameRateText ? <BodyText tone="secondary">{frameRateText}</BodyText> : null}

      <SectionTitle>{t('measureTitle')}</SectionTitle>
      <ChoiceChips<ScreenMode>
        options={['view', 'measure']}
        selectedOption={screenMode}
        labelFor={(optionScreenMode) => t(`screenModes.${optionScreenMode}`)}
        onSelect={setScreenMode}
      />
      {screenMode === 'measure' ? (
        <>
          <BodyText tone="secondary">{t(`measureHints.${bandId}`)}</BodyText>
          {!isSteadyForDisplay ? <BodyText tone="danger">{t('measurementRestartedByMovement')}</BodyText> : null}
          <Card style={styles.centeredCard}>
            <BodyText tone="secondary">{t(`measuredQuantity.${bandId}`)}</BodyText>
            <BodyText style={styles.rateValue}>
              {estimatedRate !== null ? formatRate(estimatedRate, bandPreset.displayUnit) : '—'}
            </BodyText>
            <BodyText tone="secondary">{t(`units.${bandPreset.displayUnit}`)}</BodyText>
            {latestEstimate && peakQuality ? (
              <BodyText tone={peakQuality === 'weak' ? 'danger' : 'secondary'}>
                {t(`peakQuality.${peakQuality}`, { ratio: latestEstimate.peakToMedianPowerRatio.toFixed(1) })}
              </BodyText>
            ) : (
              <BodyText tone="secondary">
                {t('collecting', {
                  stored: measurementProgress.storedSeconds.toFixed(0),
                  window: measurementProgress.windowSeconds.toFixed(0),
                })}
              </BodyText>
            )}
          </Card>
          {latestEstimate && latestEstimate.bandMagnitudes.length > 1 ? (
            <>
              <BodyText tone="secondary">{t('spectrumTitle')}</BodyText>
              <SignalChart
                series={[{ values: latestEstimate.bandMagnitudes, color: themePalette.accent }]}
                height={120}
                verticalRange={{ mode: 'from-zero', minimumMaximum: 1e-6 }}
                revision={estimateRevision}
                horizontalLabels={[
                  `${formatRate(convertFrequencyToDisplayUnit(latestEstimate.bandFrequenciesHz[0] ?? 0, bandPreset.displayUnit), bandPreset.displayUnit)} ${t(`units.${bandPreset.displayUnit}`)}`,
                  `${formatRate(convertFrequencyToDisplayUnit(latestEstimate.bandFrequenciesHz[latestEstimate.bandFrequenciesHz.length - 1] ?? 0, bandPreset.displayUnit), bandPreset.displayUnit)} ${t(`units.${bandPreset.displayUnit}`)}`,
                ]}
                accessibilityLabel={t('spectrumTitle')}
              />
            </>
          ) : null}
          <AppButton
            label={t('core:common.save')}
            onPress={() => void handleSave()}
            isBusy={isSaving}
            isDisabled={!latestEstimate || !isSteadyForDisplay}
          />
        </>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <SectionTitle>{t('tipsTitle')}</SectionTitle>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('tips')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('howItWorks')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('limits')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  disclaimerText: { fontWeight: '600' },
  previewContainer: {
    height: previewHeight,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  measurementRegion: { position: 'absolute', borderWidth: 2, borderColor: '#FACC15', borderRadius: 4 },
  meteringMarker: {
    position: 'absolute',
    width: meteringMarkerRadius * 2,
    height: meteringMarkerRadius * 2,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#4ADE80',
  },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 64 },
  stepperLabel: { flex: 1, textAlign: 'center', fontWeight: '600', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexText: { flex: 1 },
  unlockButton: { width: 110 },
  centeredCard: { alignItems: 'center', paddingVertical: 16, gap: 4 },
  rateValue: { fontSize: 48, lineHeight: 56, fontWeight: '700', fontVariant: ['tabular-nums'] },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  smallText: { fontSize: 13 },
});
