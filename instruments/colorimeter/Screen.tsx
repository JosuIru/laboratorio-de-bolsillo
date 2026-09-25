import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef } from 'react-native-vision-camera';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { AppButton, BodyText, Card, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { evaluateColorimeterFrame, type UserColorScale } from './colorimeterEngine';
import { type ColorimeterCalibrationParameters, defaultReferenceCard } from './referenceCards';
import { colorimeterInstrumentId, ScaleEditor } from './ScaleEditor';
import { loadColorScales, saveColorScales } from './scaleStorage';
import type { ColorimeterMeasurementValues } from './schema';
import { type CameraPoint, useColorimeterFrames } from './useColorimeterFrames';

const previewHeight = 340;
/** Por encima de este ΔE00 la muestra no se parece a ningún color de la escala. */
const poorScaleMatchDeltaE = 10;

interface PlacedMarker {
  viewPoint: { x: number; y: number };
  cameraPoint: CameraPoint;
}

export function ColorimeterScreen({
  calibrationParameters,
  saveMeasurement,
}: InstrumentScreenProps<ColorimeterMeasurementValues, ColorimeterCalibrationParameters>) {
  const { t } = useTranslation(colorimeterInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const isCameraAllowed = useIsCameraAllowed();
  const referenceCard = calibrationParameters?.card ?? defaultReferenceCard;
  const markerCount = 1 + referenceCard.patches.length;

  const [placedMarkers, setPlacedMarkers] = useState<(PlacedMarker | null)[]>(() => new Array(markerCount).fill(null));
  const [activeMarkerIndex, setActiveMarkerIndex] = useState(0);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [scales, setScales] = useState<UserColorScale[]>(loadColorScales);
  const [selectedScaleId, setSelectedScaleId] = useState<string | null>(() => loadColorScales()[0]?.id ?? null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Si cambia la tarjeta (otra calibración), los marcadores de parches ya no valen.
  const [markersCardKey, setMarkersCardKey] = useState(referenceCard);
  if (markersCardKey !== referenceCard) {
    setMarkersCardKey(referenceCard);
    setPlacedMarkers(new Array(markerCount).fill(null));
    setActiveMarkerIndex(0);
  }

  const regionCenters = useMemo(() => placedMarkers.map((marker) => marker?.cameraPoint ?? null), [placedMarkers]);
  const { frameOutput, latestRegions: averagedRegions, resetAverage } = useColorimeterFrames(regionCenters);
  const selectedScale = scales.find((scale) => scale.id === selectedScaleId) ?? null;
  const colorimeterReading = useMemo(() => {
    const sampleRegion = averagedRegions?.[0];
    if (!sampleRegion) return null;
    return evaluateColorimeterFrame(sampleRegion, averagedRegions.slice(1), referenceCard, selectedScale);
  }, [averagedRegions, referenceCard, selectedScale]);

  function handlePreviewPress(pressEvent: GestureResponderEvent) {
    const viewPoint = { x: pressEvent.nativeEvent.locationX, y: pressEvent.nativeEvent.locationY };
    let cameraPoint: CameraPoint;
    try {
      const cameraView = cameraRef.current;
      if (!cameraView) return;
      cameraPoint = cameraView.convertViewPointToCameraPoint(viewPoint);
    } catch {
      return;
    }
    setPlacedMarkers((previousMarkers) =>
      previousMarkers.map((marker, markerIndex) => (markerIndex === activeMarkerIndex ? { viewPoint, cameraPoint } : marker)),
    );
    resetAverage();
    // Pasa al siguiente marcador sin colocar, para colocar la tarjeta de una vez.
    const nextUnplacedIndex = placedMarkers.findIndex(
      (marker, markerIndex) => marker === null && markerIndex !== activeMarkerIndex,
    );
    if (nextUnplacedIndex >= 0) setActiveMarkerIndex(nextUnplacedIndex);
  }

  function handleScalesChange(updatedScales: UserColorScale[]) {
    setScales(updatedScales);
    saveColorScales(updatedScales);
  }

  async function handleSave() {
    if (!colorimeterReading) return;
    setIsSaving(true);
    setStatusMessage(null);
    const { scaleMatch, correction } = colorimeterReading;
    const roundTo = (numericValue: number, fractionDigits: number) =>
      Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    try {
      await saveMeasurement({
        values: {
          sampleColor: colorimeterReading.correctedSampleHex,
          rawSampleColor: colorimeterReading.rawSampleHex,
          labLightness: roundTo(colorimeterReading.sampleLab.lightness, 2),
          labGreenRed: roundTo(colorimeterReading.sampleLab.greenRed, 2),
          labBlueYellow: roundTo(colorimeterReading.sampleLab.blueYellow, 2),
          correctionModel: correction?.model ?? 'none',
          referencePatchCount: colorimeterReading.usedPatchCount,
          ...(correction ? { correctionMeanResidualDeltaE: roundTo(correction.meanResidualDeltaE, 2) } : {}),
          sampleRelativeDeviation: roundTo(colorimeterReading.sampleRelativeDeviation, 3),
          ...(selectedScale && scaleMatch
            ? {
                scaleName: selectedScale.name,
                nearestScaleLabel: scaleMatch.nearestEntry.label,
                nearestScaleDeltaE: roundTo(scaleMatch.nearestDeltaE, 2),
                estimatedValue: roundTo(scaleMatch.interpolatedValue, 3),
                estimatedValueUnit: selectedScale.unit,
                interpolationDeltaE: roundTo(scaleMatch.interpolationDeltaE, 2),
              }
            : {}),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const markerLabels = [t('sampleMarker'), ...referenceCard.patches.map((patch) => patch.name)];
  const markerColors = [themePalette.onAccent, ...referenceCard.patches.map((patch) => patch.hexColor)];
  const scaleMatch = colorimeterReading?.scaleMatch;

  return (
    <ScreenContainer>
      <View style={[styles.previewContainer, { borderColor: themePalette.border }]}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device="back"
          isActive={isCameraAllowed}
          outputs={[frameOutput]}
          torchMode={isTorchOn ? 'on' : 'off'}
          resizeMode="cover"
          onError={(cameraError) => {
            if (!isExpectedCameraInterruption(cameraError)) {
              setStatusMessage(t('core:common.error', { message: cameraError.message }));
            }
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('placeMarkerHint', { marker: markerLabels[activeMarkerIndex] })}
          style={StyleSheet.absoluteFill}
          onPress={handlePreviewPress}>
          {placedMarkers.map((marker, markerIndex) =>
            marker ? (
              <View
                key={markerIndex}
                pointerEvents="none"
                style={[
                  styles.marker,
                  {
                    left: marker.viewPoint.x - markerRadius,
                    top: marker.viewPoint.y - markerRadius,
                    borderColor: markerIndex === 0 ? '#FFFFFF' : markerColors[markerIndex],
                    borderWidth: markerIndex === activeMarkerIndex ? 4 : 2,
                  },
                ]}>
                <BodyText style={styles.markerLabel}>{markerIndex === 0 ? 'M' : String(markerIndex)}</BodyText>
              </View>
            ) : null,
          )}
        </Pressable>
      </View>

      <BodyText tone="secondary">{t('placeMarkerHint', { marker: markerLabels[activeMarkerIndex] })}</BodyText>
      <View style={styles.chipRow}>
        {markerLabels.map((markerLabel, markerIndex) => {
          const isActiveMarker = markerIndex === activeMarkerIndex;
          return (
            <Pressable
              key={markerIndex}
              accessibilityRole="radio"
              accessibilityState={{ selected: isActiveMarker }}
              onPress={() => setActiveMarkerIndex(markerIndex)}
              style={[styles.chip, { borderColor: isActiveMarker ? themePalette.accent : themePalette.border }]}>
              {markerIndex > 0 ? (
                <View style={[styles.chipSwatch, { backgroundColor: markerColors[markerIndex] }]} />
              ) : null}
              <BodyText tone={isActiveMarker ? 'accent' : placedMarkers[markerIndex] ? 'primary' : 'secondary'}>
                {`${markerIndex === 0 ? 'M' : markerIndex} · ${markerLabel}`}
              </BodyText>
            </Pressable>
          );
        })}
      </View>
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
            label={t('clearMarkers')}
            onPress={() => {
              setPlacedMarkers(new Array(markerCount).fill(null));
              setActiveMarkerIndex(0);
              resetAverage();
            }}
            variant="secondary"
          />
        </View>
      </View>

      <Card>
        {!colorimeterReading ? (
          <BodyText tone="secondary">{t('placeSampleFirst')}</BodyText>
        ) : (
          <>
            <View style={styles.swatchRow}>
              <Swatch label={t('rawColor')} hexColor={colorimeterReading.rawSampleHex} />
              <Swatch label={t('correctedColor')} hexColor={colorimeterReading.correctedSampleHex} />
            </View>
            <BodyText style={styles.labText}>
              {`L* ${colorimeterReading.sampleLab.lightness.toFixed(1)}   a* ${colorimeterReading.sampleLab.greenRed.toFixed(1)}   b* ${colorimeterReading.sampleLab.blueYellow.toFixed(1)}`}
            </BodyText>
            <BodyText tone="secondary">
              {colorimeterReading.correction
                ? t('correctionSummary', {
                    patchCount: colorimeterReading.usedPatchCount,
                    model: t(`correctionModel.${colorimeterReading.correction.model}`),
                    residual: colorimeterReading.correction.meanResidualDeltaE.toFixed(1),
                  })
                : t('noCorrection')}
            </BodyText>
            {!colorimeterReading.isSampleUniform ? <BodyText tone="danger">{t('nonUniformSample')}</BodyText> : null}
            {selectedScale && scaleMatch ? (
              <View style={styles.scaleResult}>
                <BodyText style={styles.estimatedValue}>
                  {`≈ ${scaleMatch.interpolatedValue.toFixed(2)} ${selectedScale.unit}`}
                </BodyText>
                <BodyText tone="secondary">
                  {t('nearestEntry', {
                    label: scaleMatch.nearestEntry.label,
                    deltaE: scaleMatch.nearestDeltaE.toFixed(1),
                  })}
                </BodyText>
                {scaleMatch.interpolationDeltaE > poorScaleMatchDeltaE ? (
                  <BodyText tone="danger">{t('poorScaleMatch')}</BodyText>
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </Card>

      <AppButton
        label={t('core:common.save')}
        onPress={() => void handleSave()}
        isBusy={isSaving}
        isDisabled={!colorimeterReading}
      />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <ScaleEditor
        scales={scales}
        selectedScaleId={selectedScaleId}
        currentSampleHex={colorimeterReading?.correctedSampleHex ?? null}
        onScalesChange={handleScalesChange}
        onSelectScale={setSelectedScaleId}
      />
      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

function Swatch({ label, hexColor }: { label: string; hexColor: string }) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.swatchColumn}>
      <View style={[styles.swatch, { backgroundColor: hexColor, borderColor: themePalette.border }]} />
      <BodyText tone="secondary">{label}</BodyText>
      <BodyText style={styles.hexText}>{hexColor}</BodyText>
    </View>
  );
}

const markerRadius = 16;

const styles = StyleSheet.create({
  previewContainer: {
    height: previewHeight,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  marker: {
    position: 'absolute',
    width: markerRadius * 2,
    height: markerRadius * 2,
    borderRadius: markerRadius,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  markerLabel: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  chipSwatch: { width: 14, height: 14, borderRadius: 3 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  swatchRow: { flexDirection: 'row', justifyContent: 'space-around' },
  swatchColumn: { alignItems: 'center', gap: 4 },
  swatch: { width: 72, height: 72, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  hexText: { fontVariant: ['tabular-nums'] },
  labText: { textAlign: 'center', fontVariant: ['tabular-nums'], fontWeight: '600' },
  scaleResult: { gap: 4, marginTop: 4 },
  estimatedValue: { fontSize: 24, fontWeight: '700' },
  privacyNote: { fontSize: 13 },
});
