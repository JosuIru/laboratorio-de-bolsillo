/**
 * Experimento «Tamaño de la Luna (ilusión lunar y superluna)»: se mide el diámetro del disco en
 * cada resultado (ajuste subpíxel), se guarda y se compara la serie de todas las sesiones con el
 * tamaño predicho para cada momento (`predictLunarApparentSize`, `analyzeApparentSizeSeries`).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Measurement } from '@/core/measurements/types';
import { analyzeApparentSizeSeries, predictLunarApparentSize } from '@/processing/astronomy/lunarApparentSize';
import type { ObserverLocation } from '@/processing/astronomy/moonEphemeris';
import type { GrayImage } from '@/processing/image/grayImage';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';

import {
  measureDiameterForSizeExperiment,
  mergeSizeSeries,
  type SizeExperimentMeasurement,
  sizeMeasurementsFromHistory,
  type SizeScaleSource,
} from '../apparentSizeExperiment';
import { moonInstrumentId } from '../instrumentId';
import type { MoonMeasurementValues } from '../schema';

/** Lo que hace falta de un resultado para medir su diámetro. */
export interface SizeMeasurementSource {
  grayImage: GrayImage;
  resultPixelsPerCommonPixel: number;
  source: SizeScaleSource;
  captureDate: Date;
}

interface ApparentSizeExperimentProps {
  observerLocation: ObserverLocation | null;
  /** Último resultado medible (ráfaga, trípode o RAW, a simple vista), o null. */
  latestSizeSource: SizeMeasurementSource | null;
  isBusy: boolean;
  /** Toma una ráfaga normal y devuelve lo necesario para medir (null si falla). */
  onCaptureForSize(): Promise<SizeMeasurementSource | null>;
  saveExperimentMeasurement(extraValues: Partial<MoonMeasurementValues>): Promise<Measurement<MoonMeasurementValues> | null>;
}

const historyLimit = 500;

