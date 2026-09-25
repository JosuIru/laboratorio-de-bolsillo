import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { ContinuationScore } from './rhythmAnalysis';
import type { RhythmMeasurementValues } from './schema';
import { continuationBeatCount, countInClickCount, type RhythmMode, useRhythmSession } from './useRhythmSession';

export const rhythmInstrumentId = 'rhythm';

const tempoOptions: readonly number[] = [60, 90, 120];

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function SegmentedChoice<TOption extends string | number>({
  options,
  selectedOption,
  labelFor,
  onSelect,
  isDisabled,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  labelFor(option: TOption): string;
  onSelect(option: TOption): void;
  isDisabled: boolean;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.segmentedRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected, disabled: isDisabled }}
            disabled={isDisabled}
            onPress={() => onSelect(option)}
            style={[
              styles.segment,
              { borderColor: isSelected ? themePalette.accent : themePalette.border, opacity: isDisabled ? 0.5 : 1 },
            ]}>
            <BodyText tone={isSelected ? 'accent' : 'primary'}>{labelFor(option)}</BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

function ContinuationResults({ continuationScore }: { continuationScore: ContinuationScore }) {
  const { t } = useTranslation(rhythmInstrumentId);
  const { meanAsynchronyMilliseconds, intervalVariabilityMilliseconds, tempoDriftPercent } = continuationScore;
  const asynchronyText =
    Math.abs(meanAsynchronyMilliseconds) < 5
      ? t('results.onTime')
      : meanAsynchronyMilliseconds < 0
        ? t('results.early', { milliseconds: Math.round(-meanAsynchronyMilliseconds) })
        : t('results.late', { milliseconds: Math.round(meanAsynchronyMilliseconds) });
  const driftText =
    Math.abs(tempoDriftPercent) < 0.5
      ? t('results.steadyTempo')
      : tempoDriftPercent > 0
        ? t('results.slowingDown', { percent: tempoDriftPercent.toFixed(1) })
        : t('results.speedingUp', { percent: (-tempoDriftPercent).toFixed(1) });
  return (
    <Card style={styles.resultsCard}>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('fields.score')}
      </BodyText>
      <BodyText style={styles.scoreValue}>{continuationScore.score}</BodyText>
      <BodyText>{asynchronyText}</BodyText>
      <BodyText>{t('results.variability', { milliseconds: Math.round(intervalVariabilityMilliseconds) })}</BodyText>
      <BodyText>{driftText}</BodyText>
      <BodyText tone="secondary">
        {t('results.counts', {
          hits: continuationScore.hitBeatCount,
          total: continuationBeatCount,
          extra: continuationScore.extraClapCount,
        })}
      </BodyText>
    </Card>
  );
}

