import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  createMagnificationEngine,
  type MagnificationEngine,
  type MagnificationStatus,
} from '@/processing/eulerian/magnificationEngine';
import {
  centeredMeasurementRegion,
  containFrameInView,
  type MeasurementRegion,
  placeMeasurementRegion,
  regionToViewRectangle,
  viewPointToFrameFractions,
} from '@/processing/eulerian/measurementRegion';
import { panelHandleHeight, panelPrimaryActionsHeight } from '@/ui/cameraPanelLayout';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';
import { CameraOverlayButton, CameraOverlayText, CameraScreenLayout, type CameraPreviewLayout } from '@/ui/FullScreenCamera';
import { useThemePalette } from '@/ui/theme';

import { createDisplayedImageStore, MagnifiedView } from './MagnifiedView';
import { ComparisonCurtain, HeatMapLegend, PhaseMapLegend, shiftCurtainFraction } from './MapOverlays';
import { PulseMonitor } from './PulseMonitor';
import type { MotionMagnifierMeasurementValues } from './schema';
import { createSignalTraceStore } from './signalTraceStore';
import { type DeliveredGridFrame, useMagnifierFrames } from './useMagnifierFrames';

export const motionMagnifierInstrumentId = 'motion-magnifier';

const normalPreviewHeight = 380;
/** Cadencia pedida a la cámara: de sobra para pulso y respiración; limita la vibración a ~13 Hz. */
const requestedFramesPerSecond = 30;
const cameraConstraints = [{ fps: requestedFramesPerSecond }];
/** Cada cuánto se recalcula la frecuencia dominante (medida y referencia del mapa de fase). */
const measurementUpdateMilliseconds = 1000;
/** Cada cuánto se actualiza el estado (cadencia, avisos) en pantalla. */
const statusUpdateMilliseconds = 1000;
/** Umbrales de calidad del pico (potencia del pico / mediana de la banda). */
const clearPeakRatio = 8;
const acceptablePeakRatio = 4;
/** Segundos de señal en vivo en el monitor de pulso (a ~30 fotogramas/s). */
const pulseTraceCapacity = 180;
const measurementRegionColor = '#FACC15';

type ViewMode = 'amplified' | 'heatMap' | 'phaseMap' | 'camera';
type ScreenMode = 'view' | 'measure';
type CameraPosition = 'back' | 'front';

interface EngineStatusForDisplay {
  status: MagnificationStatus;
  framesPerSecond: number | null;
  effectiveHighCutoffHz: number | null;
  hasPhaseMap: boolean;
}

const bandIds: readonly MagnificationBandId[] = ['pulse', 'breathing', 'vibration'];
const viewModes: readonly ViewMode[] = ['amplified', 'heatMap', 'phaseMap', 'camera'];

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

