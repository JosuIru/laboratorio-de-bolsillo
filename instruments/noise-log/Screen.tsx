import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useResolvedCalibration } from '@/core/calibration/useResolvedCalibration';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { audioSpectrumInstrument } from '../audio-spectrum';
import type { SoundLevelCalibrationParameters } from '../audio-spectrum/calibration';
import {
  buildNoiseReportHtml,
  formatDuration,
  formatLevel,
  formatLocalDateTime,
  formatLocalTime,
  formatMinuteRowsCsv,
} from './noiseReport';
import { detectNoiseEpisodes, summarizeSecondSeries } from './noiseSession';
import type { NoiseLogMeasurementValues } from './schema';
import { clearTemporaryExportFiles, shareNoiseExport, writeTemporaryExportFile } from './shareNoiseFiles';
import { useNoiseRecorder } from './useNoiseRecorder';

export const noiseLogInstrumentId = 'noise-log';

/** Duraciones mínimas de episodio que se pueden elegir. */
const episodeDurationOptionsSeconds = [5, 10, 30, 60] as const;
/** Silencios más cortos que esto no parten un episodio en dos. */
const toleratedEpisodeGapSeconds = 2;
/** Umbral inicial: 45 dB(A) es una referencia habitual de ruido nocturno en interiores… */
const defaultCalibratedThresholdDecibels = 45;
/** …pero sin calibrar los niveles son dBFS (negativos), y el umbral también. */
const defaultRelativeThresholdDecibels = -50;
/** En pantalla solo se listan los últimos episodios; el informe los lleva todos. */
const maximumListedEpisodes = 30;