export function RhythmScreen({ saveMeasurement }: InstrumentScreenProps<RhythmMeasurementValues>) {
  const { t } = useTranslation(rhythmInstrumentId);
  const [rhythmMode, setRhythmMode] = useState<RhythmMode>('continuation');
  const [targetBeatsPerMinute, setTargetBeatsPerMinute] = useState<number>(90);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { sessionState, start, cancel } = useRhythmSession();
  const isBusy = sessionState.phase === 'starting' || sessionState.phase === 'countIn' || sessionState.phase === 'continuation';
  const isListeningFree = sessionState.phase === 'freeListening';

  if (sessionState.phase === 'error') {
    return (
      <ScreenContainer>
        <BodyText tone="danger">{t('core:common.error', { message: sessionState.errorMessage })}</BodyText>
        <AppButton label={t('tryAgain')} onPress={cancel} variant="secondary" />
      </ScreenContainer>
    );
  }

  async function handleSave() {
    if (sessionState.phase !== 'results') return;
    const { continuationScore } = sessionState;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          targetBeatsPerMinute: sessionState.targetBeatsPerMinute,
          score: continuationScore.score,
          meanAsynchronyMilliseconds: roundTo(continuationScore.meanAsynchronyMilliseconds, 1),
          intervalVariabilityMilliseconds: roundTo(continuationScore.intervalVariabilityMilliseconds, 1),
          tempoDriftPercent: roundTo(continuationScore.tempoDriftPercent, 2),
          hitBeatCount: continuationScore.hitBeatCount,
          missedBeatCount: continuationScore.missedBeatCount,
          extraClapCount: continuationScore.extraClapCount,
          hitOffsetsMilliseconds: continuationScore.beatOffsetsMilliseconds
            .filter((offset): offset is number => offset !== null)
            .map((offset) => roundTo(offset, 1)),
          missedBeatNumbers: continuationScore.beatOffsetsMilliseconds.flatMap((offset, beatOffset) =>
            offset === null ? [beatOffset + 1] : [],
          ),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  function handleStart() {
    setStatusMessage(null);
    void start(rhythmMode, targetBeatsPerMinute);
  }

  return (
    <ScreenContainer>
      <SegmentedChoice<RhythmMode>
        options={['continuation', 'free']}
        selectedOption={rhythmMode}
        labelFor={(mode) => t(`modes.${mode}`)}
        onSelect={(mode) => {
          cancel();
          setRhythmMode(mode);
        }}
        isDisabled={isBusy}
      />
      <BodyText tone="secondary" style={styles.smallText}>
        {t(`modeHelp.${rhythmMode}`, { clicks: countInClickCount, beats: continuationBeatCount })}
      </BodyText>

      {rhythmMode === 'continuation' ? (
        <SegmentedChoice<number>
          options={tempoOptions}
          selectedOption={targetBeatsPerMinute}
          labelFor={(beatsPerMinute) => `${beatsPerMinute} BPM`}
          onSelect={setTargetBeatsPerMinute}
          isDisabled={isBusy}
        />
      ) : null}

      {sessionState.phase === 'starting' ? <LoadingState label={t('starting')} /> : null}
      {sessionState.phase === 'countIn' ? (
        <Card style={styles.phaseCard}>
          <BodyText tone="secondary">{t('phases.countIn')}</BodyText>
          <BodyText style={styles.beatValue}>
            {sessionState.beatNumber} / {countInClickCount}
          </BodyText>
        </Card>
      ) : null}
      {sessionState.phase === 'continuation' ? (
        <Card style={styles.phaseCard}>
          <BodyText tone="accent">{t('phases.continuation')}</BodyText>
          <BodyText style={styles.beatValue}>
            {sessionState.beatNumber} / {continuationBeatCount}
          </BodyText>
        </Card>
      ) : null}
      {sessionState.phase === 'results' ? <ContinuationResults continuationScore={sessionState.continuationScore} /> : null}
      {sessionState.phase === 'clicksNotHeard' ? (
        <Card>
          <BodyText tone="danger">{t('clicksNotHeard')}</BodyText>
        </Card>
      ) : null}
      {isListeningFree ? (
        <Card style={styles.phaseCard}>
          <BodyText tone="secondary">{t('fields.measuredTempo')}</BodyText>
          <BodyText style={styles.beatValue}>
            {sessionState.analysis ? `${Math.round(sessionState.analysis.beatsPerMinute)} BPM` : '—'}
          </BodyText>
          <BodyText tone="secondary">
            {sessionState.analysis
              ? t('free.regularity', { percent: sessionState.analysis.intervalVariationPercent.toFixed(1) })
              : t('free.keepClapping')}
          </BodyText>
          <BodyText tone="secondary">{t('free.clapCount', { count: sessionState.clapCount })}</BodyText>
        </Card>
      ) : null}

      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          {isBusy || isListeningFree ? (
            <AppButton label={t('stop')} onPress={cancel} variant="secondary" />
          ) : (
            <AppButton label={sessionState.phase === 'idle' ? t('start') : t('again')} onPress={handleStart} />
          )}
        </View>
        {sessionState.phase === 'results' ? (
          <View style={styles.buttonCell}>
            <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} variant="secondary" />
          </View>
        ) : null}
      </View>
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  phaseCard: { alignItems: 'center', paddingVertical: 20, gap: 4 },
  beatValue: { fontSize: 40, lineHeight: 48, fontWeight: '700', fontVariant: ['tabular-nums'] },
  resultsCard: { alignItems: 'center', gap: 6, paddingVertical: 20 },
  scoreValue: { fontSize: 56, lineHeight: 64, fontWeight: '700', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  smallText: { fontSize: 13 },
});
