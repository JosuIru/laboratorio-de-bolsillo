import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef, useCameraDevice } from 'react-native-vision-camera';

import { formatExposureValue, stepExposure } from '@/core/camera/exposureScale';
import { useCameraZoomAndExposure } from '@/core/camera/useCameraZoomAndExposure';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import type { FlickerAnalysis } from '@/processing/flicker/flickerAnalyzer';
import { classifyFlickerRisk } from '@/processing/flicker/lightClassification';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { mainsFrequencyInstrumentId } from './instrumentId';
import type { MainsFrequencyMeasurementValues } from './schema';
import { useFlickerFrames } from './useFlickerFrames';

type NominalMainsFrequency = 50 | 60;

const previewHeight = 220;
const chartHeight = 140;
const meteringMarkerRadius = 28;
/** Fracción de píxeles quemados a partir de la cual se avisa (recortan las bandas). */
const saturationWarningFraction = 0.05;
/** Luminancia lineal media (suma de R+G+B, 0-3) por debajo de la cual la imagen es muy oscura. */
const darkImageLuminance = 0.01;
/** Segundos de historial sin frecuencia coherente a partir de los cuales se avisa. */
const unstableBandsWarningSeconds = 4;

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

function roundTo(value: number, decimalCount: number): number {
  const scale = 10 ** decimalCount;
  return Math.round(value * scale) / scale;
}

function formatSigned(value: number, decimalCount: number): string {
  const formattedValue = value.toFixed(decimalCount);
  return value > 0 ? `+${formattedValue}` : formattedValue.replace('-', '−');
}

/** Valores que se guardan con la medición (los opcionales solo si se han medido). */
function measurementValuesFromAnalysis(
  analysis: FlickerAnalysis,
  nominalMainsFrequencyHz: number,
): MainsFrequencyMeasurementValues {
  const { frequency, metrics } = analysis;
  return {
    nominalMainsFrequencyHz,
    lightType: analysis.lightType ?? 'steady',
    ...(frequency
      ? {
          mainsFrequencyHz: roundTo(frequency.flickerFrequencyHz / 2, 5),
          mainsFrequencyUncertaintyHz: roundTo(frequency.uncertaintyHz / 2, 5),
          flickerFrequencyHz: roundTo(frequency.flickerFrequencyHz, 5),
          measurementDurationSeconds: roundTo(frequency.durationSeconds, 1),
          phaseCoherence: roundTo(frequency.phaseCoherence, 3),
        }
      : {}),
    ...(metrics && analysis.status === 'bands'
      ? {
          percentFlicker: roundTo(metrics.percentFlicker, 2),
          flickerIndex: roundTo(metrics.flickerIndex, 4),
          harmonicDistortion: roundTo(metrics.harmonicDistortion, 3),
        }
      : {}),
    ...(analysis.status === 'noBands' && analysis.percentFlickerUpperBound !== null
      ? { percentFlickerUpperBound: roundTo(analysis.percentFlickerUpperBound, 2) }
      : {}),
    ...(analysis.readoutTimeMilliseconds !== null
      ? { readoutTimeMilliseconds: roundTo(analysis.readoutTimeMilliseconds, 2) }
      : {}),
    ...(analysis.frameRateHz !== null ? { frameRateHz: roundTo(analysis.frameRateHz, 2) } : {}),
  };
}

