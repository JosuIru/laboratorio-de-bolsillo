import Storage from 'expo-sqlite/kv-store';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { NoteIndex } from '@/processing/dsp/musicalNotes';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import {
  advanceLock,
  type EscapePuzzle,
  type LockDefinition,
  lockCompletion,
  type LockProgress,
  maximumKnockCount,
  parseStoredPuzzles,
  type PhonePose,
  startLockProgress,
} from './escapeLocks';
import type { EscapeLocksMeasurementValues } from './schema';
import { useLockSensors } from './useLockSensors';

export const escapeLocksInstrumentId = 'escape-locks';

const puzzlesStorageKey = 'escape-locks.puzzles';

/** Hora actual; solo se llama desde manejadores de eventos y temporizadores, nunca al pintar. */
function currentTimeMilliseconds(): number {
  return Date.now();
}
const tickMilliseconds = 100;
const phonePoses: readonly PhonePose[] = ['face-down', 'upright', 'upside-down', 'left-side', 'right-side'];
const noteIndices = Array.from({ length: 12 }, (_, noteIndex) => noteIndex as NoteIndex);

function loadPuzzles(): EscapePuzzle[] {
  try {
    return parseStoredPuzzles(Storage.getItemSync(puzzlesStorageKey));
  } catch {
    return [];
  }
}

function savePuzzles(puzzles: readonly EscapePuzzle[]) {
  try {
    Storage.setItemSync(puzzlesStorageKey, JSON.stringify(puzzles));
  } catch {
    // Sin almacenamiento, los puzles duran lo que la pantalla abierta.
  }
}

type ScreenMode =
  | { view: 'list' }
  | { view: 'edit'; draft: EscapePuzzle }
  | {
      view: 'play';
      puzzle: EscapePuzzle;
      lockIndex: number;
      lockProgress: LockProgress;
      startedAt: number;
      isHintVisible: boolean;
    }
  | { view: 'solved'; puzzle: EscapePuzzle; elapsedSeconds: number };

