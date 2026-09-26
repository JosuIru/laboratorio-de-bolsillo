/**
 * Experimento «Albedo de la Tierra»: tras una captura de luz cenicienta, razón de brillos entre
 * una zona en luz cenicienta y otra al Sol (marcadas con el dedo o elegidas solas) y estimación
 * del albedo aparente de la Tierra (`estimateEarthAlbedoFromEarthshine`), con su intervalo y sus
 * supuestos.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Measurement } from '@/core/measurements/types';
import {
  earthshineGeometryAtJulianDay,
  estimateEarthAlbedoFromEarthshine,
  typicalMareToHighlandAlbedoRatio,
} from '@/processing/astronomy/earthshineAlbedo';
import { julianDayFromDate } from '@/processing/astronomy/moonEphemeris';
import type { GrayImage } from '@/processing/image/grayImage';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';

import {
  albedoRatioForPairing,
  chooseAutomaticRegions,
  type ImagePoint,
  measureEarthshineRatio,
  measurementRegionRadiusFraction,
  type TerrainPairing,
} from '../earthshineAlbedoMeasurement';
import { moonInstrumentId } from '../instrumentId';
import { floatRgbFromGray } from '../moonCapturePlanning';
import { ChipSelector, MarkableImage } from '../MoonScreenParts';
import type { MoonMeasurementValues } from '../schema';
import { createSkiaImage } from '../stackedImage';

/** Lo que deja una captura de luz cenicienta para medir. */
export interface EarthshineMeasurementSource {
  shortExposureImage: GrayImage;
  longExposureImage: GrayImage;
  diskRadiusPixels: number;
  /** Relación de tiempos de exposición (la que se pidió a la cámara). */
  nominalExposureRatio: number;
  captureDate: Date;
}

type RegionSelectionMode = 'automatic' | 'manual';
type NextManualRegion = 'dark' | 'sunlit';

const darkMarkerColor = '#38BDF8';
const sunlitMarkerColor = '#FACC15';

interface EarthAlbedoExperimentProps {
  latestEarthshine: EarthshineMeasurementSource | null;
  isBusy: boolean;
  onCaptureEarthshine(): void;
  canCaptureEarthshine: boolean;
  saveExperimentMeasurement(extraValues: Partial<MoonMeasurementValues>): Promise<Measurement<MoonMeasurementValues> | null>;
}