export function NoiseLogScreen({ saveMeasurement }: InstrumentScreenProps<NoiseLogMeasurementValues>) {
  const { t } = useTranslation(noiseLogInstrumentId);
  const themePalette = useThemePalette();

  // La calibración de nivel se hace en el analizador de espectro: aquí solo se lee.
  const calibrationLoadState = useResolvedCalibration(audioSpectrumInstrument);
  const calibrationParameters =
    calibrationLoadState.status === 'ready'
      ? (calibrationLoadState.resolvedCalibration.parameters as SoundLevelCalibrationParameters | null)
      : null;
  const availableOffsetDecibels = calibrationParameters?.decibelOffset ?? null;

  const {
    recorderPhase,
    wasInterrupted,
    microphoneStatus,
    sessionLog,
    sessionOffsetDecibels,
    displayRevision,
    latestLevelDecibels,
    startSession,
    stopSession,
  } = useNoiseRecorder(availableOffsetDecibels);

  const [placeDescription, setPlaceDescription] = useState('');
  const [thresholdDecibels, setThresholdDecibels] = useState<number | null>(null);
  const [minimumEpisodeDurationSeconds, setMinimumEpisodeDurationSeconds] = useState<number>(10);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Mientras hay sesión, la unidad es la de la sesión (la calibración se fija al empezar).
  const activeOffsetDecibels = sessionLog ? sessionOffsetDecibels : availableOffsetDecibels;
  const isSessionCalibrated = activeOffsetDecibels !== null;
  const levelUnit = isSessionCalibrated ? 'dB(A)' : 'dBFS(A)';
  const effectiveThresholdDecibels =
    thresholdDecibels ?? (isSessionCalibrated ? defaultCalibratedThresholdDecibels : defaultRelativeThresholdDecibels);
  const isRecording = recorderPhase === 'recording';

  // Se recalcula en cada refresco (una vez por segundo) o al cambiar umbral o duración.
  const secondSeries = sessionLog?.readSecondSeries() ?? null;
  const sessionSummary = secondSeries ? summarizeSecondSeries(secondSeries) : null;
  const minuteRows = sessionLog?.readMinuteRows() ?? [];
  const detectedEpisodes = secondSeries
    ? detectNoiseEpisodes(secondSeries, {
        thresholdDecibels: effectiveThresholdDecibels,
        minimumDurationSeconds: minimumEpisodeDurationSeconds,
        toleratedGapSeconds: toleratedEpisodeGapSeconds,
      })
    : [];
  const elapsedSeconds = sessionLog?.readElapsedSeconds() ?? 0;
  const sessionEndTimestamp = sessionLog ? sessionLog.sessionStartTimestamp + elapsedSeconds * 1000 : 0;
  const levelText = (levelDecibels: number | null | undefined) =>
    levelDecibels === null || levelDecibels === undefined ? '—' : `${formatLevel(levelDecibels)} ${levelUnit}`;

  function handleStart() {
    setStatusMessage(null);
    startSession();
  }

  function buildReportHtml() {
    if (!sessionLog || !sessionSummary) return null;
    return buildNoiseReportHtml(
      {
        sessionStartTimestamp: sessionLog.sessionStartTimestamp,
        sessionEndTimestamp,
        placeDescription,
        summary: sessionSummary,
        minuteRows,
        episodes: detectedEpisodes,
        thresholdDecibels: effectiveThresholdDecibels,
        minimumEpisodeDurationSeconds,
        levelUnit,
        isCalibrated: isSessionCalibrated,
      },
      (translationKey, interpolationValues) => t(translationKey, interpolationValues ?? {}),
    );
  }

  function exportFileName(extension: string) {
    const startText = sessionLog ? formatLocalDateTime(sessionLog.sessionStartTimestamp).replace(/[: ]/g, '-') : 'sesion';
    return `ruido-${startText}.${extension}`;
  }

  async function handleShare(exportKind: 'csv' | 'html') {
    setStatusMessage(null);
    try {
      const fileContents = exportKind === 'csv' ? formatMinuteRowsCsv(minuteRows, levelUnit) : buildReportHtml();
      if (!fileContents) return;
      await shareNoiseExport(exportFileName(exportKind), fileContents, exportKind, t('share.dialogTitle'));
    } catch (shareError) {
      setStatusMessage(t('core:common.error', { message: String(shareError) }));
    }
  }

  async function handleSave() {
    if (!sessionLog || !sessionSummary) return;
    setIsSaving(true);
    setStatusMessage(null);
    const roundToTenth = (numericValue: number) => Math.round(numericValue * 10) / 10;
    try {
      const csvFileUri = writeTemporaryExportFile(exportFileName('csv'), formatMinuteRowsCsv(minuteRows, levelUnit), 'csv');
      const trimmedPlace = placeDescription.trim();
      await saveMeasurement({
        values: {
          sessionStartTimestamp: sessionLog.sessionStartTimestamp,
          durationSeconds: Math.round(elapsedSeconds),
          isCalibrated: isSessionCalibrated,
          ...(sessionOffsetDecibels !== null ? { calibrationOffsetDecibels: roundToTenth(sessionOffsetDecibels) } : {}),
          equivalentLevelDecibels: roundToTenth(sessionSummary.equivalentLevelDecibels),
          maximumLevelDecibels: roundToTenth(sessionSummary.maximumLevelDecibels),
          level10Decibels: roundToTenth(sessionSummary.level10Decibels),
          level90Decibels: roundToTenth(sessionSummary.level90Decibels),
          episodeThresholdDecibels: effectiveThresholdDecibels,
          minimumEpisodeDurationSeconds,
          episodeCount: detectedEpisodes.length,
          ...(trimmedPlace ? { placeDescription: trimmedPlace } : {}),
          minuteEquivalentLevels: minuteRows.map((minuteRow) => roundToTenth(minuteRow.equivalentLevelDecibels)),
        },
        attachments: [
          {
            kind: 'series',
            sourceUri: csvFileUri,
            fileName: 'ruido-por-minuto.csv',
            mimeType: 'text/csv',
            metadata: { minuteCount: minuteRows.length, levelUnit },
          },
        ],
        ...(trimmedPlace ? { note: trimmedPlace } : {}),
      });
      clearTemporaryExportFiles();
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const minuteLevels = Float64Array.from(minuteRows, (minuteRow) => minuteRow.equivalentLevelDecibels);
  const thresholdLine = new Float64Array(minuteLevels.length).fill(effectiveThresholdDecibels);
  const chartMinimum = Math.floor(Math.min(effectiveThresholdDecibels, ...minuteLevels) / 10) * 10 - 5;
  const chartMaximum = Math.ceil(Math.max(effectiveThresholdDecibels, ...minuteLevels) / 10) * 10 + 5;
  const listedEpisodes = detectedEpisodes.slice(-maximumListedEpisodes).reverse();

  return (
    <ScreenContainer>
      <Card>
        <BodyText style={styles.privacyTitle}>{t('privacyTitle')}</BodyText>
        <BodyText tone="secondary">{t('privacy')}</BodyText>
      </Card>

      {isSessionCalibrated ? (
        <BodyText tone="secondary">{t('calibration.active', { offset: formatLevel(activeOffsetDecibels ?? 0) })}</BodyText>
      ) : (
        <Card>
          <BodyText tone="danger">{t('calibration.missing')}</BodyText>
          {!isRecording ? (
            <AppButton
              label={t('calibration.goCalibrate')}
              variant="secondary"
              onPress={() =>
                router.push({ pathname: '/instrument/[id]/calibrate', params: { id: audioSpectrumInstrument.id } })
              }
            />
          ) : null}
        </Card>
      )}

      <BodyText tone="secondary">{t('keepAwake')}</BodyText>

      <TextInput
        value={placeDescription}
        onChangeText={setPlaceDescription}
        placeholder={t('placePlaceholder')}
        placeholderTextColor={themePalette.textSecondary}
        accessibilityLabel={t('fields.place')}
        style={[styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
      />

      <AppButton
        label={isRecording ? t('stop') : recorderPhase === 'stopped' ? t('startNew') : t('start')}
        variant={isRecording ? 'danger' : 'primary'}
        onPress={isRecording ? stopSession : handleStart}
      />
      {microphoneStatus.status === 'error' ? (
        <BodyText tone="danger">{t('core:common.error', { message: microphoneStatus.errorMessage })}</BodyText>
      ) : null}
      {isRecording && microphoneStatus.status === 'starting' ? <BodyText tone="secondary">{t('starting')}</BodyText> : null}
      {wasInterrupted ? <BodyText tone="danger">{t('interrupted')}</BodyText> : null}

      {sessionLog ? (
        <>
          <View style={styles.readingsGrid}>
            <Reading label={t('summary.now')} value={isRecording ? levelText(latestLevelDecibels) : '—'} />
            <Reading label={t('summary.elapsed')} value={formatDuration(elapsedSeconds)} />
            <Reading label={t('summary.leq')} value={levelText(sessionSummary?.equivalentLevelDecibels)} />
            <Reading label={t('summary.maximum')} value={levelText(sessionSummary?.maximumLevelDecibels)} />
            <Reading label={t('summary.level10')} value={levelText(sessionSummary?.level10Decibels)} />
            <Reading label={t('summary.level90')} value={levelText(sessionSummary?.level90Decibels)} />
          </View>
          <BodyText tone="secondary" style={styles.smallNote}>
            {t('summary.explanation')}
          </BodyText>

          <SectionTitle>{t('chart.title')}</SectionTitle>
          {minuteLevels.length >= 2 ? (
            <SignalChart
              series={[
                { values: thresholdLine, color: themePalette.danger },
                { values: minuteLevels, color: themePalette.accent },
              ]}
              height={160}
              verticalRange={{ mode: 'fixed', minimum: chartMinimum, maximum: chartMaximum }}
              // Cambia con cada refresco y con cada umbral (entre −500 y 500 dB, de sobra).
              revision={displayRevision * 1000 + effectiveThresholdDecibels + 500}
              unitLabel={levelUnit}
              horizontalLabels={[
                formatLocalTime(minuteRows[0]!.minuteStartTimestamp).slice(0, 5),
                formatLocalTime(minuteRows.at(-1)!.minuteStartTimestamp).slice(0, 5),
              ]}
              accessibilityLabel={t('chart.accessibility')}
            />
          ) : (
            <BodyText tone="secondary">{t('chart.waiting')}</BodyText>
          )}
        </>
      ) : null}

      <SectionTitle>{t('episodes.title')}</SectionTitle>
      <View style={styles.thresholdRow}>
        <BodyText style={styles.thresholdLabel}>{t('episodes.threshold')}</BodyText>
        <AppButton label="−" variant="secondary" onPress={() => setThresholdDecibels(effectiveThresholdDecibels - 1)} />
        <BodyText style={styles.thresholdValue}>{`${effectiveThresholdDecibels} ${levelUnit}`}</BodyText>
        <AppButton label="+" variant="secondary" onPress={() => setThresholdDecibels(effectiveThresholdDecibels + 1)} />
      </View>
      <BodyText tone="secondary">{t('episodes.minimumDuration')}</BodyText>
      <View style={styles.segmentedRow}>
        {episodeDurationOptionsSeconds.map((durationOption) => {
          const isSelectedDuration = durationOption === minimumEpisodeDurationSeconds;
          return (
            <Pressable
              key={durationOption}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedDuration }}
              onPress={() => setMinimumEpisodeDurationSeconds(durationOption)}
              style={[styles.segment, { borderColor: isSelectedDuration ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelectedDuration ? 'accent' : 'primary'}>{formatDuration(durationOption)}</BodyText>
            </Pressable>
          );
        })}
      </View>
      <BodyText tone="secondary" style={styles.smallNote}>
        {t('episodes.explanation')}
      </BodyText>
      {sessionLog ? (
        detectedEpisodes.length === 0 ? (
          <BodyText tone="secondary">{t('episodes.none')}</BodyText>
        ) : (
          <Card>
            <BodyText tone="secondary">{t('episodes.count', { count: detectedEpisodes.length })}</BodyText>
            {listedEpisodes.map((episode) => (
              <View key={episode.startTimestamp} style={styles.episodeRow}>
                <BodyText style={styles.episodeCell}>{formatLocalTime(episode.startTimestamp)}</BodyText>
                <BodyText style={styles.episodeCell}>{formatDuration(episode.durationSeconds)}</BodyText>
                <BodyText style={styles.episodeCell}>
                  {t('episodes.maximumValue', { level: levelText(episode.maximumLevelDecibels) })}
                </BodyText>
              </View>
            ))}
          </Card>
        )
      ) : null}

      {recorderPhase === 'stopped' && sessionSummary ? (
        <>
          <SectionTitle>{t('share.title')}</SectionTitle>
          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton label={t('share.csv')} variant="secondary" onPress={() => void handleShare('csv')} />
            </View>
            <View style={styles.buttonCell}>
              <AppButton label={t('share.report')} variant="secondary" onPress={() => void handleShare('html')} />
            </View>
          </View>
        </>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <BodyText tone="secondary" style={styles.smallNote}>
        {t('disclaimer')}
      </BodyText>
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
  privacyTitle: { fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  readingsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  readingCard: { flexBasis: '47%', flexGrow: 1, padding: 12, gap: 2 },
  readingLabel: { fontSize: 13 },
  readingValue: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  smallNote: { fontSize: 13 },
  thresholdRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thresholdLabel: { flex: 1 },
  thresholdValue: { minWidth: 96, textAlign: 'center', fontVariant: ['tabular-nums'] },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  episodeRow: { flexDirection: 'row', gap: 8 },
  episodeCell: { flex: 1, fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
