import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import {
  computeTareOffset,
  estimateMass,
  type MassEstimate,
  type ScaleModel,
  relativeAmplitudeSpread,
  responseMeasurementFromAnalysis,
} from '@/processing/resonanceScale/massCalibration';
import type { PulseResponseAnalysis } from '@/processing/resonanceScale/pulseResponse';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { ResonanceScaleCalibrationParameters } from './calibration';
import { MeasurementStatus, PulseSpectrum } from './components';
import { formatGrams, funEquivalences, irregularPulseSpreadThreshold } from './formatting';
import { resonanceScaleInstrumentId } from './instrumentId';
import type { ResonanceScaleMeasurementValues } from './schema';
import { usePulseMeasurement } from './usePulseMeasurement';

export { resonanceScaleInstrumentId };

type MeasurementPurpose = 'weigh' | 'tare';

interface SessionResult {
  sequenceNumber: number;
  amplitudeRms: number;
  massEstimate: MassEstimate | null;
}

const maximumSessionResults = 8;

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function isSameScaleModel(firstModel: ScaleModel, secondModel: ScaleModel): boolean {
  return (
    firstModel.feature === secondModel.feature &&
    firstModel.intercept === secondModel.intercept &&
    firstModel.slope === secondModel.slope
  );
}

export function ResonanceScaleScreen({
  calibrationParameters,
  saveMeasurement,
}: InstrumentScreenProps<ResonanceScaleMeasurementValues, ResonanceScaleCalibrationParameters>) {
  const { t } = useTranslation(resonanceScaleInstrumentId);
  const themePalette = useThemePalette();
  const scaleModel = calibrationParameters?.model ?? null;
  const [measurementPurpose, setMeasurementPurpose] = useState<MeasurementPurpose>('weigh');
  const [lastAnalysis, setLastAnalysis] = useState<PulseResponseAnalysis | null>(null);
  const [lastPurpose, setLastPurpose] = useState<MeasurementPurpose>('weigh');
  const [analysisRevision, setAnalysisRevision] = useState(0);
  /**
   * Tara y modelo con el que se midió: el desfase solo vale para ese modelo (rasgo, ordenada y
   * pendiente). Si la calibración cambia mientras la pantalla sigue montada, la tara se descarta.
   * `driftGrams` es cuántos gramos «pesaba» el móvil vacío antes de la tara (deriva de la superficie).
   */
  const [tare, setTare] = useState<{ model: ScaleModel; offset: number | null; driftGrams: number | null } | null>(null);
  const activeTare = tare && scaleModel && isSameScaleModel(tare.model, scaleModel) ? tare : null;
  const tareOffset = activeTare?.offset ?? null;
  const tareDriftGrams = activeTare?.driftGrams ?? null;
  const [sessionResults, setSessionResults] = useState<SessionResult[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const { measurementState, startMeasurement, cancelMeasurement } = usePulseMeasurement({
    onMeasured: (analysis) => {
      const responseMeasurement = responseMeasurementFromAnalysis(analysis);
      setLastAnalysis(analysis);
      setLastPurpose(measurementPurpose);
      setAnalysisRevision((previousRevision) => previousRevision + 1);
      if (measurementPurpose === 'tare' && scaleModel) {
        setTare({
          model: scaleModel,
          offset: computeTareOffset(scaleModel, responseMeasurement),
          driftGrams: estimateMass(scaleModel, responseMeasurement)?.massGrams ?? null,
        });
        return;
      }
      const massEstimate = scaleModel ? estimateMass(scaleModel, responseMeasurement, tareOffset ?? 0) : null;
      setSessionResults((previousResults) =>
        [
          {
            sequenceNumber: (previousResults[0]?.sequenceNumber ?? 0) + 1,
            amplitudeRms: analysis.amplitudeRms,
            massEstimate,
          },
          ...previousResults,
        ].slice(0, maximumSessionResults),
      );
    },
  });
  const isMeasuring = measurementState.status === 'measuring';

  const lastMeasurement = lastAnalysis ? responseMeasurementFromAnalysis(lastAnalysis) : null;
  const lastEstimate =
    lastPurpose === 'weigh' && scaleModel && lastMeasurement
      ? estimateMass(scaleModel, lastMeasurement, tareOffset ?? 0)
      : null;
  const lastSpread = lastMeasurement ? relativeAmplitudeSpread(lastMeasurement) : null;
  const equivalences = lastEstimate ? funEquivalences(lastEstimate.massGrams) : null;
  const firstSessionAmplitude = sessionResults[sessionResults.length - 1]?.amplitudeRms ?? null;

  function measure(purpose: MeasurementPurpose) {
    setMeasurementPurpose(purpose);
    setStatusMessage(null);
    startMeasurement();
  }

  async function handleSave() {
    if (!lastAnalysis || lastPurpose !== 'weigh') return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          ...(lastEstimate && scaleModel
            ? {
                estimatedMassGrams: roundTo(lastEstimate.massGrams, 1),
                massUncertaintyGrams: roundTo(lastEstimate.expandedUncertaintyGrams, 1),
                isExtrapolated: lastEstimate.isExtrapolated,
                modelFeature: scaleModel.feature,
              }
            : {}),
          isTared: tareOffset !== null,
          amplitudeRms: roundTo(lastAnalysis.amplitudeRms, 4),
          amplitudeSpreadRms: roundTo(lastAnalysis.amplitudeSpreadRms, 4),
          ...(lastAnalysis.peakFrequencyHz !== null ? { peakFrequencyHz: roundTo(lastAnalysis.peakFrequencyHz, 1) } : {}),
          pulseCount: lastAnalysis.pulses.length,
          sampleRateHz: Math.round(lastAnalysis.sampleRateHz),
          noiseRms: roundTo(lastAnalysis.noiseRms, 4),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScreenContainer>
      <Card style={styles.resultCard}>
        {lastEstimate ? (
          <>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('result.estimatedMass')}
            </BodyText>
            <View accessibilityLiveRegion="polite">
              <BodyText style={styles.massValue} tone={lastEstimate.isExtrapolated ? 'danger' : 'primary'}>
                {`≈ ${formatGrams(lastEstimate.massGrams)} g`}
              </BodyText>
            </View>
            <BodyText tone="secondary">
              {t('result.uncertainty', { grams: formatGrams(lastEstimate.expandedUncertaintyGrams) })}
            </BodyText>
            {equivalences ? (
              <BodyText tone="accent">
                {t('result.equivalences', {
                  coins: equivalences.oneEuroCoins.toLocaleString(),
                  sheets: equivalences.a4Sheets.toLocaleString(),
                })}
              </BodyText>
            ) : null}
            {lastEstimate.isExtrapolated ? <BodyText tone="danger">{t('result.extrapolated')}</BodyText> : null}
            {lastEstimate.massGrams < -lastEstimate.expandedUncertaintyGrams ? (
              <BodyText tone="danger">{t('result.negative')}</BodyText>
            ) : null}
          </>
        ) : lastAnalysis && lastPurpose === 'tare' ? (
          <BodyText tone="accent" style={styles.emphasis}>
            {tareDriftGrams === null
              ? t('result.tareDone')
              : t('result.tareDoneWithDrift', { grams: formatGrams(tareDriftGrams) })}
          </BodyText>
        ) : lastAnalysis ? (
          <>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('fields.amplitude')}
            </BodyText>
            <BodyText style={styles.massValue}>{`${lastAnalysis.amplitudeRms.toFixed(3)} m/s²`}</BodyText>
            <BodyText tone="secondary">{t('result.uncalibrated')}</BodyText>
          </>
        ) : (
          <BodyText tone="secondary" style={styles.centeredText}>
            {scaleModel ? t('result.readyCalibrated') : t('result.readyUncalibrated')}
          </BodyText>
        )}
      </Card>

      <MeasurementStatus measurementState={measurementState} onCancel={cancelMeasurement} />
      {!isMeasuring && lastSpread !== null && lastSpread > irregularPulseSpreadThreshold ? (
        <BodyText tone="danger">{t('irregularPulses', { percent: Math.round(lastSpread * 100) })}</BodyText>
      ) : null}

      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton label={t('weigh')} onPress={() => measure('weigh')} isDisabled={isMeasuring} />
        </View>
        {scaleModel ? (
          <View style={styles.buttonCell}>
            <AppButton label={t('tare')} onPress={() => measure('tare')} variant="secondary" isDisabled={isMeasuring} />
          </View>
        ) : null}
      </View>
      {scaleModel ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {tareOffset === null ? t('tareHelp') : t('tareActive')}
        </BodyText>
      ) : null}
      <AppButton
        label={t('core:common.save')}
        onPress={() => void handleSave()}
        variant="secondary"
        isBusy={isSaving}
        isDisabled={isMeasuring || !lastAnalysis || lastPurpose !== 'weigh'}
      />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      {lastAnalysis ? (
        <Card>
          <SectionTitle>{t('details.title')}</SectionTitle>
          <PulseSpectrum analysis={lastAnalysis} revision={analysisRevision} />
          <BodyText tone="secondary" style={styles.smallText}>
            {t('details.spectrumHelp')}
          </BodyText>
          <BodyText style={styles.detailText}>
            {t('details.amplitude', {
              amplitude: lastAnalysis.amplitudeRms.toFixed(3),
              spread: lastAnalysis.amplitudeSpreadRms.toFixed(3),
            })}
          </BodyText>
          <BodyText style={styles.detailText}>
            {lastAnalysis.peakFrequencyHz === null
              ? t('details.noFrequency')
              : t('details.frequency', { frequency: lastAnalysis.peakFrequencyHz.toFixed(1) })}
          </BodyText>
          <BodyText tone="secondary" style={styles.detailText}>
            {t('details.acquisition', {
              pulses: lastAnalysis.pulses.length,
              rate: Math.round(lastAnalysis.sampleRateHz),
              noise: lastAnalysis.noiseRms.toFixed(3),
            })}
          </BodyText>
        </Card>
      ) : null}

      {sessionResults.length > 1 ? (
        <Card>
          <SectionTitle>{t('compare.title')}</SectionTitle>
          {sessionResults.map((sessionResult) => {
            const amplitudeChangePercent =
              firstSessionAmplitude !== null ? (sessionResult.amplitudeRms / firstSessionAmplitude - 1) * 100 : 0;
            return (
              <BodyText key={sessionResult.sequenceNumber} style={styles.detailText}>
                {t('compare.row', {
                  number: sessionResult.sequenceNumber,
                  mass: sessionResult.massEstimate
                    ? `≈ ${formatGrams(sessionResult.massEstimate.massGrams)} ± ${formatGrams(sessionResult.massEstimate.expandedUncertaintyGrams)} g`
                    : '—',
                  amplitude: sessionResult.amplitudeRms.toFixed(3),
                  change: `${amplitudeChangePercent >= 0 ? '+' : ''}${amplitudeChangePercent.toFixed(1)}`,
                })}
              </BodyText>
            );
          })}
          <BodyText tone="secondary" style={styles.smallText}>
            {t('compare.help')}
          </BodyText>
        </Card>
      ) : null}

      <Card>
        <SectionTitle>{t('howTo.title')}</SectionTitle>
        <BodyText>{t('howTo.steps')}</BodyText>
        <BodyText tone="accent">{t('howTo.challenge')}</BodyText>
      </Card>

      {!scaleModel ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {t('uncalibratedHint')}
        </BodyText>
      ) : null}
      <View style={[styles.honestyBox, { borderColor: themePalette.border }]}>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('honestyNote')}
        </BodyText>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  resultCard: { alignItems: 'center', paddingVertical: 20, gap: 4, minHeight: 120, justifyContent: 'center' },
  massValue: { fontSize: 44, lineHeight: 52, fontWeight: '700', fontVariant: ['tabular-nums'] },
  smallText: { fontSize: 13 },
  emphasis: { fontWeight: '600', textAlign: 'center' },
  centeredText: { textAlign: 'center' },
  detailText: { fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  honestyBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12 },
});