export function EarthAlbedoExperiment({
  latestEarthshine,
  isBusy,
  onCaptureEarthshine,
  canCaptureEarthshine,
  saveExperimentMeasurement,
}: EarthAlbedoExperimentProps) {
  const { t } = useTranslation(moonInstrumentId);
  const [selectionMode, setSelectionMode] = useState<RegionSelectionMode>('automatic');
  const [terrainPairing, setTerrainPairing] = useState<TerrainPairing>('sameTerrain');
  const [manualPoints, setManualPoints] = useState<{ source: EarthshineMeasurementSource; dark: ImagePoint | null; sunlit: ImagePoint | null } | null>(null);
  const [nextManualRegion, setNextManualRegion] = useState<NextManualRegion>('dark');
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const imageSide = latestEarthshine?.longExposureImage.width ?? 0;
  const diskCircle = useMemo(
    () => (latestEarthshine ? { centerX: imageSide / 2, centerY: imageSide / 2, radius: latestEarthshine.diskRadiusPixels } : null),
    [latestEarthshine, imageSide],
  );
  const longExposureSkiaImage = useMemo(
    () => (latestEarthshine ? createSkiaImage(floatRgbFromGray(latestEarthshine.longExposureImage)) : null),
    [latestEarthshine],
  );
  const automaticRegions = useMemo(
    () => (latestEarthshine && diskCircle ? chooseAutomaticRegions(latestEarthshine.shortExposureImage, diskCircle) : null),
    [latestEarthshine, diskCircle],
  );
  const currentManualPoints = manualPoints && manualPoints.source === latestEarthshine ? manualPoints : null;
  const darkPoint = selectionMode === 'automatic' ? (automaticRegions?.darkPoint ?? null) : (currentManualPoints?.dark ?? null);
  const sunlitPoint = selectionMode === 'automatic' ? (automaticRegions?.sunlitPoint ?? null) : (currentManualPoints?.sunlit ?? null);

  const ratioMeasurement = useMemo(() => {
    if (!latestEarthshine || !diskCircle || !darkPoint || !sunlitPoint) return null;
    return measureEarthshineRatio({
      shortExposure: latestEarthshine.shortExposureImage,
      longExposure: latestEarthshine.longExposureImage,
      diskCircle,
      exposureRatio: latestEarthshine.nominalExposureRatio,
      darkPoint,
      sunlitPoint,
    });
  }, [latestEarthshine, diskCircle, darkPoint, sunlitPoint]);

  const albedoEstimate = useMemo(() => {
    if (!latestEarthshine || !ratioMeasurement || 'problem' in ratioMeasurement) return null;
    const geometry = earthshineGeometryAtJulianDay(julianDayFromDate(latestEarthshine.captureDate));
    return {
      geometry,
      estimate: estimateEarthAlbedoFromEarthshine({
        earthshineToSunlitRatio: ratioMeasurement.earthshineToSunlitRatio,
        ratioRelativeUncertainty: ratioMeasurement.ratioRelativeUncertainty,
        lunarPhaseAngleDegrees: geometry.lunarPhaseAngleDegrees,
        darkToSunlitAlbedoRatio: albedoRatioForPairing(terrainPairing, typicalMareToHighlandAlbedoRatio),
        earthMoonDistanceKilometers: geometry.earthMoonDistanceKilometers,
        sunDistanceRatioSquared: geometry.sunDistanceRatioSquared,
      }),
    };
  }, [latestEarthshine, ratioMeasurement, terrainPairing]);

  function handleImagePress(imagePoint: ImagePoint) {
    if (!latestEarthshine || selectionMode !== 'manual') return;
    const previousPoints = currentManualPoints ?? { source: latestEarthshine, dark: null, sunlit: null };
    setManualPoints(nextManualRegion === 'dark' ? { ...previousPoints, dark: imagePoint } : { ...previousPoints, sunlit: imagePoint });
    setNextManualRegion(nextManualRegion === 'dark' ? 'sunlit' : 'dark');
    setSavedMessage(null);
  }

  async function handleSave() {
    if (!albedoEstimate || !ratioMeasurement || 'problem' in ratioMeasurement) return;
    const roundTo = (numericValue: number, fractionDigits: number) => Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    const savedMeasurement = await saveExperimentMeasurement({
      experiment: 'earthAlbedo',
      earthshineRatio: Number(ratioMeasurement.earthshineToSunlitRatio.toPrecision(4)),
      earthshineRatioRelativeUncertainty: roundTo(ratioMeasurement.ratioRelativeUncertainty, 3),
      lunarPhaseAngleDegrees: roundTo(albedoEstimate.geometry.lunarPhaseAngleDegrees, 2),
      earthAlbedo: roundTo(albedoEstimate.estimate.apparentBondAlbedo, 3),
      earthAlbedoLower: roundTo(albedoEstimate.estimate.lowerBound, 3),
      earthAlbedoUpper: roundTo(albedoEstimate.estimate.upperBound, 3),
      exposureRatio: roundTo(latestEarthshine!.nominalExposureRatio, 1),
    });
    setSavedMessage(savedMeasurement ? t('core:instrument.savedMeasurement') : null);
  }

  const regionRadius = (latestEarthshine?.diskRadiusPixels ?? 0) * measurementRegionRadiusFraction;
  const markers = [
    ...(darkPoint ? [{ ...darkPoint, radiusPixels: regionRadius, color: darkMarkerColor }] : []),
    ...(sunlitPoint ? [{ ...sunlitPoint, radiusPixels: regionRadius, color: sunlitMarkerColor }] : []),
  ];

  return (
    <Card>
      <SectionTitle>{t('experiments.albedo.title')}</SectionTitle>
      <BodyText tone="secondary">{t('experiments.albedo.explanation')}</BodyText>
      {!latestEarthshine ? (
        <>
          <BodyText tone="secondary">{t('experiments.albedo.needsEarthshine')}</BodyText>
          <AppButton label={t('captureEarthshine')} onPress={onCaptureEarthshine} isDisabled={isBusy || !canCaptureEarthshine} />
        </>
      ) : (
        <>
          <ChipSelector<RegionSelectionMode>
            options={[
              { value: 'automatic', label: t('experiments.albedo.automatic') },
              { value: 'manual', label: t('experiments.albedo.manual') },
            ]}
            selectedValue={selectionMode}
            onSelect={setSelectionMode}
          />
          {selectionMode === 'manual' ? (
            <BodyText tone="secondary">{t(nextManualRegion === 'dark' ? 'experiments.albedo.tapDark' : 'experiments.albedo.tapSunlit')}</BodyText>
          ) : null}
          {longExposureSkiaImage ? (
            <MarkableImage
              skiaImage={longExposureSkiaImage}
              imageSide={imageSide}
              markers={markers}
              onPressImagePoint={handleImagePress}
              accessibilityLabel={t('experiments.albedo.imageLabel')}
            />
          ) : null}
          <BodyText tone="secondary">{t('experiments.albedo.legend')}</BodyText>
          <BodyText tone="secondary">{t('experiments.albedo.terrainTitle')}</BodyText>
          <ChipSelector<TerrainPairing>
            options={[
              { value: 'sameTerrain', label: t('experiments.albedo.terrain.sameTerrain') },
              { value: 'mareInShadow', label: t('experiments.albedo.terrain.mareInShadow') },
              { value: 'mareInSunlight', label: t('experiments.albedo.terrain.mareInSunlight') },
            ]}
            selectedValue={terrainPairing}
            onSelect={setTerrainPairing}
          />
          {ratioMeasurement && 'problem' in ratioMeasurement ? (
            <BodyText tone="danger">{t(`experiments.albedo.problems.${ratioMeasurement.problem}`)}</BodyText>
          ) : null}
          {ratioMeasurement && !('problem' in ratioMeasurement) && albedoEstimate ? (
            <>
              <BodyText>
                {t('experiments.albedo.result', {
                  albedo: albedoEstimate.estimate.apparentBondAlbedo.toFixed(2),
                  lower: albedoEstimate.estimate.lowerBound.toFixed(2),
                  upper: albedoEstimate.estimate.upperBound.toFixed(2),
                })}
              </BodyText>
              <BodyText tone="secondary">
                {t('experiments.albedo.details', {
                  ratio: ratioMeasurement.earthshineToSunlitRatio.toExponential(2),
                  uncertainty: Math.round(ratioMeasurement.ratioRelativeUncertainty * 100),
                  phase: albedoEstimate.geometry.lunarPhaseAngleDegrees.toFixed(1),
                  earthPhase: Math.round(albedoEstimate.estimate.earthIlluminatedFraction * 100),
                  exposureRatio: Math.round(latestEarthshine.nominalExposureRatio),
                })}
              </BodyText>
              <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isDisabled={isBusy} />
              {savedMessage ? <BodyText tone="secondary">{savedMessage}</BodyText> : null}
            </>
          ) : null}
          {!automaticRegions && selectionMode === 'automatic' ? (
            <BodyText tone="danger">{t('experiments.albedo.noAutomaticRegions')}</BodyText>
          ) : null}
          <BodyText tone="secondary">{t('experiments.albedo.assumptions')}</BodyText>
          <AppButton label={t('experiments.albedo.captureAgain')} onPress={onCaptureEarthshine} isDisabled={isBusy || !canCaptureEarthshine} variant="secondary" />
        </>
      )}
    </Card>
  );
}
