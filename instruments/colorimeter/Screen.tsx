import { type RefObject, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef } from 'react-native-vision-camera';

import { useCameraPointsInView } from '@/core/camera/useCameraPointsInView';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { AppButton, BodyText, Card } from '@/ui/components';
import { CameraOverlayButton, CameraOverlayText, CameraScreenLayout } from '@/ui/FullScreenCamera';
import { useThemePalette } from '@/ui/theme';

import { evaluateColorimeterFrame, type UserColorScale } from './colorimeterEngine';
import { type ColorimeterCalibrationParameters, defaultReferenceCard, referencePatchLabel } from './referenceCards';
import { colorimeterInstrumentId, ScaleEditor } from './ScaleEditor';
import { loadColorScales, saveColorScales } from './scaleStorage';
import type { ColorimeterMeasurementValues } from './schema';
import { type CameraPoint, useColorimeterFrames } from './useColorimeterFrames';

/** Por encima de este ΔE00 la muestra no se parece a ningún color de la escala. */
const poorScaleMatchDeltaE = 10;

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

  // Los marcadores se guardan en coordenadas de cámara (no en píxeles de la vista): así no se
  // descolocan cuando la vista previa cambia de tamaño (p. ej. al pasar a pantalla completa).
  const [markerCameraPoints, setMarkerCameraPoints] = useState<(CameraPoint | null)[]>(() =>
    new Array(markerCount).fill(null),
  );
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
    setMarkerCameraPoints(new Array(markerCount).fill(null));
    setActiveMarkerIndex(0);
  }

  const { frameOutput, latestRegions: averagedRegions, resetAverage } = useColorimeterFrames(markerCameraPoints);
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
    setMarkerCameraPoints((previousCameraPoints) =>
      previousCameraPoints.map((markerCameraPoint, markerIndex) =>
        markerIndex === activeMarkerIndex ? cameraPoint : markerCameraPoint,
      ),
    );
    resetAverage();
    // Pasa al siguiente marcador sin colocar, para colocar la tarjeta de una vez.
    const nextUnplacedIndex = markerCameraPoints.findIndex(
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
          // Error de validación dejando un parche fuera; sin parches de sobra no hay valor honesto.
          ...(correction && correction.meanValidationDeltaE !== null
            ? { correctionMeanResidualDeltaE: roundTo(correction.meanValidationDeltaE, 2) }
            : {}),
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

  const markerLabels = [
    t('sampleMarker'),
    ...referenceCard.patches.map((patch) => referencePatchLabel(patch, (translationKey) => t(translationKey))),
  ];
  const markerColors = [themePalette.onAccent, ...referenceCard.patches.map((patch) => patch.hexColor)];
  const scaleMatch = colorimeterReading?.scaleMatch;
  const placeMarkerHint = t('placeMarkerHint', { marker: markerLabels[activeMarkerIndex] });

  function toggleTorch() {
    setIsTorchOn((wasTorchOn) => !wasTorchOn);
  }

  function clearMarkers() {
    setMarkerCameraPoints(new Array(markerCount).fill(null));
    setActiveMarkerIndex(0);
    resetAverage();
  }

  // Piezas que se reparten de forma distinta en el modo normal y en pantalla completa.
  const markerChips = (
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
            <BodyText tone={isActiveMarker ? 'accent' : markerCameraPoints[markerIndex] ? 'primary' : 'secondary'}>
              {`${markerIndex === 0 ? 'M' : markerIndex} · ${markerLabel}`}
            </BodyText>
          </Pressable>
        );
      })}
    </View>
  );
  const clearMarkersButton = <AppButton label={t('clearMarkers')} onPress={clearMarkers} variant="secondary" />;
  const saveButton = (
    <AppButton
      label={t('core:common.save')}
      onPress={() => void handleSave()}
      isBusy={isSaving}
      isDisabled={!colorimeterReading}
    />
  );
  const statusText = statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null;
  const resultCard = (
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
              ? colorimeterReading.correction.meanValidationDeltaE !== null
                ? t('correctionSummary', {
                    patchCount: colorimeterReading.usedPatchCount,
                    model: t(`correctionModel.${colorimeterReading.correction.model}`),
                    residual: colorimeterReading.correction.meanValidationDeltaE.toFixed(1),
                  })
                : t('correctionSummaryUnvalidated', {
                    patchCount: colorimeterReading.usedPatchCount,
                    model: t(`correctionModel.${colorimeterReading.correction.model}`),
                  })
              : t('noCorrection')}
          </BodyText>
          {colorimeterReading.correction?.isReducedToWhiteBalance ? (
            <BodyText tone="danger">{t('reducedToWhiteBalance')}</BodyText>
          ) : null}
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
  );
  const scaleEditor = (
    <ScaleEditor
      scales={scales}
      selectedScaleId={selectedScaleId}
      currentSampleHex={colorimeterReading?.correctedSampleHex ?? null}
      onScalesChange={handleScalesChange}
      onSelectScale={setSelectedScaleId}
    />
  );
  const privacyNote = (
    <BodyText tone="secondary" style={styles.privacyNote}>
      {t('privacy')}
    </BodyText>
  );

  // Lectura flotante en pantalla completa: el color corregido y el valor de la escala (o L*a*b*).
  const fullScreenReadout = (
    <>
      <CameraOverlayText style={styles.readoutHint}>{placeMarkerHint}</CameraOverlayText>
      {colorimeterReading ? (
        <View style={styles.readoutRow}>
          <View style={[styles.readoutSwatch, { backgroundColor: colorimeterReading.correctedSampleHex }]} />
          <CameraOverlayText style={styles.readoutValue}>
            {selectedScale && scaleMatch
              ? `≈ ${scaleMatch.interpolatedValue.toFixed(2)} ${selectedScale.unit}`
              : `L* ${colorimeterReading.sampleLab.lightness.toFixed(1)}  a* ${colorimeterReading.sampleLab.greenRed.toFixed(1)}  b* ${colorimeterReading.sampleLab.blueYellow.toFixed(1)}`}
          </CameraOverlayText>
        </View>
      ) : null}
    </>
  );

  return (
    <CameraScreenLayout
      title={t('name')}
      renderPreview={({ previewWidth, previewHeight }) => (
        <>
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
            accessibilityLabel={placeMarkerHint}
            style={StyleSheet.absoluteFill}
            onPress={handlePreviewPress}>
            <MarkerOverlay
              cameraRef={cameraRef}
              markerCameraPoints={markerCameraPoints}
              markerColors={markerColors}
              activeMarkerIndex={activeMarkerIndex}
              previewWidth={previewWidth}
              previewHeight={previewHeight}
            />
          </Pressable>
        </>
      )}
      topActions={<CameraOverlayButton label={t('torch')} isSelected={isTorchOn} onPress={toggleTorch} />}
      readout={fullScreenReadout}
      primaryActions={
        <>
          <View style={styles.buttonCell}>{clearMarkersButton}</View>
          <View style={styles.buttonCell}>{saveButton}</View>
        </>
      }
      panelContent={
        <>
          {markerChips}
          {statusText}
          {resultCard}
          {scaleEditor}
          {privacyNote}
        </>
      }>
      <BodyText tone="secondary">{placeMarkerHint}</BodyText>
      {markerChips}
      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton label={isTorchOn ? t('torchOff') : t('torchOn')} onPress={toggleTorch} variant="secondary" />
        </View>
        <View style={styles.buttonCell}>{clearMarkersButton}</View>
      </View>
      {resultCard}
      {saveButton}
      {statusText}
      {scaleEditor}
      {privacyNote}
    </CameraScreenLayout>
  );
}

