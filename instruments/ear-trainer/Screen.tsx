import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { NoteIndex } from '@/processing/dsp/musicalNotes';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { difficultySettings, requiredHoldSeconds, type SingDifficulty } from '@instruments/sing-the-note/singGame';

import {
  createIntervalSteps,
  createScaleSteps,
  type EarExerciseKind,
  type EarTrainingStep,
  type ScaleId,
  scaleSemitones,
} from './earTraining';
import type { EarTrainerMeasurementValues } from './schema';
import { useEarTraining } from './useEarTraining';

export const earTrainerInstrumentId = 'ear-trainer';

const exerciseKinds: readonly EarExerciseKind[] = ['intervals', 'scales'];
const difficulties: readonly SingDifficulty[] = ['easy', 'medium', 'hard'];
const scaleIds = Object.keys(scaleSemitones) as ScaleId[];
const naturalRoots: readonly NoteIndex[] = [0, 2, 4, 5, 7, 9, 11];
const meterRangeCents = 100;

export function EarTrainerScreen({ saveMeasurement }: InstrumentScreenProps<EarTrainerMeasurementValues>) {
  const { t } = useTranslation(earTrainerInstrumentId);
  const themePalette = useThemePalette();
  const { trainingState, startTraining, stopTraining, microphoneStatus } = useEarTraining();
  const [exerciseKind, setExerciseKind] = useState<EarExerciseKind>('intervals');
  const [difficulty, setDifficulty] = useState<SingDifficulty>('easy');
  const [scaleId, setScaleId] = useState<ScaleId>('major');
  const [rootNoteIndex, setRootNoteIndex] = useState<NoteIndex>(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const noteName = (noteIndex: NoteIndex) => t(`notes.${noteIndex}`);
  function describeStep(step: EarTrainingStep): string {
    return step.prompt.kind === 'interval'
      ? t('prompt.interval', { interval: t(`interval.${step.prompt.intervalId}`) })
      : t('prompt.degree', { degree: step.prompt.degreeIndex + 1 });
  }

  function handleStart() {
    setStatusMessage(null);
    const steps =
      exerciseKind === 'intervals'
        ? createIntervalSteps(difficulty, Math.random)
        : createScaleSteps(scaleId, rootNoteIndex);
    startTraining(exerciseKind, difficulty, steps);
  }

  async function handleSave() {
    if (trainingState.phase !== 'finished') return;
    setStatusMessage(null);
    const { summary } = trainingState;
    try {
      await saveMeasurement({
        values: {
          exercise: trainingState.exerciseKind === 'scales' ? `scale:${scaleId}` : 'intervals',
          difficulty: trainingState.difficulty,
          hitCount: summary.hitCount,
          stepCount: summary.roundCount,
          totalPoints: summary.totalPoints,
          ...(summary.meanAbsoluteCentsError !== null
            ? { meanAbsoluteCentsError: Math.round(summary.meanAbsoluteCentsError * 10) / 10 }
            : {}),
          missedTargets: trainingState.stepScores
            .filter((stepScore) => !stepScore.isHit)
            .map((stepScore) => noteName(stepScore.step.targetNoteIndex))
            .join(','),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    }
  }

  if (trainingState.phase === 'playing') {
    const currentStep = trainingState.steps[trainingState.stepIndex]!;
    const { roundProgress, stage } = trainingState;
    const { toleranceCents } = difficultySettings[trainingState.difficulty];
    const latestError = roundProgress.latestCentsError;
    const isInTune = latestError !== null && Math.abs(latestError) <= toleranceCents;
    const toleranceFraction = toleranceCents / (2 * meterRangeCents);
    const needleFraction =
      latestError === null
        ? null
        : 0.5 + Math.max(-meterRangeCents, Math.min(meterRangeCents, latestError)) / (2 * meterRangeCents);
    const startingNote = trainingState.steps[0]!.referenceNoteIndex;

    return (
      <ScreenContainer>
        <Card>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('stepOf', { step: trainingState.stepIndex + 1, total: trainingState.steps.length })}
          </BodyText>
          <BodyText style={styles.promptText}>{describeStep(currentStep)}</BodyText>
          {currentStep.referenceNoteIndex !== null ? (
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('fromNote', { note: noteName(currentStep.referenceNoteIndex) })}
            </BodyText>
          ) : startingNote !== null ? (
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('scaleFrom', { note: noteName(startingNote) })}
            </BodyText>
          ) : null}
          <BodyText style={styles.stageText} tone={stage === 'listening' ? 'accent' : 'secondary'}>
            {stage === 'reference'
              ? t('stage.listen')
              : stage === 'listening'
                ? t('stage.sing')
                : roundProgress.outcome === 'hit'
                  ? t('stage.hit', { note: noteName(currentStep.targetNoteIndex) })
                  : t('stage.missed', { note: noteName(currentStep.targetNoteIndex) })}
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
          {microphoneStatus.status === 'error' ? (
            <BodyText tone="danger">{t('microphoneError', { message: microphoneStatus.errorMessage })}</BodyText>
          ) : null}
        </Card>
        <BodyText tone="secondary" style={styles.centeredText}>
          {t('anyOctave')}
        </BodyText>
        <AppButton label={t('stop')} variant="secondary" onPress={stopTraining} />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      {trainingState.phase === 'finished' ? (
        <Card>
          <BodyText style={styles.finalScore}>
            {t('hits', { hits: trainingState.summary.hitCount, total: trainingState.summary.roundCount })}
          </BodyText>
          {trainingState.summary.meanAbsoluteCentsError !== null ? (
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('meanError', { cents: trainingState.summary.meanAbsoluteCentsError.toFixed(0) })}
            </BodyText>
          ) : null}
          {trainingState.stepScores.some((stepScore) => !stepScore.isHit) ? (
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('toPractice', {
                steps: trainingState.stepScores
                  .filter((stepScore) => !stepScore.isHit)
                  .map((stepScore) => describeStep(stepScore.step))
                  .join(' · '),
              })}
            </BodyText>
          ) : null}
          <AppButton label={t('core:common.save')} variant="secondary" onPress={() => void handleSave()} />
        </Card>
      ) : (
        <Card>
          {trainingState.microphoneErrorMessage ? (
            <BodyText tone="danger">{t('microphoneError', { message: trainingState.microphoneErrorMessage })}</BodyText>
          ) : null}
          <SectionTitle>{t('howTo.title')}</SectionTitle>
          <BodyText tone="secondary">{t(`howTo.${exerciseKind}`, { seconds: requiredHoldSeconds })}</BodyText>
        </Card>
      )}

      <SectionTitle>{t('exercise.title')}</SectionTitle>
      <ChipRow
        options={exerciseKinds}
        selectedOption={exerciseKind}
        labelFor={(option) => t(`exercise.${option}`)}
        onSelect={setExerciseKind}
      />
      {exerciseKind === 'scales' ? (
        <>
          <SectionTitle>{t('scale.title')}</SectionTitle>
          <ChipRow
            options={scaleIds}
            selectedOption={scaleId}
            labelFor={(option) => t(`scale.${option}`)}
            onSelect={setScaleId}
          />
          <SectionTitle>{t('root.title')}</SectionTitle>
          <ChipRow
            options={naturalRoots}
            selectedOption={rootNoteIndex}
            labelFor={noteName}
            onSelect={setRootNoteIndex}
          />
        </>
      ) : null}
      <SectionTitle>{t('difficulty.title')}</SectionTitle>
      <ChipRow
        options={difficulties}
        selectedOption={difficulty}
        labelFor={(option) => t(`difficulty.${option}`)}
        onSelect={setDifficulty}
      />
      <AppButton label={trainingState.phase === 'finished' ? t('again') : t('start')} onPress={handleStart} />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

function ChipRow<TOption extends string | number>({
  options,
  selectedOption,
  labelFor,
  onSelect,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  labelFor: (option: TOption) => string;
  onSelect: (option: TOption) => void;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}
          >
            <BodyText tone={isSelected ? 'accent' : 'primary'}>{labelFor(option)}</BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  centeredText: { textAlign: 'center' },
  promptText: { fontSize: 30, fontWeight: '700', textAlign: 'center' },
  stageText: { fontSize: 22, fontWeight: '600', textAlign: 'center' },
  meterTrack: { height: 14, borderRadius: 7, marginTop: 16, justifyContent: 'center' },
  toleranceZone: { position: 'absolute', height: 14, borderRadius: 7, opacity: 0.35 },
  meterNeedle: { position: 'absolute', width: 6, height: 30, borderRadius: 3, marginLeft: -3 },
  progressTrack: { height: 10, borderRadius: 5, overflow: 'hidden', marginTop: 16 },
  progressFill: { height: 10 },
  finalScore: { fontSize: 32, fontWeight: '700', textAlign: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  privacyNote: { fontSize: 13 },
});