export function EscapeLocksScreen({ saveMeasurement }: InstrumentScreenProps<EscapeLocksMeasurementValues>) {
  const { t } = useTranslation(escapeLocksInstrumentId);
  const themePalette = useThemePalette();
  const [puzzles, setPuzzles] = useState<EscapePuzzle[]>(loadPuzzles);
  const [screenMode, setScreenMode] = useState<ScreenMode>({ view: 'list' });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const currentLock = screenMode.view === 'play' ? screenMode.puzzle.locks[screenMode.lockIndex]! : null;
  const { takeReading, microphoneStatus } = useLockSensors(currentLock, screenMode.view === 'play');
  const takeReadingRef = useRef(takeReading);
  useEffect(() => {
    takeReadingRef.current = takeReading;
  }, [takeReading]);

  const isPlaying = screenMode.view === 'play';
  useEffect(() => {
    if (!isPlaying) return;
    const lockTimer = setInterval(() => {
      const lockReading = takeReadingRef.current();
      setScreenMode((previousMode) => {
        if (previousMode.view !== 'play') return previousMode;
        const lockDefinition = previousMode.puzzle.locks[previousMode.lockIndex]!;
        const lockProgress = advanceLock(
          lockDefinition,
          previousMode.lockProgress,
          lockReading,
          tickMilliseconds / 1000,
        );
        if (!lockProgress.isOpen) return { ...previousMode, lockProgress };
        const nextLockIndex = previousMode.lockIndex + 1;
        if (nextLockIndex >= previousMode.puzzle.locks.length) {
          return {
            view: 'solved',
            puzzle: previousMode.puzzle,
            elapsedSeconds: Math.round((currentTimeMilliseconds() - previousMode.startedAt) / 1000),
          };
        }
        return { ...previousMode, lockIndex: nextLockIndex, lockProgress: startLockProgress(), isHintVisible: false };
      });
    }, tickMilliseconds);
    return () => clearInterval(lockTimer);
  }, [isPlaying]);

  function describeLock(lockDefinition: LockDefinition, withAnswer: boolean): string {
    if (!withAnswer) return t(`lock.${lockDefinition.kind}.riddle`);
    switch (lockDefinition.kind) {
      case 'note':
        return t('lock.note.answer', { note: t(`notes.${lockDefinition.noteIndex}`) });
      case 'pose':
        return t('lock.pose.answer', { pose: t(`pose.${lockDefinition.pose}`) });
      case 'magnet':
        return t('lock.magnet.answer');
      case 'knocks':
        return t('lock.knocks.answer', { count: lockDefinition.knockCount });
    }
  }

  function persistPuzzles(updatedPuzzles: EscapePuzzle[]) {
    setPuzzles(updatedPuzzles);
    savePuzzles(updatedPuzzles);
  }

  function startPlaying(puzzle: EscapePuzzle) {
    setStatusMessage(null);
    setScreenMode({
      view: 'play',
      puzzle,
      lockIndex: 0,
      lockProgress: startLockProgress(),
      startedAt: currentTimeMilliseconds(),
      isHintVisible: false,
    });
  }

  async function handleSaveResult() {
    if (screenMode.view !== 'solved') return;
    try {
      await saveMeasurement({
        values: {
          puzzleName: screenMode.puzzle.name,
          lockCount: screenMode.puzzle.locks.length,
          elapsedSeconds: screenMode.elapsedSeconds,
          lockKinds: screenMode.puzzle.locks.map((lockDefinition) => lockDefinition.kind).join(','),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    }
  }

  const inputStyle = [styles.textInput, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  if (screenMode.view === 'play' && currentLock) {
    const completion = lockCompletion(currentLock, screenMode.lockProgress);
    return (
      <ScreenContainer>
        <Card>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('play.lockOf', { lock: screenMode.lockIndex + 1, total: screenMode.puzzle.locks.length })}
          </BodyText>
          <BodyText style={styles.lockTitle}>{t(`lock.${currentLock.kind}.title`)}</BodyText>
          <BodyText style={styles.centeredText}>{describeLock(currentLock, screenMode.isHintVisible)}</BodyText>
          <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
            <View
              style={[styles.progressFill, { width: `${completion * 100}%`, backgroundColor: themePalette.accent }]}
            />
          </View>
          {currentLock.kind === 'knocks' && screenMode.lockProgress.lastWrongKnockCount !== null ? (
            <BodyText tone="danger" style={styles.centeredText}>
              {t('play.wrongKnocks', { count: screenMode.lockProgress.lastWrongKnockCount })}
            </BodyText>
          ) : null}
          {microphoneStatus.status === 'error' ? (
            <BodyText tone="danger">{t('play.microphoneError', { message: microphoneStatus.errorMessage })}</BodyText>
          ) : null}
        </Card>
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton
              label={screenMode.isHintVisible ? t('play.hideHint') : t('play.showHint')}
              variant="secondary"
              onPress={() => setScreenMode({ ...screenMode, isHintVisible: !screenMode.isHintVisible })}
            />
          </View>
          <View style={styles.buttonCell}>
            <AppButton label={t('play.giveUp')} variant="secondary" onPress={() => setScreenMode({ view: 'list' })} />
          </View>
        </View>
      </ScreenContainer>
    );
  }

  if (screenMode.view === 'solved') {
    return (
      <ScreenContainer>
        <Card>
          <BodyText tone="accent" style={styles.lockTitle}>
            {t('solved.title')}
          </BodyText>
          <BodyText style={styles.secretText}>{screenMode.puzzle.secret}</BodyText>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('solved.time', {
              minutes: Math.floor(screenMode.elapsedSeconds / 60),
              seconds: String(screenMode.elapsedSeconds % 60).padStart(2, '0'),
            })}
          </BodyText>
        </Card>
        <AppButton label={t('core:common.save')} variant="secondary" onPress={() => void handleSaveResult()} />
        <AppButton label={t('solved.back')} onPress={() => setScreenMode({ view: 'list' })} />
        {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      </ScreenContainer>
    );
  }

  if (screenMode.view === 'edit') {
    const { draft } = screenMode;
    const updateDraft = (changedFields: Partial<EscapePuzzle>) =>
      setScreenMode({ view: 'edit', draft: { ...draft, ...changedFields } });
    const addLock = (lockDefinition: LockDefinition) => updateDraft({ locks: [...draft.locks, lockDefinition] });
    const canSave = draft.name.trim().length > 0 && draft.secret.trim().length > 0 && draft.locks.length > 0;
    return (
      <ScreenContainer>
        <Card>
          <SectionTitle>{t('edit.title')}</SectionTitle>
          <TextInput
            value={draft.name}
            onChangeText={(name) => updateDraft({ name })}
            placeholder={t('edit.namePlaceholder')}
            placeholderTextColor={themePalette.textSecondary}
            accessibilityLabel={t('edit.namePlaceholder')}
            style={inputStyle}
          />
          <TextInput
            value={draft.secret}
            onChangeText={(secret) => updateDraft({ secret })}
            placeholder={t('edit.secretPlaceholder')}
            placeholderTextColor={themePalette.textSecondary}
            accessibilityLabel={t('edit.secretPlaceholder')}
            style={inputStyle}
          />
        </Card>

        <Card>
          <SectionTitle>{t('edit.locksTitle')}</SectionTitle>
          {draft.locks.length === 0 ? <BodyText tone="secondary">{t('edit.noLocks')}</BodyText> : null}
          {draft.locks.map((lockDefinition, lockIndex) => (
            <View key={lockIndex} style={[styles.lockRow, { borderBottomColor: themePalette.border }]}>
              <BodyText
                style={styles.lockRowText}
              >{`${lockIndex + 1}. ${describeLock(lockDefinition, true)}`}</BodyText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('edit.removeLock')}
                onPress={() =>
                  updateDraft({ locks: draft.locks.filter((_, candidateIndex) => candidateIndex !== lockIndex) })
                }
              >
                <BodyText tone="danger">✕</BodyText>
              </Pressable>
            </View>
          ))}
        </Card>

        <Card>
          <SectionTitle>{t('lock.note.title')}</SectionTitle>
          <View style={styles.chipRow}>
            {noteIndices.map((noteIndex) => (
              <Chip
                key={noteIndex}
                label={t(`notes.${noteIndex}`)}
                onPress={() => addLock({ kind: 'note', noteIndex })}
              />
            ))}
          </View>
          <SectionTitle>{t('lock.pose.title')}</SectionTitle>
          <View style={styles.chipRow}>
            {phonePoses.map((pose) => (
              <Chip key={pose} label={t(`pose.${pose}`)} onPress={() => addLock({ kind: 'pose', pose })} />
            ))}
          </View>
          <SectionTitle>{t('lock.knocks.title')}</SectionTitle>
          <View style={styles.chipRow}>
            {Array.from({ length: maximumKnockCount - 1 }, (_, countIndex) => countIndex + 2).map((knockCount) => (
              <Chip
                key={knockCount}
                label={String(knockCount)}
                onPress={() => addLock({ kind: 'knocks', knockCount })}
              />
            ))}
          </View>
          <SectionTitle>{t('lock.magnet.title')}</SectionTitle>
          <View style={styles.chipRow}>
            <Chip label={t('edit.addMagnet')} onPress={() => addLock({ kind: 'magnet' })} />
          </View>
        </Card>

        <AppButton
          label={t('edit.save')}
          isDisabled={!canSave}
          onPress={() => {
            const existingIndex = puzzles.findIndex((puzzle) => puzzle.id === draft.id);
            const cleanedDraft = { ...draft, name: draft.name.trim(), secret: draft.secret.trim() };
            persistPuzzles(
              existingIndex >= 0
                ? puzzles.map((puzzle) => (puzzle.id === draft.id ? cleanedDraft : puzzle))
                : [...puzzles, cleanedDraft],
            );
            setScreenMode({ view: 'list' });
          }}
        />
        <AppButton label={t('edit.cancel')} variant="secondary" onPress={() => setScreenMode({ view: 'list' })} />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <Card>
        <SectionTitle>{t('list.title')}</SectionTitle>
        <BodyText tone="secondary">{t('list.intro')}</BodyText>
      </Card>
      {puzzles.map((puzzle) => (
        <Card key={puzzle.id}>
          <BodyText style={styles.puzzleName}>{puzzle.name}</BodyText>
          <BodyText tone="secondary">
            {puzzle.locks.map((lockDefinition) => t(`lock.${lockDefinition.kind}.title`)).join(' → ')}
          </BodyText>
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton label={t('list.play')} onPress={() => startPlaying(puzzle)} />
            </View>
            <View style={styles.buttonCell}>
              <AppButton
                label={t('list.edit')}
                variant="secondary"
                onPress={() => setScreenMode({ view: 'edit', draft: puzzle })}
              />
            </View>
            <View style={styles.buttonCell}>
              <AppButton
                label={t('list.delete')}
                variant="secondary"
                onPress={() => persistPuzzles(puzzles.filter((candidatePuzzle) => candidatePuzzle.id !== puzzle.id))}
              />
            </View>
          </View>
        </Card>
      ))}
      <AppButton
        label={t('list.create')}
        onPress={() =>
          setScreenMode({
            view: 'edit',
            draft: { id: `puzzle-${currentTimeMilliseconds()}`, name: '', secret: '', locks: [] },
          })
        }
      />
    </ScreenContainer>
  );
}

function Chip({ label, onPress }: { label: string; onPress: () => void }) {
  const themePalette = useThemePalette();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.chip, { borderColor: themePalette.border }]}>
      <BodyText>{label}</BodyText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  centeredText: { textAlign: 'center' },
  lockTitle: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  secretText: { fontSize: 36, fontWeight: '700', textAlign: 'center', marginVertical: 12 },
  progressTrack: { height: 12, borderRadius: 6, overflow: 'hidden', marginTop: 12 },
  progressFill: { height: 12 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  textInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 16, marginTop: 8 },
  lockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lockRowText: { flex: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  puzzleName: { fontSize: 18, fontWeight: '700' },
});
