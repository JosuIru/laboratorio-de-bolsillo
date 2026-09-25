import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Camera, type CameraRef } from 'react-native-vision-camera';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { linearToSrgb, type LinearRgb, rgb8ToHex } from '@/processing/color/colorSpaces';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import { type CameraPoint, useColorimeterFrames } from '@instruments/colorimeter/useColorimeterFrames';

import {
  estimateBeerColor,
  estimateWineColor,
  isValidPathLengthMm,
  measureTransmittance,
  recommendedPathLengthMm,
  type WineStyle,
} from './beerWineColorEngine';
import type { BeerWineColorMeasurementValues } from './schema';

export const beerWineColorInstrumentId = 'beer-wine-color';

type LiquidType = 'beer' | WineStyle;
const liquidTypes: readonly LiquidType[] = ['beer', 'white', 'rose', 'red'];

const previewHeight = 340;
/** Marcador 0: el papel visto a través del líquido; marcador 1: el papel sin líquido. */
const markerKeys = ['sample', 'paper'] as const;

interface PlacedMarker {
  viewPoint: { x: number; y: number };
  cameraPoint: CameraPoint;
}

function linearToHex(linearColor: LinearRgb): string {
  const clampComponent = (component: number) => Math.min(1, Math.max(0, component));
  return rgb8ToHex(
    linearToSrgb({
      red: clampComponent(linearColor.red),
      green: clampComponent(linearColor.green),
      blue: clampComponent(linearColor.blue),
    }),
  );
}