/** Marcadores sobre la vista previa, situados a partir de sus coordenadas de cámara. */
function MarkerOverlay({
  cameraRef,
  markerCameraPoints,
  markerColors,
  activeMarkerIndex,
  previewWidth,
  previewHeight,
}: {
  cameraRef: RefObject<CameraRef | null>;
  markerCameraPoints: readonly (CameraPoint | null)[];
  markerColors: readonly string[];
  activeMarkerIndex: number;
  previewWidth: number;
  previewHeight: number;
}) {
  const markerViewPoints = useCameraPointsInView(cameraRef, markerCameraPoints, previewWidth, previewHeight);
  return (
    <>
      {markerViewPoints.map((markerViewPoint, markerIndex) =>
        markerViewPoint ? (
          <View
            key={markerIndex}
            pointerEvents="none"
            style={[
              styles.marker,
              {
                left: markerViewPoint.x - markerRadius,
                top: markerViewPoint.y - markerRadius,
                borderColor: markerIndex === 0 ? '#FFFFFF' : markerColors[markerIndex],
                borderWidth: markerIndex === activeMarkerIndex ? 4 : 2,
              },
            ]}>
            <BodyText style={styles.markerLabel}>{markerIndex === 0 ? 'M' : String(markerIndex)}</BodyText>
          </View>
        ) : null,
      )}
    </>
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
  readoutHint: { fontSize: 13, lineHeight: 18 },
  readoutRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  readoutSwatch: { width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: '#FFFFFF' },
  readoutValue: { fontSize: 20, lineHeight: 26, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
