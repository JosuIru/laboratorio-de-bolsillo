import { File, Paths } from 'expo-file-system';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { SeismographMeasurementValues } from './schema';
import { formatAccelerationSeriesCsv } from './seriesCsv';
import { useAccelerationRecorder } from './useAccelerationRecorder';

export const seismographInstrumentId = 'seismograph';

/** Umbral de evento (m/s² de aceleración dinámica) por nivel de sensibilidad. */
const eventThresholdBySensitivity = { high: 0.02, medium: 0.1, low: 0.5 } as const;
type SensitivityLevel = keyof typeof eventThresholdBySensitivity;

const traceDurationSeconds = 5;
const axisColors = { x: '#E5484D', y: '#30A46C', z: '#3E63DD' } as const;

export function SeismographScreen({ saveMeasurement }: InstrumentScreenProps<SeismographMeasurementValues>) {
  const { t } = useTranslation(seismographInstrumentId);
  const themePalette = useThemePalette();
  const [isRunning, setIsRunning] = useState(true);
  useKeepScreenOnWhile(isRunning, 'seismograph');
  const [sensitivityLevel, setSensitivityLevel] = useState<SensitivityLevel>('medium');
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const eventThreshold = eventThresholdBySensitivity[sensitivityLevel];

  const {
    history,
    displayRevision,
    eventCount,
    recordingDurationSeconds,
    sessionPeakDynamicAcceleration,
    sessionRmsDynamicAcceleration,
    vibrationAnalysis,
    readLatest,
    sessionSeries,
    reset,
  } = useAccelerationRecorder({ isRunning, eventThreshold });
  const hasSessionData = recordingDurationSeconds > 0;

  const displayRateHz = vibrationAnalysis?.sampleRateHz ?? 100;
  const traceSampleCount = Math.min(history.timestamps.capacity, Math.round(displayRateHz * traceDurationSeconds));
  const traceSeries = [
    { values: readLatest(history.dynamicX, traceSampleCount), color: axisColors.x },
    { values: readLatest(history.dynamicY, traceSampleCount), color: axisColors.y },
    { values: readLatest(history.dynamicZ, traceSampleCount), color: axisColors.z },
  ];
  const spectrumAmplitudes = vibrationAnalysis?.spectrumAmplitudes;

  async function handleSave() {
    if (!vibrationAnalysis) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const seriesFile = new File(Paths.cache, `seismograph-${Date.now()}.csv`);
      seriesFile.create({ overwrite: true });
      // La serie de toda la sesión, no solo los últimos segundos: así cuadra con el pico y los eventos.
      const sessionSamples = sessionSeries.read();
      seriesFile.write(
        formatAccelerationSeriesCsv(sessionSamples.timestampsSeconds, sessionSamples.x, sessionSamples.y, sessionSamples.z),
      );
      const seriesDurationSeconds =
        sessionSamples.timestampsSeconds.length > 1
          ? sessionSamples.timestampsSeconds.at(-1)! - sessionSamples.timestampsSeconds[0]!
          : 0;
      await saveMeasurement({
        values: {
          sampleRateHz: vibrationAnalysis.sampleRateHz,
          durationSeconds: recordingDurationSeconds,
          ...(vibrationAnalysis.dominantFrequencyHz !== null
            ? { dominantFrequencyHz: vibrationAnalysis.dominantFrequencyHz }
            : {}),
          // Pico y valor eficaz de toda la sesión, como la duración y los eventos.
          peakDynamicAcceleration: sessionPeakDynamicAcceleration,
          rmsDynamicAcceleration: sessionRmsDynamicAcceleration,
          eventCount,
          sensitivityThreshold: eventThreshold,
          spectrumResolutionHz: vibrationAnalysis.binResolutionHz,
          spectrumAmplitudes: Array.from(vibrationAnalysis.spectrumAmplitudes),
          seriesDurationSeconds: Math.round(seriesDurationSeconds * 10) / 10,
          ...(sessionSeries.isTruncated ? { isSeriesTruncated: true } : {}),
        },
        attachments: [
          {
            kind: 'series',
            sourceUri: seriesFile.uri,
            fileName: 'aceleracion.csv',
            mimeType: 'text/csv',
            metadata: { sampleRateHz: vibrationAnalysis.sampleRateHz, sampleCount: sessionSamples.timestampsSeconds.length },
          },
        ],
      });
      seriesFile.delete();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const formatNumber = (numericValue: number, fractionDigits: number) => numericValue.toFixed(fractionDigits);

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('instructions')}</BodyText>

      <View style={styles.readingsGrid}>
        <Reading
          label={t('fields.dominantFrequency')}
          value={
            vibrationAnalysis?.dominantFrequencyHz != null
              ? `${formatNumber(vibrationAnalysis.dominantFrequencyHz, 1)} Hz`
              : '—'
          }
        />
        <Reading
          label={t('fields.peak')}
          value={hasSessionData ? `${formatNumber(sessionPeakDynamicAcceleration, 3)} m/s²` : '—'}
        />
        <Reading
          label={t('fields.rms')}
          value={hasSessionData ? `${formatNumber(sessionRmsDynamicAcceleration, 3)} m/s²` : '—'}
        />
        <Reading label={t('fields.events')} value={String(eventCount)} />
      </View>
      {vibrationAnalysis ? (
        <BodyText tone="secondary">
          {t('recentReadings', {
            peak: formatNumber(vibrationAnalysis.peakDynamicAcceleration, 3),
            rms: formatNumber(vibrationAnalysis.rmsDynamicAcceleration, 3),
          })}
        </BodyText>
      ) : null}

      <SignalChart
        series={traceSeries}
        height={180}
        verticalRange={{ mode: 'symmetric', minimumHalfRange: 0.05 }}
        revision={displayRevision}
        unitLabel="m/s²"
        horizontalLabels={[`−${traceDurationSeconds} s`, t('now')]}
        accessibilityLabel={t('traceChart')}
      />
      <View style={styles.legendRow}>
        {(['x', 'y', 'z'] as const).map((axisName) => (
          <View key={axisName} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: axisColors[axisName] }]} />
            <BodyText tone="secondary">{axisName.toUpperCase()}</BodyText>
          </View>
        ))}
        <BodyText tone="secondary">
          {vibrationAnalysis ? t('sampleRate', { rate: formatNumber(vibrationAnalysis.sampleRateHz, 0) }) : ''}
        </BodyText>
      </View>

      {spectrumAmplitudes && vibrationAnalysis ? (
        <>
          <SignalChart
            series={[
              {
                values: spectrumAmplitudes,
                color: themePalette.accent,
                startIndex: 1,
                sampleCount: spectrumAmplitudes.length - 1,
              },
            ]}
            height={120}
            verticalRange={{ mode: 'from-zero', minimumMaximum: 0.005 }}
            revision={displayRevision}
            unitLabel="m/s²"
            horizontalLabels={['0 Hz', `${formatNumber(vibrationAnalysis.sampleRateHz / 2, 0)} Hz`]}
            accessibilityLabel={t('spectrumChart')}
          />
        </>
      ) : (
        <Card>
          <BodyText tone="secondary">{t('warmingUp')}</BodyText>
        </Card>
      )}

      <BodyText style={styles.sectionLabel}>{t('sensitivity.title')}</BodyText>
      <View style={styles.segmentedRow}>
        {(Object.keys(eventThresholdBySensitivity) as SensitivityLevel[]).map((level) => {
          const isSelectedLevel = level === sensitivityLevel;
          return (
            <Pressable
              key={level}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedLevel }}
              onPress={() => setSensitivityLevel(level)}
              style={[
                styles.segment,
                { borderColor: isSelectedLevel ? themePalette.accent : themePalette.border },
              ]}>
              <BodyText tone={isSelectedLevel ? 'accent' : 'primary'}>{t(`sensitivity.${level}`)}</BodyText>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton
            label={isRunning ? t('pause') : t('resume')}
            onPress={() => setIsRunning((wasRunning) => !wasRunning)}
            variant="secondary"
          />
        </View>
        <View style={styles.buttonCell}>
          <AppButton label={t('reset')} onPress={reset} variant="secondary" />
        </View>
      </View>
      <AppButton
        label={t('core:common.save')}
        onPress={() => void handleSave()}
        isBusy={isSaving}
        isDisabled={!vibrationAnalysis}
      />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
    </ScreenContainer>
  );
}

function Reading({ label, value }: { label: string; value: string }) {
  return (
    <Card style={styles.readingCard}>
      <BodyText tone="secondary" style={styles.readingLabel}>
        {label}
      </BodyText>
      <BodyText style={styles.readingValue}>{value}</BodyText>
    </Card>
  );
}

const styles = StyleSheet.create({
  readingsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  readingCard: { flexBasis: '47%', flexGrow: 1, padding: 12, gap: 2 },
  readingLabel: { fontSize: 13 },
  readingValue: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 12, height: 3, borderRadius: 2 },
  sectionLabel: { fontWeight: '600' },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