/** Fila de modos de visualización del panel asomado: cuatro botones iguales que caben en un móvil. */
function ViewModeActions({
  selectedViewMode,
  labelFor,
  onSelect,
}: {
  selectedViewMode: ViewMode;
  labelFor(viewMode: ViewMode): string;
  onSelect(viewMode: ViewMode): void;
}) {
  const themePalette = useThemePalette();
  return (
    <>
      {viewModes.map((viewMode) => {
        const isSelected = viewMode === selectedViewMode;
        return (
          <Pressable
            key={viewMode}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(viewMode)}
            style={({ pressed }) => [
              styles.modeAction,
              {
                borderColor: isSelected ? themePalette.accent : themePalette.border,
                backgroundColor: isSelected ? `${themePalette.accent}22` : 'transparent',
                opacity: pressed ? 0.7 : 1,
              },
            ]}>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.75}
              style={[styles.modeActionLabel, { color: isSelected ? themePalette.accent : themePalette.textPrimary }]}>
              {labelFor(viewMode)}
            </Text>
          </Pressable>
        );
      })}
    </>
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
  const safeAreaInsets = useSafeAreaInsets();
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
  const [isCurtainVisible, setIsCurtainVisible] = useState(false);
  // Posición de la cortina y dónde empezó el arrastre en curso (fracciones del ancho).
  const [curtainPosition, setCurtainPosition] = useState({ currentFraction: 0.5, dragStartFraction: 0.5 });
  const curtainFraction = curtainPosition.currentFraction;
  const handleCurtainDragStart = useCallback(() => {
    setCurtainPosition((previousPosition) => ({ ...previousPosition, dragStartFraction: previousPosition.currentFraction }));
  }, []);
  const handleCurtainDragMove = useCallback((fractionShiftSinceStart: number) => {
    setCurtainPosition((previousPosition) => ({
      ...previousPosition,
      currentFraction: shiftCurtainFraction(previousPosition.dragStartFraction, fractionShiftSinceStart),
    }));
  }, []);
  const handleCurtainStep = useCallback((fractionShift: number) => {
    setCurtainPosition((previousPosition) => {
      const steppedFraction = shiftCurtainFraction(previousPosition.currentFraction, fractionShift);
      return { currentFraction: steppedFraction, dragStartFraction: steppedFraction };
    });
  }, []);
  const [measurementRegion, setMeasurementRegion] = useState<MeasurementRegion>(centeredMeasurementRegion);
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
  const [isMeteringLocked, setIsMeteringLocked] = useState(false);
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
  // La zona elegida vale para cualquier motor (va en fracciones del fotograma).
  useEffect(() => {
    magnificationEngine.setMeasurementRegionCenter(measurementRegion.centerXFraction, measurementRegion.centerYFraction);
  }, [magnificationEngine, measurementRegion]);
  // El estado y la medida mostrados solo valen para el motor que los produjo.
  const engineStatus = engineStatusState?.sourceEngine === magnificationEngine ? engineStatusState.status : null;
  const latestEstimate = estimateState?.sourceEngine === magnificationEngine ? estimateState.estimate : null;

  const [imageStore] = useState(createDisplayedImageStore);
  const [pulseTraceStore] = useState(() => createSignalTraceStore(pulseTraceCapacity));
  useEffect(() => {
    pulseTraceStore.clear();
  }, [magnificationEngine, measurementRegion, pulseTraceStore]);
  const viewModeRef = useRef<ViewMode>(viewMode);
  const screenModeRef = useRef<ScreenMode>(screenMode);
  useEffect(() => {
    screenModeRef.current = screenMode;
  }, [screenMode]);
  useEffect(() => {
    viewModeRef.current = viewMode;
    // Nada de la imagen del modo anterior hasta que llegue la del nuevo.
    imageStore.publish(null);
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
        wantsHeatMap: currentViewMode === 'heatMap',
        wantsPhaseMap: currentViewMode === 'phaseMap',
      });
      if (currentViewMode === 'amplified' && processedFrame.amplifiedRgba) {
        imageStore.publish({
          rgba: processedFrame.amplifiedRgba,
          width: gridFrame.baseWidth,
          height: gridFrame.baseHeight,
          isOpaque: true,
        });
      } else if (currentViewMode === 'heatMap' || currentViewMode === 'phaseMap') {
        const mapRgba = currentViewMode === 'heatMap' ? processedFrame.heatMapRgba : processedFrame.phaseMapRgba;
        imageStore.publish(
          mapRgba ? { rgba: mapRgba, width: gridFrame.levelWidth, height: gridFrame.levelHeight, isOpaque: false } : null,
        );
      }
      if (processedFrame.regionFilteredMean !== null) pulseTraceStore.push(processedFrame.regionFilteredMean);

      const currentTime = Date.now();
      if (currentTime - lastStatusUpdateTime.current < statusUpdateMilliseconds) return;
      lastStatusUpdateTime.current = currentTime;
      setEngineStatusState({
        sourceEngine: magnificationEngine,
        status: {
          status: processedFrame.status,
          framesPerSecond: processedFrame.framesPerSecond,
          effectiveHighCutoffHz: processedFrame.effectiveHighCutoffHz,
          hasPhaseMap: processedFrame.phaseMapRgba !== null,
        },
      });
      setFrameDimensions((previousDimensions) =>
        previousDimensions?.frameWidth === gridFrame.frameWidth && previousDimensions.frameHeight === gridFrame.frameHeight
          ? previousDimensions
          : { frameWidth: gridFrame.frameWidth, frameHeight: gridFrame.frameHeight },
      );
    },
    [magnificationEngine, imageStore, pulseTraceStore, isDeviceSteady],
  );

  const frameOutput = useMagnifierFrames(bandPreset.pyramidReductionCount, bandPreset.amplifiedSignal, handleGridFrame);

  // La frecuencia dominante hace falta para medir y como referencia del mapa de fase (lock-in).
  const needsFrequencyEstimate = screenMode === 'measure' || viewMode === 'phaseMap';
  useEffect(() => {
    if (!needsFrequencyEstimate) return;
    const measurementTimer = setInterval(() => {
      const estimate = magnificationEngine.estimateFrequency();
      // Sin medida nueva (p. ej. tras mover la zona) el lock-in sigue con la última frecuencia.
      if (estimate) magnificationEngine.setLockInFrequency(estimate.frequencyHz);
      setEstimateState({ sourceEngine: magnificationEngine, estimate });
      setMeasurementProgress(magnificationEngine.measurementProgress());
      setEstimateRevision((previousRevision) => previousRevision + 1);
    }, measurementUpdateMilliseconds);
    return () => clearInterval(measurementTimer);
  }, [needsFrequencyEstimate, magnificationEngine]);

  const canMeter = Boolean(cameraDevice?.supportsExposureMetering || cameraDevice?.supportsFocusMetering);

  /**
   * Un toque mueve la zona de medida a ese punto y fija allí la exposición y el enfoque: si la
   * cámara los reajustara, ese cambio de brillo también se amplificaría.
   */
  async function handlePreviewPress(pressEvent: GestureResponderEvent, previewLayout: CameraPreviewLayout) {
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    const frameRectangle = frameDimensions
      ? containFrameInView(
          previewLayout.previewWidth,
          previewLayout.previewHeight,
          frameDimensions.frameWidth,
          frameDimensions.frameHeight,
        )
      : null;
    if (frameRectangle) {
      const { xFraction, yFraction } = viewPointToFrameFractions(viewPoint.x, viewPoint.y, frameRectangle);
      if (xFraction >= 0 && xFraction <= 1 && yFraction >= 0 && yFraction <= 1) {
        setMeasurementRegion(placeMeasurementRegion(xFraction, yFraction, measurementRegion.sizeFraction));
      }
    }
    if (!canMeter || !cameraDevice) return;
    const meteringModes: MeteringMode[] = [];
    if (cameraDevice.supportsExposureMetering) meteringModes.push('AE');
    if (cameraDevice.supportsFocusMetering) meteringModes.push('AF');
    setIsMeteringLocked(true);
    try {
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
    setIsMeteringLocked(false);
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
    setIsMeteringLocked(false);
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
  const unitLabel = t(`units.${bandPreset.displayUnit}`);

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
          displayedUnit: unitLabel,
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

  const frameRateText = engineStatus?.framesPerSecond
    ? t('frameRate', { framesPerSecond: engineStatus.framesPerSecond.toFixed(0) })
    : null;
  const isHighCutoffLimited =
    engineStatus?.effectiveHighCutoffHz != null && engineStatus.effectiveHighCutoffHz < highCutoffHz - 0.01;
  const isCurtainActive = isCurtainVisible && viewMode !== 'camera';
  const isPulseMonitorShown = bandId === 'pulse' && screenMode === 'measure';
  const isWaitingForPhaseReference = viewMode === 'phaseMap' && engineStatus?.status === 'running' && !engineStatus.hasPhaseMap;
  const qualityOrProgressText =
    latestEstimate && peakQuality
      ? t(`peakQuality.${peakQuality}`, { ratio: latestEstimate.peakToMedianPowerRatio.toFixed(1) })
      : t('collecting', {
          stored: measurementProgress.storedSeconds.toFixed(0),
          window: measurementProgress.windowSeconds.toFixed(0),
        });
  const measuredRateText = estimatedRate !== null ? formatRate(estimatedRate, bandPreset.displayUnit) : '—';

  // ---------------------------------------------------------------------------------------------
  // Piezas compartidas por el modo normal y el panel de pantalla completa

  const bandSelector = (
    <>
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
    </>
  );

  const statusTexts = (
    <>
      {hasGyroscope && !isSteadyForDisplay ? <BodyText tone="danger">{t('deviceMoving')}</BodyText> : null}
      {engineStatus?.status === 'estimatingFrameRate' || !engineStatus ? (
        <BodyText tone="secondary">{t('startingUp')}</BodyText>
      ) : null}
      {engineStatus?.status === 'bandAboveFrameRate' ? (
        <BodyText tone="danger">
          {t('bandAboveFrameRate', { framesPerSecond: engineStatus.framesPerSecond?.toFixed(0) ?? '?' })}
        </BodyText>
      ) : null}
      {isHighCutoffLimited && engineStatus?.effectiveHighCutoffHz ? (
        <BodyText tone="secondary">
          {t('highCutoffLimited', { frequency: engineStatus.effectiveHighCutoffHz.toFixed(1) })}
        </BodyText>
      ) : null}
      {isWaitingForPhaseReference ? <BodyText tone="secondary">{t('phaseWaiting')}</BodyText> : null}
      {isMeteringLocked ? (
        <View style={styles.buttonRow}>
          <BodyText style={styles.flexText}>{t('exposureLocked')}</BodyText>
          <View style={styles.unlockButton}>
            <AppButton label={t('unlockExposure')} onPress={() => void handleUnlockMetering()} variant="secondary" />
          </View>
        </View>
      ) : (
        <BodyText tone="secondary">{t('tapToChooseRegionHint')}</BodyText>
      )}
    </>
  );

  const displaySettings = (
    <>
      <SectionTitle>{t('displayTitle')}</SectionTitle>
      <ChoiceChips<ViewMode>
        options={viewModes}
        selectedOption={viewMode}
        labelFor={(optionViewMode) => t(`viewModes.${optionViewMode}`)}
        onSelect={setViewMode}
      />
      <BodyText tone="secondary">{t(`viewModeHints.${viewMode}`)}</BodyText>
      {viewMode !== 'camera' ? (
        <ChoiceChips<'curtainOff' | 'curtainOn'>
          options={['curtainOff', 'curtainOn']}
          selectedOption={isCurtainVisible ? 'curtainOn' : 'curtainOff'}
          labelFor={(curtainOption) => t(`curtainOptions.${curtainOption}`)}
          onSelect={(curtainOption) => setIsCurtainVisible(curtainOption === 'curtainOn')}
        />
      ) : null}
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
    </>
  );

  const pulseMonitorAccessibilityLabel = t('pulseMonitor.accessibility', { rate: measuredRateText, unit: unitLabel });
  const measurementSection = (
    <>
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
          {isPulseMonitorShown ? (
            <PulseMonitor
              traceStore={pulseTraceStore}
              beatsPerMinute={estimatedRate}
              unitLabel={unitLabel}
              statusText={qualityOrProgressText}
              notMedicalText={t('notMedicalShort')}
              accessibilityLabel={pulseMonitorAccessibilityLabel}
            />
          ) : (
            <Card style={styles.centeredCard}>
              <BodyText tone="secondary">{t(`measuredQuantity.${bandId}`)}</BodyText>
              <BodyText style={styles.rateValue}>{measuredRateText}</BodyText>
              <BodyText tone="secondary">{unitLabel}</BodyText>
              <BodyText tone={peakQuality === 'weak' ? 'danger' : 'secondary'}>{qualityOrProgressText}</BodyText>
            </Card>
          )}
          {latestEstimate && latestEstimate.bandMagnitudes.length > 1 ? (
            <>
              <BodyText tone="secondary">{t('spectrumTitle')}</BodyText>
              <SignalChart
                series={[{ values: latestEstimate.bandMagnitudes, color: themePalette.accent }]}
                height={120}
                verticalRange={{ mode: 'from-zero', minimumMaximum: 1e-6 }}
                revision={estimateRevision}
                horizontalLabels={[
                  `${formatRate(convertFrequencyToDisplayUnit(latestEstimate.bandFrequenciesHz[0] ?? 0, bandPreset.displayUnit), bandPreset.displayUnit)} ${unitLabel}`,
                  `${formatRate(convertFrequencyToDisplayUnit(latestEstimate.bandFrequenciesHz[latestEstimate.bandFrequenciesHz.length - 1] ?? 0, bandPreset.displayUnit), bandPreset.displayUnit)} ${unitLabel}`,
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
    </>
  );

  const tipsSection = (
    <>
      <SectionTitle>{t('tipsTitle')}</SectionTitle>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('tips')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('howItWorks')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('mapsHowItWorks')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('limits')}
      </BodyText>
    </>
  );

  // ---------------------------------------------------------------------------------------------
  // Lectura flotante en pantalla completa

  let fullScreenReadout: ReactNode;
  if (isPulseMonitorShown) {
    fullScreenReadout = (
      <PulseMonitor
        compact
        traceStore={pulseTraceStore}
        beatsPerMinute={estimatedRate}
        unitLabel={unitLabel}
        statusText={isSteadyForDisplay ? qualityOrProgressText : t('deviceMovingShort')}
        notMedicalText={t('notMedicalShort')}
        accessibilityLabel={pulseMonitorAccessibilityLabel}
      />
    );
  } else {
    let readoutStatusText: string | null = null;
    if (hasGyroscope && !isSteadyForDisplay) readoutStatusText = t('deviceMovingShort');
    else if (!engineStatus || engineStatus.status === 'estimatingFrameRate') readoutStatusText = t('startingUp');
    else if (engineStatus.status === 'bandAboveFrameRate') readoutStatusText = t('bandAboveFrameRateShort');
    else if (isWaitingForPhaseReference) readoutStatusText = t('phaseWaitingShort');
    const isRateShown = needsFrequencyEstimate && estimatedRate !== null;
    fullScreenReadout = (
      <>
        <CameraOverlayText style={styles.readoutTitle}>
          {`${t(`bands.${bandId}.label`)} · ${t(`viewModes.${viewMode}`)}`}
        </CameraOverlayText>
        {isRateShown ? (
          <CameraOverlayText style={styles.readoutValue}>{`${measuredRateText} ${unitLabel}`}</CameraOverlayText>
        ) : null}
        {readoutStatusText ? (
          <CameraOverlayText style={hasGyroscope && !isSteadyForDisplay ? styles.readoutWarning : undefined}>
            {readoutStatusText}
          </CameraOverlayText>
        ) : null}
      </>
    );
  }

  const phaseFrequencyLabel =
    latestEstimate && estimatedRate !== null ? t('phaseLegend.frequency', { rate: measuredRateText, unit: unitLabel }) : null;

  function renderPreview(previewLayout: CameraPreviewLayout) {
    const { previewWidth, previewHeight, isFullScreen } = previewLayout;
    const frameRectangle = frameDimensions
      ? containFrameInView(previewWidth, previewHeight, frameDimensions.frameWidth, frameDimensions.frameHeight)
      : null;
    const regionRectangle = frameRectangle ? regionToViewRectangle(measurementRegion, frameRectangle) : null;
    // En pantalla completa, la leyenda queda justo encima del panel asomado.
    const legendBottom = isFullScreen
      ? panelHandleHeight + panelPrimaryActionsHeight + safeAreaInsets.bottom + 10
      : 8;
    return (
      <>
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
          <MagnifiedView
            imageStore={imageStore}
            viewWidth={previewWidth}
            viewHeight={previewHeight}
            curtainX={isCurtainActive ? curtainFraction * previewWidth : null}
          />
        ) : null}
        {regionRectangle ? (
          <View
            pointerEvents="none"
            style={[
              styles.measurementRegion,
              {
                left: regionRectangle.left,
                top: regionRectangle.top,
                width: regionRectangle.width,
                height: regionRectangle.height,
                borderStyle: screenMode === 'measure' || viewMode === 'phaseMap' ? 'solid' : 'dashed',
              },
            ]}
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('tapToChooseRegionHint')}
          style={StyleSheet.absoluteFill}
          onPress={(pressEvent) => void handlePreviewPress(pressEvent, previewLayout)}
        />
        {viewMode === 'heatMap' || viewMode === 'phaseMap' ? (
          <View
            pointerEvents="none"
            style={[styles.legendArea, { bottom: legendBottom, left: 8 + (isFullScreen ? safeAreaInsets.left : 0) }]}>
            {viewMode === 'heatMap' ? (
              <HeatMapLegend title={t('heatLegend.title')} lowLabel={t('heatLegend.low')} highLabel={t('heatLegend.high')} />
            ) : (
              <PhaseMapLegend
                title={t('phaseLegend.title')}
                sameLabel={t('phaseLegend.same')}
                oppositeLabel={t('phaseLegend.opposite')}
                frequencyLabel={phaseFrequencyLabel}
              />
            )}
          </View>
        ) : null}
        {isCurtainActive ? (
          <ComparisonCurtain
            previewWidth={previewWidth}
            previewHeight={previewHeight}
            curtainFraction={curtainFraction}
            onDragStart={handleCurtainDragStart}
            onDragMove={handleCurtainDragMove}
            onStep={handleCurtainStep}
            leftLabel={t('viewModes.camera')}
            rightLabel={t(`viewModesShort.${viewMode}`)}
            accessibilityLabel={t('curtainHandle')}
          />
        ) : null}
      </>
    );
  }

  return (
    <CameraScreenLayout
      title={t('name')}
      normalPreviewHeight={normalPreviewHeight}
      aboveNormalPreview={
        <>
          <Card>
            <BodyText style={styles.disclaimerText}>{t('notMedical')}</BodyText>
          </Card>
          <BodyText tone="secondary">{t('intro')}</BodyText>
        </>
      }
      renderPreview={renderPreview}
      topActions={
        <>
          {isMeteringLocked ? (
            <CameraOverlayButton
              label={t('unlockExposure')}
              accessibilityLabel={`${t('exposureLocked')} ${t('unlockExposure')}`}
              onPress={() => void handleUnlockMetering()}
            />
          ) : null}
          <CameraOverlayButton
            label={t('curtain')}
            isSelected={isCurtainActive}
            isDisabled={viewMode === 'camera'}
            onPress={() => setIsCurtainVisible((previousVisibility) => !previousVisibility)}
          />
        </>
      }
      readout={fullScreenReadout}
      primaryActions={
        <ViewModeActions
          selectedViewMode={viewMode}
          labelFor={(optionViewMode) => t(`viewModesShort.${optionViewMode}`)}
          onSelect={setViewMode}
        />
      }
      panelContent={
        <>
          <BodyText tone="secondary">{t(`viewModeHints.${viewMode}`)}</BodyText>
          {statusTexts}
          {measurementSection}
          {bandSelector}
          {displaySettings}
          {tipsSection}
        </>
      }>
      {statusTexts}
      {bandSelector}
      {displaySettings}
      {measurementSection}
      {tipsSection}
    </CameraScreenLayout>
  );
}

const styles = StyleSheet.create({
  disclaimerText: { fontWeight: '600' },
  measurementRegion: { position: 'absolute', borderWidth: 2, borderColor: measurementRegionColor, borderRadius: 4 },
  legendArea: { position: 'absolute' },
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
  modeAction: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  modeActionLabel: { fontSize: 14, fontWeight: '600' },
  smallText: { fontSize: 13 },
  readoutTitle: { fontSize: 13, fontWeight: '600', opacity: 0.85 },
  readoutValue: { fontSize: 22, lineHeight: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  readoutWarning: { color: '#FCA5A5' },
});