export function BeerWineColorScreen({ saveMeasurement }: InstrumentScreenProps<BeerWineColorMeasurementValues>) {
  const { t } = useTranslation(beerWineColorInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const isCameraAllowed = useIsCameraAllowed();

  const [liquidType, setLiquidType] = useState<LiquidType>('beer');
  const [pathLengthText, setPathLengthText] = useState(String(recommendedPathLengthMm.beer));
  const [placedMarkers, setPlacedMarkers] = useState<(PlacedMarker | null)[]>([null, null]);
  const [activeMarkerIndex, setActiveMarkerIndex] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const regionCenters = useMemo(() => placedMarkers.map((marker) => marker?.cameraPoint ?? null), [placedMarkers]);
  const { frameOutput, latestRegions: averagedRegions, resetAverage } = useColorimeterFrames(regionCenters);

  const pathLengthMm = parseDecimalInput(pathLengthText);
  const isPathLengthValid = isValidPathLengthMm(pathLengthMm);

  const colorReading = useMemo(() => {
    const sampleRegion = averagedRegions?.[0];
    const paperRegion = averagedRegions?.[1];
    if (!sampleRegion || !paperRegion || !isValidPathLengthMm(pathLengthMm)) return null;
    const pathLengthCm = pathLengthMm / 10;
    const transmittanceMeasurement = measureTransmittance(sampleRegion, paperRegion);
    return {
      ...transmittanceMeasurement,
      sampleHex: linearToHex(sampleRegion.meanLinear),
      paperHex: linearToHex(paperRegion.meanLinear),
      beerEstimate: liquidType === 'beer' ? estimateBeerColor(transmittanceMeasurement.transmittance, pathLengthCm) : null,
      wineEstimate:
        liquidType === 'beer' ? null : estimateWineColor(transmittanceMeasurement.transmittance, pathLengthCm, liquidType),
    };
  }, [averagedRegions, pathLengthMm, liquidType]);

  function handleLiquidTypeChange(selectedLiquidType: LiquidType) {
    setLiquidType(selectedLiquidType);
    setPathLengthText(String(recommendedPathLengthMm[selectedLiquidType]));
  }

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
    const otherMarkerIndex = 1 - activeMarkerIndex;
    if (!placedMarkers[otherMarkerIndex]) setActiveMarkerIndex(otherMarkerIndex);
  }

  async function handleSave() {
    if (!colorReading || !isValidPathLengthMm(pathLengthMm)) return;
    setIsSaving(true);
    setStatusMessage(null);
    const roundTo = (numericValue: number, fractionDigits: number) =>
      Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    const { transmittance, beerEstimate, wineEstimate } = colorReading;
    try {
      await saveMeasurement({
        values: {
          liquidType,
          pathLengthMm,
          descriptor: beerEstimate?.descriptor ?? wineEstimate?.descriptor ?? '',
          ...(beerEstimate
            ? {
                srm: roundTo(beerEstimate.srm, 1),
                ebc: roundTo(beerEstimate.ebc, 1),
                fitResidual: roundTo(beerEstimate.fitResidual, 3),
              }
            : {}),
          ...(wineEstimate
            ? { colorIntensity: roundTo(wineEstimate.colorIntensity, 2), hue: roundTo(wineEstimate.hue, 2) }
            : {}),
          transmittanceRed: roundTo(transmittance.red, 4),
          transmittanceGreen: roundTo(transmittance.green, 4),
          transmittanceBlue: roundTo(transmittance.blue, 4),
          sampleColor: colorReading.sampleHex,
          paperColor: colorReading.paperHex,
          exposureProblems: colorReading.problems.join(','),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const inputStyle = [styles.pathInput, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  return (
    <ScreenContainer>
      <Card>
        <SectionTitle>{t('howTo.title')}</SectionTitle>
        <BodyText tone="secondary">{t('howTo.container')}</BodyText>
        <BodyText tone="secondary">{t('howTo.light')}</BodyText>
        <BodyText tone="secondary">{t('howTo.markers')}</BodyText>
      </Card>

      <View style={styles.chipRow}>
        {liquidTypes.map((candidateLiquidType) => {
          const isSelected = candidateLiquidType === liquidType;
          return (
            <Pressable
              key={candidateLiquidType}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              onPress={() => handleLiquidTypeChange(candidateLiquidType)}
              style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelected ? 'accent' : 'primary'}>{t(`liquidType.${candidateLiquidType}`)}</BodyText>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.pathRow}>
        <BodyText>{t('pathLength')}</BodyText>
        <TextInput
          value={pathLengthText}
          onChangeText={setPathLengthText}
          keyboardType="decimal-pad"
          accessibilityLabel={t('pathLength')}
          style={inputStyle}
        />
        <BodyText>mm</BodyText>
      </View>
      <BodyText tone={isPathLengthValid ? 'secondary' : 'danger'}>
        {isPathLengthValid
          ? t('pathLengthHint', { recommended: recommendedPathLengthMm[liquidType] })
          : t('pathLengthInvalid')}
      </BodyText>

      <View style={[styles.previewContainer, { borderColor: themePalette.border }]}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device="back"
          isActive={isCameraAllowed}
          outputs={[frameOutput]}
          resizeMode="cover"
          onError={(cameraError) => {
            if (!isExpectedCameraInterruption(cameraError)) {
              setStatusMessage(t('core:common.error', { message: cameraError.message }));
            }
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('placeMarkerHint', { marker: t(`marker.${markerKeys[activeMarkerIndex]}`) })}
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
                    borderWidth: markerIndex === activeMarkerIndex ? 4 : 2,
                  },
                ]}>
                <BodyText style={styles.markerLabel}>{markerIndex === 0 ? 'L' : 'P'}</BodyText>
              </View>
            ) : null,
          )}
        </Pressable>
      </View>

      <BodyText tone="secondary">
        {t('placeMarkerHint', { marker: t(`marker.${markerKeys[activeMarkerIndex]}`) })}
      </BodyText>
      <View style={styles.chipRow}>
        {markerKeys.map((markerKey, markerIndex) => {
          const isActiveMarker = markerIndex === activeMarkerIndex;
          return (
            <Pressable
              key={markerKey}
              accessibilityRole="radio"
              accessibilityState={{ selected: isActiveMarker }}
              onPress={() => setActiveMarkerIndex(markerIndex)}
              style={[styles.chip, { borderColor: isActiveMarker ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isActiveMarker ? 'accent' : placedMarkers[markerIndex] ? 'primary' : 'secondary'}>
                {`${markerIndex === 0 ? 'L' : 'P'} · ${t(`marker.${markerKey}`)}`}
              </BodyText>
            </Pressable>
          );
        })}
      </View>
      <AppButton
        label={t('clearMarkers')}
        onPress={() => {
          setPlacedMarkers([null, null]);
          setActiveMarkerIndex(0);
          resetAverage();
        }}
        variant="secondary"
      />

      <Card>
        {!colorReading ? (
          <BodyText tone="secondary">{t('placeBothMarkers')}</BodyText>
        ) : (
          <>
            <View style={styles.swatchRow}>
              <Swatch label={t('marker.sample')} hexColor={colorReading.sampleHex} />
              <Swatch label={t('marker.paper')} hexColor={colorReading.paperHex} />
            </View>
            {colorReading.beerEstimate ? (
              <View style={styles.resultBlock}>
                <BodyText style={styles.mainValue}>
                  {t('beerResult', {
                    srm: colorReading.beerEstimate.srm.toFixed(1),
                    ebc: colorReading.beerEstimate.ebc.toFixed(1),
                  })}
                </BodyText>
                <BodyText>{t(`beerDescriptor.${colorReading.beerEstimate.descriptor}`)}</BodyText>
                {colorReading.beerEstimate.isFitPoor ? <BodyText tone="danger">{t('poorBeerFit')}</BodyText> : null}
              </View>
            ) : null}
            {colorReading.wineEstimate ? (
              <View style={styles.resultBlock}>
                <BodyText style={styles.mainValue}>{t(`wineDescriptor.${colorReading.wineEstimate.descriptor}`)}</BodyText>
                <BodyText>
                  {t('wineResult', {
                    intensity: colorReading.wineEstimate.colorIntensity.toFixed(2),
                    hue: colorReading.wineEstimate.hue.toFixed(2),
                  })}
                </BodyText>
              </View>
            ) : null}
            <BodyText tone="secondary" style={styles.transmittanceText}>
              {t('transmittance', {
                red: Math.round(colorReading.transmittance.red * 100),
                green: Math.round(colorReading.transmittance.green * 100),
                blue: Math.round(colorReading.transmittance.blue * 100),
              })}
            </BodyText>
            {colorReading.problems.map((problem) => (
              <BodyText key={problem} tone="danger">
                {t(`problem.${problem}`)}
              </BodyText>
            ))}
            <BodyText tone="secondary">{t('approximateNote')}</BodyText>
          </>
        )}
      </Card>

      <AppButton
        label={t('core:common.save')}
        onPress={() => void handleSave()}
        isBusy={isSaving}
        isDisabled={!colorReading}
      />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
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
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  markerLabel: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  pathRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pathInput: { minWidth: 64, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 16 },
  swatchRow: { flexDirection: 'row', justifyContent: 'space-around' },
  swatchColumn: { alignItems: 'center', gap: 4 },
  swatch: { width: 64, height: 64, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  resultBlock: { gap: 4, marginTop: 8, alignItems: 'center' },
  mainValue: { fontSize: 24, fontWeight: '700', textAlign: 'center' },
  transmittanceText: { textAlign: 'center', fontVariant: ['tabular-nums'] },
  privacyNote: { fontSize: 13 },
});
