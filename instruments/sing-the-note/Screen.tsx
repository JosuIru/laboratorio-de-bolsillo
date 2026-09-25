import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { type BestScores, loadBestScores, recordScore } from './bestScores';
import type { SingTheNoteMeasurementValues } from './schema';
import {
  difficultySettings,
  maximumRoundSeconds,
  requiredHoldSeconds,
  roundsPerGame,
  type SingDifficulty,
} from './singGame';
import { useSingGame } from './useSingGame';

export const singTheNoteInstrumentId = 'sing-the-note';

const difficulties: readonly SingDifficulty[] = ['easy', 'medium', 'hard'];
/** La barra de afinación muestra ±100 centésimas. */
const meterRangeCents = 100;

export function SingTheNoteScreen({ saveMeasurement }: InstrumentScreenProps<SingTheNoteMeasurementValues>) {
  const { t } = useTranslation(singTheNoteInstrumentId);
  const themePalette = useThemePalette();
  const { gameState, startGame, stopGame, microphoneStatus } = useSingGame();
  const [selectedDifficulty, setSelectedDifficulty] = useState<SingDifficulty>('easy');
  const [bestScores, setBestScores] = useState<BestScores>(loadBestScores);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Récord al terminar cada partida (una sola vez por partida terminada).
  const [recordedGame, setRecordedGame] = useState<typeof gameState | null>(null);
  const [isNewRecord, setIsNewRecord] = useState(false);
  if (gameState.phase === 'finished' && recordedGame !== gameState) {
    setRecordedGame(gameState);
    const previousBest = bestScores[gameState.difficulty];
    setIsNewRecord(previousBest === undefined || gameState.summary.totalPoints > previousBest);
    setBestScores(recordScore(bestScores, gameState.difficulty, gameState.summary.totalPoints));
  }

  function handleStart() {
    setStatusMessage(null);
    startGame(selectedDifficulty);
  }

  async function handleSave() {
    if (gameState.phase !== 'finished') return;
    setIsSaving(true);
    setStatusMessage(null);
    const { summary } = gameState;
    try {
      await saveMeasurement({
        values: {
          difficulty: gameState.difficulty,
          totalPoints: summary.totalPoints,
          hitCount: summary.hitCount,
          roundCount: summary.roundCount,
          ...(summary.meanAbsoluteCentsError !== null
            ? { meanAbsoluteCentsError: Math.round(summary.meanAbsoluteCentsError * 10) / 10 }
            : {}),
          targetNotes: gameState.roundScores.map((roundScore) => t(`notes.${roundScore.targetNoteIndex}`)).join(','),
          roundPoints: gameState.roundScores.map((roundScore) => roundScore.points),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  if (gameState.phase === 'playing') {
    const { roundProgress, stage, difficulty } = gameState;
    const { toleranceCents } = difficultySettings[difficulty];
    const latestError = roundProgress.latestCentsError;
    const isInTune = latestError !== null && Math.abs(latestError) <= toleranceCents;
    const lastRoundScore = gameState.roundScores[gameState.roundScores.length - 1];
    const toleranceFraction = toleranceCents / (2 * meterRangeCents);
    const needleFraction =
      latestError === null
        ? null
        : 0.5 + Math.max(-meterRangeCents, Math.min(meterRangeCents, latestError)) / (2 * meterRangeCents);

    return (
      <ScreenContainer>
        <Card>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('roundOf', { round: gameState.roundIndex + 1, total: gameState.targetNotes.length })}
          </BodyText>
          <BodyText style={styles.targetNote}>{t(`notes.${roundProgress.targetNoteIndex}`)}</BodyText>
          <BodyText style={styles.stageText} tone={stage === 'listening' ? 'accent' : 'secondary'}>
            {stage === 'reference'
              ? t('stage.listen')
              : stage === 'listening'
                ? t('stage.sing')
                : roundProgress.outcome === 'hit'
                  ? t('stage.hit', { points: lastRoundScore?.points ?? 0 })
                  : t('stage.missed')}
          </BodyText>

          <View style={[styles.meterTrack, { backgroundColor: themePalette.border }]}>
            <View
              style={[
                styles.toleranceZone,
                {
                  left: `${(0.5 - toleranceFraction) * 100}%`,
                  width: `${2 * toleranceFraction * 100}%`,
                  backgroundColor: themePalette.accent,
                },
              ]}
            />
            {stage === 'listening' && needleFraction !== null ? (
              <View
                style={[
                  styles.meterNeedle,
                  {
                    left: `${needleFraction * 100}%`,
                    backgroundColor: isInTune ? themePalette.accent : themePalette.textPrimary,
                  },
                ]}
              />
            ) : null}
          </View>
          <View style={styles.meterLabels}>
            <BodyText tone="secondary">{t('flat')}</BodyText>
            <BodyText tone="secondary">
              {stage === 'listening' && latestError !== null
                ? `${latestError > 0 ? '+' : ''}${Math.round(latestError)} ct`
                : ' '}
            </BodyText>
            <BodyText tone="secondary">{t('sharp')}</BodyText>
          </View>

          <BodyText tone="secondary">{t('holdProgress')}</BodyText>
          <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.min(1, roundProgress.heldSeconds / requiredHoldSeconds) * 100}%`,
                  backgroundColor: themePalette.accent,
                },
              ]}
            />
          </View>
          {stage === 'listening' ? (
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('timeLeft', { seconds: Math.max(0, Math.ceil(maximumRoundSeconds - roundProgress.elapsedSeconds)) })}
            </BodyText>
          ) : null}
          {microphoneStatus.status === 'error' ? (
            <BodyText tone="danger">{t('microphoneError', { message: microphoneStatus.errorMessage })}</BodyText>
          ) : null}
        </Card>
        <BodyText tone="secondary" style={styles.centeredText}>
          {t('anyOctave')}
        </BodyText>
        <AppButton label={t('stop')} variant="secondary" onPress={stopGame} />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      {gameState.phase === 'finished' ? (
        <Card>
          <BodyText style={styles.finalScore}>{t('points', { points: gameState.summary.totalPoints })}</BodyText>
          {isNewRecord ? (
            <BodyText tone="accent" style={styles.centeredText}>
              {t('newRecord')}
            </BodyText>
          ) : null}
          <BodyText style={styles.centeredText}>
            {t('hits', { hits: gameState.summary.hitCount, total: gameState.summary.roundCount })}
          </BodyText>
          {gameState.summary.meanAbsoluteCentsError !== null ? (
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('meanError', { cents: gameState.summary.meanAbsoluteCentsError.toFixed(0) })}
            </BodyText>
          ) : null}
          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
        </Card>
      ) : (
        <Card>
          <SectionTitle>{t('howTo.title')}</SectionTitle>
          <BodyText tone="secondary">
            {t('howTo.rules', { rounds: roundsPerGame, seconds: requiredHoldSeconds })}
          </BodyText>
          <BodyText tone="secondary">{t('howTo.octave')}</BodyText>
        </Card>
      )}

      <SectionTitle>{t('difficulty.title')}</SectionTitle>
      <View style={styles.chipRow}>
        {difficulties.map((difficulty) => {
          const isSelected = difficulty === selectedDifficulty;
          return (
            <Pressable
              key={difficulty}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              onPress={() => setSelectedDifficulty(difficulty)}
              style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}
            >
              <BodyText tone={isSelected ? 'accent' : 'primary'}>{t(`difficulty.${difficulty}`)}</BodyText>
              <BodyText tone="secondary" style={styles.chipDetail}>
                {bestScores[difficulty] !== undefined
                  ? t('best', { points: bestScores[difficulty] })
                  : t('toleranceDetail', { cents: difficultySettings[difficulty].toleranceCents })}
              </BodyText>
            </Pressable>
          );
        })}
      </View>
      <AppButton label={gameState.phase === 'finished' ? t('playAgain') : t('start')} onPress={handleStart} />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  centeredText: { textAlign: 'center' },
  targetNote: { fontSize: 64, fontWeight: '700', lineHeight: 72, textAlign: 'center' },
  stageText: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  meterTrack: { height: 14, borderRadius: 7, marginTop: 16, justifyContent: 'center', overflow: 'visible' },
  toleranceZone: { position: 'absolute', height: 14, borderRadius: 7, opacity: 0.35 },
  meterNeedle: { position: 'absolute', width: 6, height: 30, borderRadius: 3, marginLeft: -3 },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  progressTrack: { height: 10, borderRadius: 5, overflow: 'hidden' },
  progressFill: { height: 10 },
  finalScore: { fontSize: 40, fontWeight: '700', textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5, alignItems: 'center' },
  chipDetail: { fontSize: 12 },
  privacyNote: { fontSize: 13 },
});
