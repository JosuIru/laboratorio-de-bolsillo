import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { constellationDisplayOrder, constellationShortLabels } from '@/processing/gnss/constellations';
import type { InterferenceAssessment } from '@/processing/gnss/interferenceDetector';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { CarrierToNoiseBars } from './CarrierToNoiseBars';
import { constellationColors } from './constellationColors';
import { gnssSkyInstrumentId } from './instrumentId';
import type { GnssSkyMeasurementValues } from './schema';
import { SkyPlot } from './SkyPlot';
import { type GnssSkySnapshot, type GnssSupport, historyLengthSeconds, useGnssSky } from './useGnssSky';

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function largestAutomaticGainControlDrop(assessment: InterferenceAssessment | null): number | null {
  if (!assessment || assessment.automaticGainControlDrops.length === 0) return null;
  return Math.max(...assessment.automaticGainControlDrops.map((agcDrop) => agcDrop.dropDb));
}

export function GnssSkyScreen({ saveMeasurement }: InstrumentScreenProps<GnssSkyMeasurementValues>) {
  const { t } = useTranslation(gnssSkyInstrumentId);
  const { support, snapshot, startErrorMessage, requestFineLocation, refreshSupport } = useGnssSky();
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (support.status !== 'ready') {
    return (
      <UnsupportedState
        support={support}
        onRequestPermission={() => void requestFineLocation()}
        onRetry={refreshSupport}
        errorMessage={startErrorMessage}
      />
    );
  }

  async function handleSave() {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const { skySummary, assessment, rawMeasurementsSummary, horizontalAccuracyMeters } = snapshot;
      const largestAgcDropDb = largestAutomaticGainControlDrop(assessment);
      await saveMeasurement({
        values: {
          trackedSatelliteCount: skySummary.trackedSatelliteCount,
          usedInFixSignalCount: skySummary.usedInFixSignalCount,
          constellationCount: skySummary.countsByConstellation.length,
          isDualFrequency: skySummary.isDualFrequency,
          ...(skySummary.topFourMeanCarrierToNoiseDbHz !== null
            ? { topFourMeanCarrierToNoiseDbHz: roundToTenth(skySummary.topFourMeanCarrierToNoiseDbHz) }
            : {}),
          interferenceLevel: !assessment || assessment.status === 'learning' ? 'learning' : assessment.level,
          ...(assessment?.medianCarrierToNoiseDropDb != null
            ? { medianCarrierToNoiseDropDb: roundToTenth(assessment.medianCarrierToNoiseDropDb) }
            : {}),
          ...(largestAgcDropDb !== null ? { largestAutomaticGainControlDropDb: roundToTenth(largestAgcDropDb) } : {}),
          hasAutomaticGainControl: assessment?.hasAutomaticGainControlData ?? false,
          ...(rawMeasurementsSummary ? { multipathDetectedCount: rawMeasurementsSummary.multipathDetectedCount } : {}),
          ...(horizontalAccuracyMeters !== null ? { horizontalAccuracyMeters: roundToTenth(horizontalAccuracyMeters) } : {}),
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
      {startErrorMessage ? <BodyText tone="danger">{t('startError', { message: startErrorMessage })}</BodyText> : null}
      {snapshot.epochCount === 0 ? (
        <Card>
          <LoadingState label={t('waitingForSatellites')} />
        </Card>
      ) : null}

      <InterferenceCard assessment={snapshot.assessment} />

      <Card>
        <SectionTitle>{t('sky.title')}</SectionTitle>
        <SkyPlot
          observations={snapshot.observations}
          accessibilityLabel={t('sky.accessibility', { count: snapshot.skySummary.trackedSatelliteCount })}
          cardinalLabels={{ north: t('sky.north'), east: t('sky.east'), south: t('sky.south'), west: t('sky.west') }}
        />
        <ConstellationLegend />
        <BodyText tone="secondary" style={styles.smallText}>
          {t('sky.legend')}
        </BodyText>
      </Card>

      <CountsCard snapshot={snapshot} />

      <Card>
        <SectionTitle>{t('bars.title')}</SectionTitle>
        <CarrierToNoiseBars observations={snapshot.observations} accessibilityLabel={t('bars.title')} />
        <BodyText tone="secondary" style={styles.smallText}>
          {t('bars.help')}
        </BodyText>
      </Card>

      <HistoryCharts snapshot={snapshot} />

      <RawMeasurementsCard snapshot={snapshot} hardwareModelName={support.capabilities.gnssHardwareModelName} />

      <AppButton
        label={t('core:common.save')}
        onPress={() => void handleSave()}
        isBusy={isSaving}
        isDisabled={snapshot.epochCount === 0}
      />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <BodyText tone="secondary" style={styles.smallText}>
        {t('howTo')}
      </BodyText>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('honestyNote')}
      </BodyText>
    </ScreenContainer>
  );
}

function UnsupportedState({
  support,
  onRequestPermission,
  onRetry,
  errorMessage,
}: {
  support: Exclude<GnssSupport, { status: 'ready' }>;
  onRequestPermission(): void;
  onRetry(): void;
  errorMessage: string | null;
}) {
  const { t } = useTranslation(gnssSkyInstrumentId);
  return (
    <ScreenContainer>
      <Card>
        {support.status === 'unsupported-platform' ? <BodyText>{t('unsupported.platform')}</BodyText> : null}
        {support.status === 'module-missing' ? <BodyText>{t('unsupported.module')}</BodyText> : null}
        {support.status === 'no-hardware' ? <BodyText>{t('unsupported.hardware')}</BodyText> : null}
        {support.status === 'location-off' ? (
          <>
            <BodyText>{t('locationOff')}</BodyText>
            <AppButton label={t('retry')} onPress={onRetry} variant="secondary" />
          </>
        ) : null}
        {support.status === 'needs-fine-location' ? (
          <>
            <BodyText>{t('permission.explanation')}</BodyText>
            {support.canAskAgain ? (
              <AppButton label={t('permission.request')} onPress={onRequestPermission} />
            ) : (
              <AppButton label={t('permission.openSettings')} onPress={() => void Linking.openSettings()} />
            )}
            <AppButton label={t('retry')} onPress={onRetry} variant="secondary" />
          </>
        ) : null}
        {errorMessage ? <BodyText tone="danger">{errorMessage}</BodyText> : null}
      </Card>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('description')}
      </BodyText>
    </ScreenContainer>
  );
}

function InterferenceCard({ assessment }: { assessment: InterferenceAssessment | null }) {
  const { t } = useTranslation(gnssSkyInstrumentId);
  const themePalette = useThemePalette();
  const level = assessment?.status === 'monitoring' ? assessment.level : null;
  const borderColor =
    level === 'likely' ? themePalette.danger : level === 'possible' ? themePalette.accent : themePalette.border;

  let headline: string;
  if (!assessment) headline = t('interference.waiting');
  else if (assessment.status === 'learning') {
    headline = t('interference.learning', { percent: Math.round(assessment.learningProgress * 100) });
  } else headline = t(`interference.level.${assessment.level}`);

  return (
    <Card style={{ borderColor, borderWidth: level && level !== 'none' ? 2 : StyleSheet.hairlineWidth }}>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('interference.title')}
      </BodyText>
      <View accessibilityLiveRegion="polite">
        <BodyText style={styles.headline} tone={level === 'likely' ? 'danger' : level === 'possible' ? 'accent' : 'primary'}>
          {headline}
        </BodyText>
      </View>
      {assessment && assessment.status === 'monitoring' ? (
        <>
          {assessment.medianCarrierToNoiseDropDb !== null ? (
            <BodyText tone="secondary">
              {t('interference.carrierToNoiseDrop', {
                drop: assessment.medianCarrierToNoiseDropDb.toFixed(1),
                percent: Math.round((assessment.droppedSignalFraction ?? 0) * 100),
                count: assessment.commonSignalCount,
              })}
            </BodyText>
          ) : null}
          {assessment.retainedSignalFraction !== null ? (
            <BodyText tone="secondary">
              {t(assessment.isSkyStable ? 'interference.skyStable' : 'interference.skyChanged', {
                percent: Math.round(assessment.retainedSignalFraction * 100),
              })}
            </BodyText>
          ) : null}
          {assessment.hasAutomaticGainControlData ? (
            assessment.automaticGainControlDrops.map((agcDrop) => (
              <BodyText key={agcDrop.bandId} tone="secondary">
                {t('interference.agcBand', {
                  band: agcDrop.bandId,
                  level: agcDrop.currentLevelDb.toFixed(1),
                  drop: agcDrop.dropDb.toFixed(1),
                })}
              </BodyText>
            ))
          ) : (
            <BodyText tone="secondary">{t('interference.noAgc')}</BodyText>
          )}
          {assessment.isBaselineFrozen ? <BodyText tone="secondary">{t('interference.frozen')}</BodyText> : null}
        </>
      ) : null}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('interference.help')}
      </BodyText>
    </Card>
  );
}