export function ApparentSizeExperiment({
  observerLocation,
  latestSizeSource,
  isBusy,
  onCaptureForSize,
  saveExperimentMeasurement,
}: ApparentSizeExperimentProps) {
  const { t, i18n } = useTranslation(moonInstrumentId);
  const [historyMeasurements, setHistoryMeasurements] = useState<SizeExperimentMeasurement[]>([]);
  const [unsavedMeasurements, setUnsavedMeasurements] = useState<SizeExperimentMeasurement[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isMeasuring, setIsMeasuring] = useState(false);
  const [measuredSource, setMeasuredSource] = useState<SizeMeasurementSource | null>(null);

  // Medidas guardadas en otras sesiones (el repositorio se carga aquí: usa SQLite, que no existe
  // en los tests que importan todos los instrumentos).
  useEffect(() => {
    let isCancelled = false;
    void import('@/core/measurements/sqliteMeasurementRepository')
      .then(({ sqliteMeasurementRepository }) => sqliteMeasurementRepository.listByInstrument(moonInstrumentId, { limit: historyLimit, offset: 0 }))
      .then((storedMeasurements) => {
        if (!isCancelled) setHistoryMeasurements(sizeMeasurementsFromHistory(storedMeasurements as Measurement<MoonMeasurementValues>[]));
      })
      .catch(() => {
        // Sin historial se sigue con las medidas de esta sesión.
      });
    return () => {
      isCancelled = true;
    };
  }, []);

  const series = useMemo(() => mergeSizeSeries(unsavedMeasurements, historyMeasurements), [unsavedMeasurements, historyMeasurements]);
  const analysis = useMemo(
    () => (observerLocation && series.length >= 3 ? analyzeApparentSizeSeries(series, observerLocation) : null),
    [observerLocation, series],
  );
  const predictions = useMemo(
    () => (observerLocation ? series.map((measurement) => predictLunarApparentSize(observerLocation, measurement.date)) : []),
    [observerLocation, series],
  );

  async function measureAndSave(sizeSource: SizeMeasurementSource) {
    const diameterMeasurement = measureDiameterForSizeExperiment(sizeSource.grayImage, sizeSource.resultPixelsPerCommonPixel);
    if (!diameterMeasurement) {
      setStatusMessage(t('experiments.size.diskNotFound'));
      return;
    }
    const prediction = observerLocation ? predictLunarApparentSize(observerLocation, sizeSource.captureDate) : null;
    const newMeasurement: SizeExperimentMeasurement = {
      date: sizeSource.captureDate,
      diameterPixels: diameterMeasurement.diameterPixels,
      diameterUncertaintyPixels: diameterMeasurement.diameterUncertaintyPixels,
      source: sizeSource.source,
    };
    setMeasuredSource(sizeSource);
    setStatusMessage(
      t('experiments.size.measured', {
        diameter: diameterMeasurement.diameterPixels.toFixed(2),
        uncertainty: diameterMeasurement.diameterUncertaintyPixels.toFixed(2),
      }),
    );
    const savedMeasurement = await saveExperimentMeasurement({
      experiment: 'apparentSize',
      measuredDiameterPixels: Math.round(diameterMeasurement.diameterPixels * 1000) / 1000,
      diameterUncertaintyPixels: Math.round(diameterMeasurement.diameterUncertaintyPixels * 1000) / 1000,
      sizeScaleSource: sizeSource.source,
      ...(prediction ? { predictedDiameterArcminutes: Math.round(prediction.topocentricDiameterArcminutes * 1000) / 1000 } : {}),
    });
    if (savedMeasurement) {
      setHistoryMeasurements((previousMeasurements) => [...previousMeasurements, { ...newMeasurement, date: new Date(savedMeasurement.timestamp) }]);
    } else {
      setUnsavedMeasurements((previousMeasurements) => [...previousMeasurements, newMeasurement]);
    }
  }

  async function handleCaptureAndMeasure() {
    setIsMeasuring(true);
    setStatusMessage(null);
    try {
      const sizeSource = await onCaptureForSize();
      if (sizeSource) await measureAndSave(sizeSource);
    } finally {
      setIsMeasuring(false);
    }
  }

  const canMeasureLatest = latestSizeSource !== null && latestSizeSource !== measuredSource;
  const formatDateTime = (date: Date) =>
    date.toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <Card>
      <SectionTitle>{t('experiments.size.title')}</SectionTitle>
      <BodyText tone="secondary">{t('experiments.size.explanation')}</BodyText>
      {!observerLocation ? <BodyText tone="danger">{t('experiments.size.needsLocation')}</BodyText> : null}
      <AppButton
        label={t('experiments.size.captureAndMeasure')}
        onPress={() => void handleCaptureAndMeasure()}
        isBusy={isMeasuring}
        isDisabled={isBusy || !observerLocation}
      />
      {canMeasureLatest ? (
        <AppButton
          label={t('experiments.size.measureLatest')}
          onPress={() => void measureAndSave(latestSizeSource)}
          isDisabled={isBusy || isMeasuring || !observerLocation}
          variant="secondary"
        />
      ) : null}
      {statusMessage ? <BodyText>{statusMessage}</BodyText> : null}

      {series.length > 0 ? (
        <>
          <BodyText tone="secondary">
            {t(series[0]?.source === 'raw' ? 'experiments.size.seriesTitleRaw' : 'experiments.size.seriesTitleJpeg', { count: series.length })}
          </BodyText>
          {series.map((measurement, measurementIndex) => {
            const prediction = predictions[measurementIndex];
            return (
              <View key={`${measurement.date.getTime()}-${measurementIndex}`} style={styles.seriesRow}>
                <BodyText tone="secondary" style={styles.seriesText}>
                  {t('experiments.size.seriesRow', {
                    date: formatDateTime(measurement.date),
                    diameter: measurement.diameterPixels.toFixed(2),
                    uncertainty: measurement.diameterUncertaintyPixels.toFixed(2),
                    altitude: prediction ? Math.round(prediction.altitudeDegrees) : '—',
                    predicted: prediction ? prediction.topocentricDiameterArcminutes.toFixed(2) : '—',
                  })}
                </BodyText>
              </View>
            );
          })}
        </>
      ) : null}

      {analysis ? (
        <>
          <BodyText>{t(`experiments.size.verdict.${analysis.moonIllusionVerdict}`)}</BodyText>
          <BodyText tone="secondary">
            {t('experiments.size.growth', {
              measured: (100 * analysis.measuredGrowthPerSineAltitude).toFixed(2),
              uncertainty: (100 * analysis.measuredGrowthPerSineAltitudeUncertainty).toFixed(2),
              predicted: (100 * analysis.predictedGrowthPerSineAltitude).toFixed(2),
              lowToHigh: analysis.predictedLowToHighPercent.toFixed(2),
            })}
          </BodyText>
          <BodyText tone="secondary">
            {t('experiments.size.scale', {
              scale: analysis.fittedArcsecondsPerPixel.toFixed(2),
              uncertainty: analysis.fittedArcsecondsPerPixelUncertainty.toFixed(2),
              chiSquared: analysis.reducedChiSquared.toFixed(1),
            })}
          </BodyText>
        </>
      ) : series.length > 0 ? (
        <BodyText tone="secondary">{t('experiments.size.needMore', { count: Math.max(0, 3 - series.length) })}</BodyText>
      ) : null}
      <BodyText tone="secondary">{t('experiments.size.tips')}</BodyText>
    </Card>
  );
}

const styles = StyleSheet.create({
  seriesRow: { flexDirection: 'row' },
  seriesText: { fontVariant: ['tabular-nums'] },
});
