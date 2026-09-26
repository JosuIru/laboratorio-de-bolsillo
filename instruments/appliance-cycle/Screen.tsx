import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { summarizeCycle } from './cycleDetector';
import { formatCycleDuration, formatLocalDateTime, formatLocalTime } from './cycleFormatting';
import {
  type ApplianceCycleSettings,
  buildDetectorSettings,
  loadApplianceCycleSettings,
  quietMinutesOptions,
  saveApplianceCycleSettings,
  sensitivityLevels,
  sensitivityPresets,
} from './cycleSettings';
import type { ApplianceCycleMeasurementValues } from './schema';
import { useCycleAlarm } from './useCycleAlarm';
import { useCycleWatcher } from './useCycleWatcher';
import { levelToDecibels, summarizeLevelHistory } from './vibrationLevel';

export const applianceCycleInstrumentId = 'appliance-cycle';

/** Puntos de la gráfica: la sesión entera (horas) se resume en estos, con el máximo de cada tramo. */
const chartPointCount = 300;
const chartRangeDecibels = { minimum: -50, maximum: 15 } as const;
/** No se enseña la pausa hasta que dura algo: entre dos golpes de tambor siempre hay segundos quietos. */
const minimumQuietSecondsToShow = 10;

export function ApplianceCycleScreen({ saveMeasurement }: InstrumentScreenProps<ApplianceCycleMeasurementValues>) {
  const { t } = useTranslation(applianceCycleInstrumentId);
  const themePalette = useThemePalette();
  const [cycleSettings, setCycleSettings] = useState<ApplianceCycleSettings>(loadApplianceCycleSettings);
  const detectorSettings = useMemo(() => buildDetectorSettings(cycleSettings), [cycleSettings]);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [wasStartAssumed, setWasStartAssumed] = useState(false);

  const {
    isWatching,
    wasInterrupted,
    detectorState,
    latestLevel,
    levelHistory,
    historyRevision,
    startWatching,
    stopWatching,
    markAlreadyRunning,
  } = useCycleWatcher(detectorSettings);

  const { phase, threshold } = detectorState;
  const isRinging = isWatching && phase === 'finished';
  useKeepScreenOnWhile(isWatching, applianceCycleInstrumentId);
  useCycleAlarm(isRinging);

  const cycleSummary = summarizeCycle(detectorState);
  const fallbackThreshold = sensitivityPresets[cycleSettings.sensitivityLevel].fallbackThreshold;
  const isBackgroundHigh = phase === 'waitingForStart' && threshold !== null && threshold > fallbackThreshold;
  const canMarkAlreadyRunning = isWatching && (phase === 'measuringBackground' || phase === 'waitingForStart');

  const levelChartSeries = useMemo(() => {
    const summarizedLevels = summarizeLevelHistory(levelHistory, chartPointCount);
    const levelDecibels = summarizedLevels.map(levelToDecibels);
    const levelSeries = { values: levelDecibels, color: themePalette.accent };
    if (threshold === null) return [levelSeries];
    const thresholdDecibels = new Float64Array(levelDecibels.length).fill(levelToDecibels(threshold));
    return [levelSeries, { values: thresholdDecibels, color: themePalette.danger }];
    // `historyRevision` indica que `levelHistory` (mutable) tiene ventanas nuevas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelHistory, historyRevision, threshold, themePalette]);

  function updateSettings(changedSettings: Partial<ApplianceCycleSettings>) {
    setCycleSettings((previousSettings) => {
      const nextSettings = { ...previousSettings, ...changedSettings };
      saveApplianceCycleSettings(nextSettings);
      return nextSettings;
    });
  }

  function handleStartWatching() {
    setStatusMessage(null);
    setWasStartAssumed(false);
    startWatching();
  }

  function handleMarkAlreadyRunning() {
    setWasStartAssumed(true);
    markAlreadyRunning(fallbackThreshold);
  }

  async function handleSave() {
    if (phase !== 'finished' || !cycleSummary || detectorState.cycleStartSeconds === null || threshold === null) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const cycleStartSeconds = detectorState.cycleStartSeconds;
      await saveMeasurement({
        values: {
          cycleDurationSeconds: Math.round(cycleSummary.runSeconds),
          startTime: formatLocalDateTime(new Date(cycleStartSeconds * 1000)),
          endTime: formatLocalDateTime(new Date((cycleStartSeconds + cycleSummary.runSeconds) * 1000)),
          meanLevel: cycleSummary.meanLevel,
          peakLevel: cycleSummary.peakLevel,
          threshold,
          ...(detectorState.backgroundLevel !== null ? { backgroundLevel: detectorState.backgroundLevel } : {}),
          quietMinutesToFinish: cycleSettings.quietMinutesToFinish,
          ...(wasStartAssumed ? { wasStartAssumed: true } : {}),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  function describeStatus(): { title: string; detail: string | null } {
    if (!isWatching && phase !== 'finished') return { title: t('status.idle'), detail: null };
    switch (phase) {
      case 'measuringBackground':
        return {
          title: t('status.measuringBackground'),
          detail: t('status.measuringBackgroundDetail', {
            seconds: Math.max(0, detectorSettings.backgroundWindowCount - detectorState.backgroundLevels.length),
          }),
        };
      case 'waitingForStart':
        return { title: t('status.waitingForStart'), detail: t('status.waitingForStartDetail') };
      case 'running': {
        const runDuration = formatCycleDuration(cycleSummary?.runSeconds ?? 0);
        const quietSeconds = cycleSummary?.quietSeconds ?? 0;
        return {
          title: t('status.running'),
          detail:
            quietSeconds >= minimumQuietSecondsToShow
              ? t('status.pausedDetail', {
                  quiet: formatCycleDuration(quietSeconds),
                  limit: formatCycleDuration(detectorSettings.quietSecondsToFinish),
                })
              : t('status.runningDetail', { duration: runDuration }),
        };
      }
      case 'finished': {
        const cycleStartSeconds = detectorState.cycleStartSeconds ?? 0;
        const runSeconds = cycleSummary?.runSeconds ?? 0;
        return {
          title: t('status.finished'),
          detail: t('status.finishedDetail', {
            duration: formatCycleDuration(runSeconds),
            start: formatLocalTime(new Date(cycleStartSeconds * 1000)),
            end: formatLocalTime(new Date((cycleStartSeconds + runSeconds) * 1000)),
          }),
        };
      }
    }
  }

  const { title: statusTitle, detail: statusDetail } = describeStatus();
  const formatLevel = (level: number | null) => (level !== null ? `${level.toFixed(3)} m/s²` : '—');

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('instructions')}</BodyText>
      <Card>
        <BodyText tone="danger">{t('keepOpenWarning')}</BodyText>
      </Card>

      <Card style={styles.statusCard}>
        <BodyText style={styles.statusTitle} tone={phase === 'finished' ? 'accent' : 'primary'}>
          {statusTitle}
        </BodyText>
        {statusDetail ? <BodyText>{statusDetail}</BodyText> : null}
        {wasInterrupted && !isWatching ? <BodyText tone="danger">{t('interrupted')}</BodyText> : null}
        {isBackgroundHigh ? <BodyText tone="secondary">{t('highBackground')}</BodyText> : null}
        {wasStartAssumed && (phase === 'running' || phase === 'finished') ? (
          <BodyText tone="secondary">{t('alreadyRunningNote')}</BodyText>
        ) : null}
      </Card>

      <View style={styles.readingsGrid}>
        <Reading label={t('fields.currentLevel')} value={isWatching ? formatLevel(latestLevel) : '—'} />
        <Reading label={t('fields.threshold')} value={formatLevel(threshold)} />
      </View>

      {levelHistory.length >= 2 ? (
        <>
          <SignalChart
            series={levelChartSeries}
            height={140}
            verticalRange={{ mode: 'fixed', ...chartRangeDecibels }}
            revision={historyRevision}
            unitLabel="dB"
            horizontalLabels={[`−${formatCycleDuration(levelHistory.length)}`, t('now')]}
            accessibilityLabel={t('levelChart')}
          />
          <View style={styles.legendRow}>
            <LegendItem color={themePalette.accent} label={t('legend.level')} />
            {threshold !== null ? <LegendItem color={themePalette.danger} label={t('legend.threshold')} /> : null}
          </View>
          <BodyText tone="secondary">{t('levelChart')}</BodyText>
        </>
      ) : null}

      {isRinging ? <AppButton label={t('stopAlarm')} onPress={stopWatching} variant="danger" /> : null}
      {canMarkAlreadyRunning ? (
        <AppButton label={t('alreadyRunning')} onPress={handleMarkAlreadyRunning} variant="secondary" />
      ) : null}
      {isWatching && !isRinging ? (
        <AppButton label={t('stopWatching')} onPress={stopWatching} variant="secondary" />
      ) : null}
      {!isWatching ? (
        <AppButton label={phase === 'finished' ? t('watchAgain') : t('watch')} onPress={handleStartWatching} />
      ) : null}
      {phase === 'finished' ? (
        <AppButton
          label={t('core:common.save')}
          onPress={() => void handleSave()}
          isBusy={isSaving}
          variant="secondary"
        />
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <BodyText style={styles.sectionLabel}>{t('quietMinutes.title')}</BodyText>
      <SegmentedChoice
        options={quietMinutesOptions.map((quietMinutes) => ({
          key: String(quietMinutes),
          label: t('quietMinutes.option', { count: quietMinutes }),
          isSelected: quietMinutes === cycleSettings.quietMinutesToFinish,
          onSelect: () => updateSettings({ quietMinutesToFinish: quietMinutes }),
        }))}
      />
      <BodyText tone="secondary">{t('quietMinutes.hint')}</BodyText>

      <BodyText style={styles.sectionLabel}>{t('sensitivity.title')}</BodyText>
      <SegmentedChoice
        options={sensitivityLevels.map((sensitivityLevel) => ({
          key: sensitivityLevel,
          label: t(`sensitivity.${sensitivityLevel}`),
          isSelected: sensitivityLevel === cycleSettings.sensitivityLevel,
          onSelect: () => updateSettings({ sensitivityLevel }),
        }))}
        // El umbral se fija al medir el fondo: cambiar la sensibilidad a mitad no tendría efecto.
        isDisabled={isWatching}
      />
      <BodyText tone="secondary">{t('sensitivity.hint')}</BodyText>
    </ScreenContainer>
  );
}

interface SegmentedOption {
  key: string;
  label: string;
  isSelected: boolean;
  onSelect(): void;
}

function SegmentedChoice({ options, isDisabled = false }: { options: readonly SegmentedOption[]; isDisabled?: boolean }) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.segmentedRow}>
      {options.map((option) => (
        <Pressable
          key={option.key}
          accessibilityRole="radio"
          accessibilityState={{ selected: option.isSelected, disabled: isDisabled }}
          disabled={isDisabled}
          onPress={option.onSelect}
          style={[
            styles.segment,
            {
              borderColor: option.isSelected ? themePalette.accent : themePalette.border,
              opacity: isDisabled ? 0.5 : 1,
            },
          ]}>
          <BodyText tone={option.isSelected ? 'accent' : 'primary'}>{option.label}</BodyText>
        </Pressable>
      ))}
    </View>
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

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: color }]} />
      <BodyText tone="secondary">{label}</BodyText>
    </View>
  );
}

const styles = StyleSheet.create({
  statusCard: { gap: 6 },
  statusTitle: { fontSize: 22, fontWeight: '700' },
  readingsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  readingCard: { flexBasis: '47%', flexGrow: 1, padding: 12, gap: 2 },
  readingLabel: { fontSize: 13 },
  readingValue: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 12, height: 3, borderRadius: 2 },
  sectionLabel: { fontWeight: '600' },
  segmentedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segment: {
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1.5,
  },
});