function ConstellationLegend() {
  const themePalette = useThemePalette();
  return (
    <View style={styles.legendRow}>
      {constellationDisplayOrder
        .filter((constellationId) => constellationId !== 'unknown')
        .map((constellationId) => (
          <View key={constellationId} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: constellationColors[constellationId] }]} />
            <BodyText style={{ ...styles.smallText, color: themePalette.textSecondary }}>
              {constellationShortLabels[constellationId]}
            </BodyText>
          </View>
        ))}
    </View>
  );
}

function CountsCard({ snapshot }: { snapshot: GnssSkySnapshot }) {
  const { t } = useTranslation(gnssSkyInstrumentId);
  const { skySummary } = snapshot;
  return (
    <Card>
      <SectionTitle>{t('counts.title')}</SectionTitle>
      <BodyText>
        {t('counts.summary', {
          tracked: skySummary.trackedSatelliteCount,
          signals: skySummary.trackedSignalCount,
          used: skySummary.usedInFixSignalCount,
          listed: skySummary.listedSignalCount,
        })}
      </BodyText>
      {skySummary.countsByConstellation.map((constellationCount) => (
        <View key={constellationCount.groupId} style={styles.countRow}>
          <View style={[styles.legendSwatch, { backgroundColor: constellationColors[constellationCount.groupId] }]} />
          <BodyText style={styles.countLabel}>{constellationShortLabels[constellationCount.groupId]}</BodyText>
          <BodyText tone="secondary">
            {t('counts.row', { tracked: constellationCount.trackedCount, used: constellationCount.usedInFixCount })}
          </BodyText>
        </View>
      ))}
      {skySummary.countsByBand.length > 0 ? (
        <BodyText tone="secondary">
          {t('counts.bands', {
            bands: skySummary.countsByBand.map((bandCount) => `${bandCount.groupId} ${bandCount.trackedCount}`).join(' · '),
          })}
        </BodyText>
      ) : null}
      <BodyText tone={skySummary.isDualFrequency ? 'accent' : 'secondary'}>
        {skySummary.isDualFrequency
          ? t('counts.dualFrequencyYes', { count: skySummary.dualFrequencySatelliteCount })
          : t('counts.dualFrequencyNo')}
      </BodyText>
      {skySummary.topFourMeanCarrierToNoiseDbHz !== null ? (
        <BodyText tone="secondary">{t('counts.topFour', { value: skySummary.topFourMeanCarrierToNoiseDbHz.toFixed(1) })}</BodyText>
      ) : null}
      {snapshot.horizontalAccuracyMeters !== null ? (
        <BodyText tone="secondary">{t('counts.accuracy', { meters: snapshot.horizontalAccuracyMeters.toFixed(1) })}</BodyText>
      ) : null}
      {snapshot.timeToFirstFixSeconds !== null ? (
        <BodyText tone="secondary">{t('counts.timeToFirstFix', { seconds: snapshot.timeToFirstFixSeconds.toFixed(1) })}</BodyText>
      ) : null}
    </Card>
  );
}