export function MainsFrequencyScreen({ saveMeasurement }: InstrumentScreenProps<MainsFrequencyMeasurementValues>) {
  const { t } = useTranslation(mainsFrequencyInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const cameraDevice = useCameraDevice('back');
  const isCameraAllowed = useIsCameraAllowed();
  const [nominalMainsFrequencyHz, setNominalMainsFrequencyHz] = useState<NominalMainsFrequency>(50);
  const nominalFlickerFrequencyHz = 2 * nominalMainsFrequencyHz;
  const { frameOutput, analysis, meanLuminance, resetAnalysis } = useFlickerFrames(
    nominalFlickerFrequencyHz,
    isCameraAllowed,
  );
  // Se arranca con poca luz: exposiciones cortas, que son las que dejan ver las bandas.
  const {
    zoomFactor,
    exposureScale,
    exposureBias,
    minimumExposureBias,
    maximumExposureBias,
    setRequestedExposureBias,
    handleCameraStarted,
  } = useCameraZoomAndExposure(cameraRef, cameraDevice, true);

  const [meteringViewPoint, setMeteringViewPoint] = useState<{ x: number; y: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const canLockExposure = Boolean(cameraDevice?.supportsExposureMetering);

  const chartSeries = useMemo(() => {
    if (!analysis?.latestModulationProfile || !analysis.latestFittedBands) return null;
    const toPercent = (values: Float64Array) => Float64Array.from(values, (value) => 100 * value);
    return [
      { values: toPercent(analysis.latestModulationProfile), color: themePalette.textSecondary },
      { values: toPercent(analysis.latestFittedBands), color: themePalette.accent },
    ];
  }, [analysis, themePalette]);

  function changeExposureBias(nextExposureBias: number) {
    setRequestedExposureBias(nextExposureBias);
    // Al cambiar la exposición cambia la fase de las bandas: se empieza de nuevo.
    resetAnalysis();
  }

  async function handlePreviewPress(pressEvent: GestureResponderEvent) {
    if (!canLockExposure) return;
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    setMeteringViewPoint(viewPoint);
    try {
      // Exposición fija: si el móvil la reajusta, la fase de las bandas salta.
      await cameraRef.current?.focusTo(viewPoint, {
        modes: ['AE'],
        responsiveness: 'snappy',
        adaptiveness: 'locked',
        autoResetAfter: null,
      });
      if (exposureBias !== undefined) await cameraRef.current?.controller?.setExposureBias(exposureBias);
      resetAnalysis();
    } catch {
      // Cancelado por otro toque o no admitido: la medida sigue con la exposición automática.
    }
  }

  async function handleUnlockExposure() {
    setMeteringViewPoint(null);
    try {
      await cameraRef.current?.resetFocus();
    } catch {
      // La cámara puede no estar lista; no hay nada que deshacer.
    }
    resetAnalysis();
  }

  function handleCameraError(cameraError: Error) {
    if (isExpectedCameraInterruption(cameraError)) return;
    setStatusMessage(t('core:common.error', { message: cameraError.message }));
  }

  async function handleSave() {
    if (!analysis || analysis.status === 'collecting') return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({ values: measurementValuesFromAnalysis(analysis, nominalMainsFrequencyHz) });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const frequency = analysis?.frequency ?? null;
  const metrics = analysis?.status === 'bands' ? analysis.metrics : null;
  const isSaturated = (analysis?.saturatedFraction ?? 0) > saturationWarningFraction;
  const isTooDark = meanLuminance !== null && meanLuminance < darkImageLuminance;

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('intro')}</BodyText>

      <ChoiceChips<NominalMainsFrequency>
        options={[50, 60]}
        selectedOption={nominalMainsFrequencyHz}
        labelFor={(mainsFrequency) => t(mainsFrequency === 50 ? 'region50' : 'region60')}
        onSelect={setNominalMainsFrequencyHz}
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
          onStarted={handleCameraStarted}
          resizeMode="contain"
        />
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
          onDecrease={() => changeExposureBias(stepExposure(exposureScale, exposureBias, -1))}
          onIncrease={() => changeExposureBias(stepExposure(exposureScale, exposureBias, 1))}
          isDecreaseDisabled={exposureBias <= minimumExposureBias}
          isIncreaseDisabled={exposureBias >= maximumExposureBias}
          decreaseLabel={t('exposureDown')}
          increaseLabel={t('exposureUp')}
        />
      ) : (
        <BodyText tone="secondary">{t('exposureUnsupported')}</BodyText>
      )}
      {canLockExposure ? (
        meteringViewPoint ? (
          <View style={styles.buttonRow}>
            <BodyText style={styles.flexText}>{t('exposureLocked')}</BodyText>
            <View style={styles.unlockButton}>
              <AppButton label={t('unlockExposure')} onPress={() => void handleUnlockExposure()} variant="secondary" />
            </View>
          </View>
        ) : (
          <BodyText tone="secondary">{t('tapToLockHint')}</BodyText>
        )
      ) : null}
      {isSaturated ? <BodyText tone="danger">{t('saturatedWarning')}</BodyText> : null}
      {isTooDark ? <BodyText tone="danger">{t('tooDarkWarning')}</BodyText> : null}

      {!analysis || analysis.status === 'collecting' ? <LoadingState label={t('collecting')} /> : null}

      {analysis?.status === 'noBands' ? (
        <Card style={styles.resultCard}>
          <SectionTitle>{t('noBandsTitle')}</SectionTitle>
          {analysis.percentFlickerUpperBound !== null ? (
            <BodyText>{t('noBandsUpperBound', { percent: analysis.percentFlickerUpperBound.toFixed(1) })}</BodyText>
          ) : null}
          <BodyText tone="secondary">{t('noBandsExplanation')}</BodyText>
        </Card>
      ) : null}

      {analysis?.status === 'bands' ? (
        <Card style={styles.resultCard}>
          <BodyText tone="secondary">{t('mainsFrequencyTitle')}</BodyText>
          {frequency ? (
            <>
              <BodyText style={styles.bigValue}>
                {t('frequencyValue', { frequency: (frequency.flickerFrequencyHz / 2).toFixed(3) })}
              </BodyText>
              <BodyText>
                {t('frequencyDetails', {
                  uncertainty: (frequency.uncertaintyHz / 2).toFixed(3),
                  deviation: formatSigned((1000 * frequency.deviationHz) / 2, 0),
                  nominal: nominalMainsFrequencyHz,
                })}
              </BodyText>
              <BodyText tone="secondary">
                {t('frequencyBasis', {
                  seconds: frequency.durationSeconds.toFixed(0),
                  frames: frequency.sampleCount,
                  coherence: Math.round(100 * frequency.phaseCoherence),
                })}
              </BodyText>
              {frequency.isDirectionAmbiguous ? (
                <BodyText tone="danger">{t('directionAmbiguous')}</BodyText>
              ) : null}
            </>
          ) : (
            <BodyText tone={analysis.phaseHistorySeconds >= unstableBandsWarningSeconds ? 'danger' : 'secondary'}>
              {analysis.phaseHistorySeconds >= unstableBandsWarningSeconds
                ? t('unstableBands')
                : t('measuringFrequency', { seconds: analysis.phaseHistorySeconds.toFixed(0) })}
            </BodyText>
          )}
        </Card>
      ) : null}

      {analysis?.status === 'bands' && chartSeries ? (
        <>
          <SectionTitle>{t('bandsTitle')}</SectionTitle>
          <SignalChart
            series={chartSeries}
            height={chartHeight}
            verticalRange={{ mode: 'symmetric', minimumHalfRange: 1 }}
            revision={0}
            unitLabel="%"
            horizontalLabels={[t('chartFirstRow'), t('chartLastRow')]}
            accessibilityLabel={t('bandsChartDescription')}
          />
          <BodyText tone="secondary" style={styles.smallText}>
            {t('bandsChartDescription')}
          </BodyText>
          {analysis.detection?.mode === 'spatial' ? (
            <BodyText tone="danger">
              {t('staticBandsWarning', { fps: analysis.frameRateHz?.toFixed(0) ?? '?' })}
            </BodyText>
          ) : null}
        </>
      ) : null}

      {analysis?.status === 'bands' && analysis.lightType && metrics ? (
        <Card style={styles.resultCard}>
          <BodyText tone="secondary">{t('lightTitle')}</BodyText>
          <BodyText style={styles.lightTypeValue}>{t(`lightTypes.${analysis.lightType}.name`)}</BodyText>
          <BodyText tone="secondary">{t(`lightTypes.${analysis.lightType}.description`)}</BodyText>
          <BodyText>
            {t('percentFlicker', { percent: metrics.percentFlicker.toFixed(1) })}
            {' · '}
            {t('flickerIndex', { index: metrics.flickerIndex.toFixed(3) })}
          </BodyText>
          <BodyText>
            {t(
              `risk.${classifyFlickerRisk(metrics.percentFlicker, frequency?.flickerFrequencyHz ?? nominalFlickerFrequencyHz)}`,
            )}
          </BodyText>
          <BodyText tone="secondary" style={styles.smallText}>
            {t('depthIsMinimum')}
          </BodyText>
        </Card>
      ) : null}

      {analysis?.detection ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {t('technicalDetails', {
            bands: analysis.detection.cyclesPerFrame.toFixed(2),
            readout: analysis.readoutTimeMilliseconds?.toFixed(1) ?? '?',
            fps: analysis.frameRateHz?.toFixed(1) ?? '?',
            axis: t(`axes.${analysis.detection.axis}`),
          })}
        </BodyText>
      ) : null}

      <View style={styles.buttonRow}>
        <View style={styles.flexButton}>
          <AppButton label={t('restart')} onPress={resetAnalysis} variant="secondary" />
        </View>
        <View style={styles.flexButton}>
          <AppButton
            label={t('core:common.save')}
            onPress={() => void handleSave()}
            isBusy={isSaving}
            isDisabled={!analysis || analysis.status === 'collecting'}
          />
        </View>
      </View>
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <SectionTitle>{t('howItWorksTitle')}</SectionTitle>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('howItWorks')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('precision')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('limits')}
      </BodyText>
    </ScreenContainer>
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
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stepperButton: { width: 100 },
  stepperLabel: { flex: 1, textAlign: 'center', fontWeight: '600', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexText: { flex: 1 },
  flexButton: { flex: 1 },
  unlockButton: { width: 110 },
  resultCard: { gap: 6 },
  bigValue: { fontSize: 40, lineHeight: 48, fontWeight: '700', fontVariant: ['tabular-nums'] },
  lightTypeValue: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  smallText: { fontSize: 13 },
});
