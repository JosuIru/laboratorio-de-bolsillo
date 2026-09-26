import { router } from 'expo-router';
import { Fragment, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, type LayoutChangeEvent, Pressable, StyleSheet, Vibration, View } from 'react-native';
import { Camera, type CameraRef } from 'react-native-vision-camera';

import { useResolvedCalibration } from '@/core/calibration/useResolvedCalibration';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { AppButton, BodyText, Card, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { colorimeterInstrument } from '@instruments/colorimeter';
import {
  type ColorimeterCalibrationParameters,
  defaultReferenceCard,
  referencePatchLabel,
} from '@instruments/colorimeter/referenceCards';

import { initialLevelTexts, ScaleCalibrationCard } from './ScaleCalibrationCard';
import type { PoolStripsMeasurementValues } from './schema';
import {
  buildStripMeasurementValues,
  type CalibratedStripScales,
  computeStripGuideLayout,
  correctChartCellColors,
  createViewToCameraMapping,
  evaluateStripPads,
  mapViewRectToCameraRegion,
  type StripReading,
  type ViewToCameraMapping,
} from './stripEngine';
import {
  defaultReadingDelaySeconds,
  ignoredPadSlot,
  poolStripsInstrumentId,
  readingDelayOptionsSeconds,
  type StripParameterId,
  stripParameters,
  stripPresets,
} from './stripPresets';
import { StripReadingCard } from './StripReadingCard';
import { Chip, StripSetupCard } from './StripSetupCard';
import {
  loadCalibratedScales,
  loadStripConfiguration,
  saveCalibratedScales,
  saveStripConfiguration,
  type StripConfiguration,
} from './stripStorage';
import { useReadingCountdown } from './useReadingCountdown';
import { useStripFrames } from './useStripFrames';

const previewHeight = 300;
/** Lado del cuadro que marca un parche de la tarjeta; se muestrea su parte central. */
const patchMarkerSize = 28;
const patchSampleSize = 16;
const countdownFinishedVibrationMilliseconds = 400;

type ScreenMode = 'read' | 'calibrate';

interface FrozenReading {
  stripReading: StripReading;
  secondsAfterDip: number | null;
}

export function PoolStripsScreen({ saveMeasurement }: InstrumentScreenProps<PoolStripsMeasurementValues>) {
  const { t } = useTranslation(poolStripsInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const isCameraAllowed = useIsCameraAllowed();

  // La tarjeta de referencia es la del colorímetro: se calibra una vez y sirve para los dos.
  const colorimeterCalibrationState = useResolvedCalibration(colorimeterInstrument);
  const colorimeterCalibration =
    colorimeterCalibrationState.status === 'ready' ? colorimeterCalibrationState.resolvedCalibration : null;
  const referenceCard =
    (colorimeterCalibration?.parameters as ColorimeterCalibrationParameters | null | undefined)?.card ??
    defaultReferenceCard;

  const [screenMode, setScreenMode] = useState<ScreenMode>('read');
  const [configuration, setConfiguration] = useState<StripConfiguration>(loadStripConfiguration);
  const [calibratedScales, setCalibratedScales] = useState<CalibratedStripScales>(loadCalibratedScales);
  const [calibratingParameterId, setCalibratingParameterId] = useState<StripParameterId>(
    () => stripPresets[configuration.presetId].parameterIds[0]!,
  );
  const [levelValueTexts, setLevelValueTexts] = useState<string[]>(() =>
    initialLevelTexts(calibratingParameterId, calibratedScales),
  );
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [viewToCameraMapping, setViewToCameraMapping] = useState<ViewToCameraMapping | null>(null);
  const [patchMarkerPoints, setPatchMarkerPoints] = useState<({ x: number; y: number } | null)[]>(() =>
    new Array(referenceCard.patches.length).fill(null),
  );
  const [activePatchIndex, setActivePatchIndex] = useState(0);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [readingDelaySeconds, setReadingDelaySeconds] = useState(defaultReadingDelaySeconds);
  const [frozenReading, setFrozenReading] = useState<FrozenReading | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Si cambia la tarjeta (otra calibración del colorímetro), los parches colocados ya no valen.
  const [markersCardKey, setMarkersCardKey] = useState(referenceCard);
  if (markersCardKey !== referenceCard) {
    setMarkersCardKey(referenceCard);
    setPatchMarkerPoints(new Array(referenceCard.patches.length).fill(null));
    setActivePatchIndex(0);
  }

  const { padSlots, presetId } = configuration;
  const cellCount = screenMode === 'read' ? padSlots.length : levelValueTexts.length;
  const guideLayout = useMemo(
    () => (previewSize ? computeStripGuideLayout(previewSize.width, previewSize.height, cellCount) : null),
    [previewSize, cellCount],
  );

  // Regiones que se miden en cada fotograma: primero las casillas de la guía, después los parches.
  const cameraRegions = useMemo(() => {
    if (!viewToCameraMapping || !guideLayout) return [];
    const cellRegions = guideLayout.sampleRects.map((sampleRect, cellIndex) =>
      screenMode === 'read' && padSlots[cellIndex] === ignoredPadSlot
        ? null
        : mapViewRectToCameraRegion(viewToCameraMapping, sampleRect),
    );
    const patchRegions = patchMarkerPoints.map((markerPoint) =>
      markerPoint
        ? mapViewRectToCameraRegion(viewToCameraMapping, {
            left: markerPoint.x - patchSampleSize / 2,
            top: markerPoint.y - patchSampleSize / 2,
            width: patchSampleSize,
            height: patchSampleSize,
          })
        : null,
    );
    return [...cellRegions, ...patchRegions];
  }, [viewToCameraMapping, guideLayout, patchMarkerPoints, screenMode, padSlots]);
  const { frameOutput, latestRegions } = useStripFrames(cameraRegions);

  const liveStripReading = useMemo(() => {
    if (screenMode !== 'read' || !latestRegions) return null;
    const measuredPads = latestRegions.slice(0, cellCount);
    return evaluateStripPads(padSlots, measuredPads, latestRegions.slice(cellCount), referenceCard, calibratedScales);
  }, [screenMode, latestRegions, cellCount, padSlots, referenceCard, calibratedScales]);
  const chartCellHexColors = useMemo(() => {
    if (screenMode !== 'calibrate' || !latestRegions) return null;
    return correctChartCellColors(latestRegions.slice(0, cellCount), latestRegions.slice(cellCount), referenceCard);
  }, [screenMode, latestRegions, cellCount, referenceCard]);

  const countdown = useReadingCountdown((countdownDurationSeconds) => {
    Vibration.vibrate(countdownFinishedVibrationMilliseconds);
    // Los colores siguen cambiando después del tiempo indicado: se fija la lectura de ese momento.
    // Se guarda la duración con la que arrancó la cuenta atrás, no la que esté elegida ahora.
    if (liveStripReading) setFrozenReading({ stripReading: liveStripReading, secondsAfterDip: countdownDurationSeconds });
  });
  const secondsSinceDip = () => (countdown.dipTime !== null ? (Date.now() - countdown.dipTime) / 1000 : null);
  const displayedReading = frozenReading?.stripReading ?? liveStripReading;

  function captureViewToCameraMapping(viewWidth: number, viewHeight: number) {
    const cameraView = cameraRef.current;
    if (!cameraView) return;
    try {
      const mapping = createViewToCameraMapping(
        viewWidth,
        viewHeight,
        cameraView.convertViewPointToCameraPoint({ x: 0, y: 0 }),
        cameraView.convertViewPointToCameraPoint({ x: viewWidth, y: 0 }),
        cameraView.convertViewPointToCameraPoint({ x: 0, y: viewHeight }),
      );
      if (mapping) setViewToCameraMapping(mapping);
    } catch {
      // La vista previa aún no está lista: se reintenta al arrancar.
    }
  }

  function handlePreviewLayout(layoutEvent: LayoutChangeEvent) {
    const { width, height } = layoutEvent.nativeEvent.layout;
    setPreviewSize({ width, height });
    captureViewToCameraMapping(width, height);
  }

  function handlePreviewPress(pressEvent: GestureResponderEvent) {
    const tappedPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    setPatchMarkerPoints((previousPoints) =>
      previousPoints.map((markerPoint, markerIndex) => (markerIndex === activePatchIndex ? tappedPoint : markerPoint)),
    );
    // Pasa al siguiente parche sin colocar, para colocar la tarjeta de una vez.
    const nextUnplacedIndex = patchMarkerPoints.findIndex(
      (markerPoint, markerIndex) => markerPoint === null && markerIndex !== activePatchIndex,
    );
    if (nextUnplacedIndex >= 0) setActivePatchIndex(nextUnplacedIndex);
  }

  function handleConfigurationChange(updatedConfiguration: StripConfiguration) {
    setConfiguration(updatedConfiguration);
    saveStripConfiguration(updatedConfiguration);
    setFrozenReading(null);
    if (updatedConfiguration.presetId !== presetId) {
      selectCalibratingParameter(stripPresets[updatedConfiguration.presetId].parameterIds[0]!);
    }
  }

  function selectCalibratingParameter(parameterId: StripParameterId) {
    setCalibratingParameterId(parameterId);
    setLevelValueTexts(initialLevelTexts(parameterId, calibratedScales));
  }

  function handleCalibratedScalesChange(updatedScales: CalibratedStripScales) {
    setCalibratedScales(updatedScales);
    saveCalibratedScales(updatedScales);
  }

  async function handleSave() {
    if (!displayedReading) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: buildStripMeasurementValues(
          presetId,
          displayedReading,
          frozenReading ? frozenReading.secondsAfterDip : secondsSinceDip(),
        ),
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const translatePatchName = (translationKey: string) => t(translationKey);
  const activePatch = referenceCard.patches[activePatchIndex];
  const activePatchName = activePatch ? referencePatchLabel(activePatch, translatePatchName) : '';
  const cellLabels =
    screenMode === 'read' ? padSlots.map((_, slotIndex) => String(slotIndex + 1)) : levelValueTexts.map((levelText) => levelText);
  const guideHint =
    screenMode === 'read'
      ? t('guide.readHint')
      : t('guide.calibrateHint', { parameter: t(`quantities.${stripParameters[calibratingParameterId].quantity}`) });

  return (
    <ScreenContainer>
      <View style={styles.chipRow}>
        {(['read', 'calibrate'] as const).map((candidateMode) => (
          <Chip
            key={candidateMode}
            label={t(`modes.${candidateMode}`)}
            isSelected={candidateMode === screenMode}
            onPress={() => setScreenMode(candidateMode)}
          />
        ))}
      </View>

      <View style={[styles.previewContainer, { borderColor: themePalette.border }]} onLayout={handlePreviewLayout}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device="back"
          isActive={isCameraAllowed}
          outputs={[frameOutput]}
          torchMode={isTorchOn ? 'on' : 'off'}
          resizeMode="cover"
          onPreviewStarted={() => {
            if (previewSize) captureViewToCameraMapping(previewSize.width, previewSize.height);
          }}
          onError={(cameraError) => {
            if (!isExpectedCameraInterruption(cameraError)) {
              setStatusMessage(t('core:common.error', { message: cameraError.message }));
            }
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${guideHint} ${t('card.placeHint', { patch: activePatchName })}`}
          style={StyleSheet.absoluteFill}
          onPress={handlePreviewPress}>
          {guideLayout ? (
            <>
              <View
                pointerEvents="none"
                style={[
                  styles.guide,
                  {
                    left: guideLayout.guideRect.left,
                    top: guideLayout.guideRect.top,
                    width: guideLayout.guideRect.width,
                    height: guideLayout.guideRect.height,
                  },
                ]}
              />
              {/* Sin toques en las etiquetas: si no, locationX/Y serían relativas a la etiqueta y el parche caería mal. */}
              <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                <BodyText
                  style={{
                    ...styles.guideEndLabel,
                    left: guideLayout.guideRect.left,
                    top: guideLayout.guideRect.top + guideLayout.guideRect.height + 4,
                  }}>
                  {screenMode === 'read' ? t('guide.handle') : t('guide.lowestValue')}
                </BodyText>
              </View>
              {guideLayout.cellRects.map((cellRect, cellIndex) => {
                const sampleRect = guideLayout.sampleRects[cellIndex]!;
                const isIgnoredCell = screenMode === 'read' && padSlots[cellIndex] === ignoredPadSlot;
                return (
                  <Fragment key={cellIndex}>
                    {cellIndex > 0 ? (
                      <View
                        pointerEvents="none"
                        style={[styles.cellDivider, { left: cellRect.left, top: cellRect.top, height: cellRect.height }]} />
                    ) : null}
                    <View
                      pointerEvents="none"
                      style={[
                        styles.sampleArea,
                        {
                          left: sampleRect.left,
                          top: sampleRect.top,
                          width: sampleRect.width,
                          height: sampleRect.height,
                          opacity: isIgnoredCell ? 0.3 : 1,
                        },
                      ]}
                    />
                    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                      <BodyText
                        numberOfLines={1}
                        style={{ ...styles.cellLabel, left: cellRect.left, top: cellRect.top - 22, width: cellRect.width }}>
                        {isIgnoredCell ? '–' : cellLabels[cellIndex]}
                      </BodyText>
                    </View>
                  </Fragment>
                );
              })}
            </>
          ) : null}
          {patchMarkerPoints.map((markerPoint, markerIndex) =>
            markerPoint ? (
              <View
                key={markerIndex}
                pointerEvents="none"
                style={[
                  styles.patchMarker,
                  {
                    left: markerPoint.x - patchMarkerSize / 2,
                    top: markerPoint.y - patchMarkerSize / 2,
                    borderColor: referenceCard.patches[markerIndex]?.hexColor ?? '#FFFFFF',
                    borderWidth: markerIndex === activePatchIndex ? 4 : 2,
                  },
                ]}>
                <BodyText style={styles.patchMarkerLabel}>{String(markerIndex + 1)}</BodyText>
              </View>
            ) : null,
          )}
        </Pressable>
      </View>

      <BodyText tone="secondary">{guideHint}</BodyText>

      <Card>
        <BodyText style={styles.cardTitle}>{t('card.title')}</BodyText>
        <BodyText tone="secondary">
          {t('card.summary', { name: colorimeterCalibration?.activeProfile?.name ?? t('card.defaultName') })}
        </BodyText>
        <BodyText tone="secondary">{t('card.placeHint', { patch: activePatchName })}</BodyText>
        <View style={styles.chipRow}>
          {referenceCard.patches.map((patch, patchIndex) => {
            const isActivePatch = patchIndex === activePatchIndex;
            return (
              <Pressable
                key={patch.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: isActivePatch }}
                onPress={() => setActivePatchIndex(patchIndex)}
                style={[styles.patchChip, { borderColor: isActivePatch ? themePalette.accent : themePalette.border }]}>
                <View style={[styles.patchSwatch, { backgroundColor: patch.hexColor }]} />
                <BodyText tone={isActivePatch ? 'accent' : patchMarkerPoints[patchIndex] ? 'primary' : 'secondary'}>
                  {`${patchIndex + 1} · ${referencePatchLabel(patch, translatePatchName)}`}
                </BodyText>
              </Pressable>
            );
          })}
        </View>
        {displayedReading?.correction ? (
          <BodyText tone="secondary">
            {displayedReading.correction.meanValidationDeltaE !== null
              ? t('card.correctionSummary', {
                  patchCount: displayedReading.usedPatchCount,
                  model: t(`correctionModel.${displayedReading.correction.model}`),
                  residual: displayedReading.correction.meanValidationDeltaE.toFixed(1),
                })
              : t('card.correctionSummaryUnvalidated', {
                  patchCount: displayedReading.usedPatchCount,
                  model: t(`correctionModel.${displayedReading.correction.model}`),
                })}
          </BodyText>
        ) : (
          <BodyText tone="secondary">{t('card.noCorrection')}</BodyText>
        )}
        {displayedReading?.correction?.isReducedToWhiteBalance ? (
          <BodyText tone="danger">{t('card.reducedToWhiteBalance')}</BodyText>
        ) : null}
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton
              label={isTorchOn ? t('torchOff') : t('torchOn')}
              onPress={() => setIsTorchOn((wasTorchOn) => !wasTorchOn)}
              variant="secondary"
            />
          </View>
          <View style={styles.buttonCell}>
            <AppButton
              label={t('card.clearPatches')}
              onPress={() => {
                setPatchMarkerPoints(new Array(referenceCard.patches.length).fill(null));
                setActivePatchIndex(0);
              }}
              variant="secondary"
            />
          </View>
        </View>
        <AppButton
          label={t('card.change')}
          variant="secondary"
          onPress={() => router.push({ pathname: '/instrument/[id]/calibrate', params: { id: colorimeterInstrument.id } })}
        />
      </Card>

      {screenMode === 'read' ? (
        <>
          <Card>
            <BodyText style={styles.cardTitle}>{t('timer.title')}</BodyText>
            <BodyText tone="secondary">{t('timer.hint')}</BodyText>
            <View style={styles.chipRow}>
              {readingDelayOptionsSeconds.map((delaySeconds) => (
                <Chip
                  key={delaySeconds}
                  label={t('timer.seconds', { seconds: delaySeconds })}
                  isSelected={delaySeconds === readingDelaySeconds}
                  onPress={() => setReadingDelaySeconds(delaySeconds)}
                />
              ))}
            </View>
            {countdown.isRunning ? (
              <>
                <BodyText
                  style={styles.countdownText}
                  tone="accent">
                  {t('timer.remaining', { seconds: countdown.remainingSeconds })}
                </BodyText>
                <AppButton label={t('timer.cancel')} variant="secondary" onPress={countdown.reset} />
              </>
            ) : (
              <AppButton
                label={t('timer.start')}
                variant="secondary"
                onPress={() => {
                  setFrozenReading(null);
                  countdown.start(readingDelaySeconds);
                }}
              />
            )}
          </Card>

          <StripReadingCard
            stripReading={displayedReading}
            frozenAtSeconds={frozenReading ? frozenReading.secondsAfterDip : null}
            isFrozen={frozenReading !== null}
            onFreeze={() => {
              if (liveStripReading) setFrozenReading({ stripReading: liveStripReading, secondsAfterDip: secondsSinceDip() });
            }}
            onUnfreeze={() => setFrozenReading(null)}
          />

          <AppButton
            label={t('core:common.save')}
            onPress={() => void handleSave()}
            isBusy={isSaving}
            isDisabled={!displayedReading}
          />
          {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

          <StripSetupCard configuration={configuration} onConfigurationChange={handleConfigurationChange} />
        </>
      ) : (
        <>
          <ScaleCalibrationCard
            presetId={presetId}
            parameterId={calibratingParameterId}
            onSelectParameter={selectCalibratingParameter}
            levelValueTexts={levelValueTexts}
            onLevelValueTextsChange={setLevelValueTexts}
            measuredCellHexColors={chartCellHexColors}
            calibratedScales={calibratedScales}
            onCalibratedScalesChange={handleCalibratedScalesChange}
          />
          {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
        </>
      )}

      <BodyText tone="secondary" style={styles.footnote}>
        {t('disclaimer')}
      </BodyText>
      <BodyText tone="secondary" style={styles.footnote}>
        {t('privacy')}
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
  guide: { position: 'absolute', borderWidth: 2, borderColor: '#FFFFFF', borderRadius: 4 },
  guideEndLabel: {
    position: 'absolute',
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 3,
  },
  cellDivider: { position: 'absolute', width: 1, backgroundColor: 'rgba(255,255,255,0.7)' },
  sampleArea: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#FFFFFF',
    borderRadius: 2,
  },
  cellLabel: {
    position: 'absolute',
    textAlign: 'center',
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 3,
  },
  patchMarker: {
    position: 'absolute',
    width: patchMarkerSize,
    height: patchMarkerSize,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  patchMarkerLabel: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  patchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  patchSwatch: { width: 14, height: 14, borderRadius: 3 },
  cardTitle: { fontWeight: '600' },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  countdownText: { fontSize: 28, fontWeight: '700', textAlign: 'center', fontVariant: ['tabular-nums'] },
  footnote: { fontSize: 13 },
});