function HistoryCharts({ snapshot }: { snapshot: GnssSkySnapshot }) {
  const { t } = useTranslation(gnssSkyInstrumentId);
  const themePalette = useThemePalette();
  if (snapshot.topFourHistory.length < 2) return null;
  const horizontalLabels: [string, string] = [`−${historyLengthSeconds} s`, t('now')];
  return (
    <>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('history.carrierToNoise')}
      </BodyText>
      <SignalChart
        series={[{ values: snapshot.topFourHistory, color: themePalette.accent }]}
        height={110}
        verticalRange={{ mode: 'fixed', minimum: 0, maximum: 55 }}
        revision={snapshot.epochCount}
        unitLabel="dB-Hz"
        horizontalLabels={horizontalLabels}
        accessibilityLabel={t('history.carrierToNoise')}
      />
      {snapshot.automaticGainControlHistory.length >= 2 ? (
        <>
          <BodyText tone="secondary" style={styles.smallText}>
            {t('history.automaticGainControl')}
          </BodyText>
          <SignalChart
            series={[{ values: snapshot.automaticGainControlHistory, color: themePalette.danger }]}
            height={90}
            verticalRange={{ mode: 'symmetric', minimumHalfRange: 10 }}
            revision={snapshot.epochCount}
            unitLabel="dB"
            horizontalLabels={horizontalLabels}
            accessibilityLabel={t('history.automaticGainControl')}
          />
        </>
      ) : null}
    </>
  );
}

function RawMeasurementsCard({
  snapshot,
  hardwareModelName,
}: {
  snapshot: GnssSkySnapshot;
  hardwareModelName: string | null;
}) {
  const { t } = useTranslation(gnssSkyInstrumentId);
  const { rawMeasurementsSummary, rawMeasurementsStatus } = snapshot;
  return (
    <Card>
      <SectionTitle>{t('raw.title')}</SectionTitle>
      <BodyText tone="secondary">{t(`raw.status.${rawMeasurementsStatus ?? 'waiting'}`)}</BodyText>
      {rawMeasurementsSummary ? (
        <>
          <BodyText>
            {t('raw.summary', {
              count: rawMeasurementsSummary.measurementCount,
              pseudoranges: rawMeasurementsSummary.pseudorangeCount,
            })}
          </BodyText>
          {rawMeasurementsSummary.pseudorangeKilometersRange ? (
            <BodyText tone="secondary">
              {t('raw.pseudorangeRange', {
                minimum: Math.round(rawMeasurementsSummary.pseudorangeKilometersRange.minimum).toLocaleString(),
                maximum: Math.round(rawMeasurementsSummary.pseudorangeKilometersRange.maximum).toLocaleString(),
              })}
            </BodyText>
          ) : null}
          <BodyText tone="secondary">{t('raw.multipath', { count: rawMeasurementsSummary.multipathDetectedCount })}</BodyText>
        </>
      ) : null}
      {hardwareModelName ? <BodyText tone="secondary">{t('raw.hardware', { model: hardwareModelName })}</BodyText> : null}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('raw.help')}
      </BodyText>
    </Card>
  );
}

const styles = StyleSheet.create({
  smallText: { fontSize: 13, lineHeight: 18 },
  headline: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 10, height: 10, borderRadius: 5 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  countLabel: { minWidth: 70 },
});
