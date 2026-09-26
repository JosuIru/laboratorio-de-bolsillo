import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { NoteIndex } from '@/processing/dsp/musicalNotes';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { TraditionalTunerMeasurementValues } from './schema';
import {
  type CustomTuning,
  loadTunerSettings,
  saveTunerSettings,
  setCustomTuningDegree,
  type TunerSettings,
} from './tunerStorage';
import {
  builtInTuningSystemIds,
  builtInTuningSystems,
  clampReferenceA4Hz,
  degreeCount,
  findTuningTarget,
  measureDegreeDeviation,
  measureDeviationFromDegree,
} from './tuningSystems';
import { useTunerPitch } from './useTunerPitch';

export const traditionalTunerInstrumentId = 'traditional-tuner';

/** Dentro de este margen la nota se da por afinada. */
const inTuneCents = 3;
/** La aguja llega hasta ±50 centésimas; más allá se queda en el tope. */
const gaugeRangeCents = 50;
const noteIndices = Array.from({ length: degreeCount }, (_, noteIndex) => noteIndex as NoteIndex);

export function TraditionalTunerScreen({ saveMeasurement }: InstrumentScreenProps<TraditionalTunerMeasurementValues>) {
  const { t } = useTranslation(traditionalTunerInstrumentId);
  const themePalette = useThemePalette();
  const [tunerSettings, setTunerSettings] = useState<TunerSettings>(loadTunerSettings);
  const [isListening, setIsListening] = useState(true);
  // Se afina con las manos ocupadas: la pantalla no debe apagarse mientras escucha.
  useKeepScreenOnWhile(isListening, 'traditional-tuner');
  const [newTuningName, setNewTuningName] = useState('');
  /** Grado de la tabla propia donde guardar la nota; null = el más cercano en temperamento igual. */
  const [chosenDegree, setChosenDegree] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const { microphoneStatus, pitchReading } = useTunerPitch({ isActive: isListening });

  const selectedCustomTuning = tunerSettings.customTunings.find(
    (customTuning) => customTuning.id === tunerSettings.selectedTuningId,
  );
  const centsByDegree =
    selectedCustomTuning?.centsByDegree ??
    builtInTuningSystems[tunerSettings.selectedTuningId as keyof typeof builtInTuningSystems] ??
    builtInTuningSystems.equal;

  const tuningTarget = useMemo(
    () =>
      pitchReading.stableFrequencyHz === null
        ? null
        : findTuningTarget(pitchReading.stableFrequencyHz, {
            referenceA4Hz: tunerSettings.referenceA4Hz,
            tonicNoteIndex: tunerSettings.tonicNoteIndex,
            centsByDegree,
          }),
    [pitchReading.stableFrequencyHz, tunerSettings.referenceA4Hz, tunerSettings.tonicNoteIndex, centsByDegree],
  );

  function updateTunerSettings(changedSettings: Partial<TunerSettings>) {
    setTunerSettings((previousSettings) => {
      const updatedSettings = { ...previousSettings, ...changedSettings };
      saveTunerSettings(updatedSettings);
      return updatedSettings;
    });
  }

  function replaceCustomTuning(updatedTuning: CustomTuning) {
    updateTunerSettings({
      customTunings: tunerSettings.customTunings.map((customTuning) =>
        customTuning.id === updatedTuning.id ? updatedTuning : customTuning,
      ),
    });
  }

  function handleCreateCustomTuning() {
    const trimmedName = newTuningName.trim();
    if (!trimmedName) return;
    const createdTuning: CustomTuning = {
      id: `custom-${Date.now()}`,
      name: trimmedName,
      centsByDegree: new Array<number>(degreeCount).fill(0),
    };
    updateTunerSettings({
      customTunings: [...tunerSettings.customTunings, createdTuning],
      selectedTuningId: createdTuning.id,
    });
    setNewTuningName('');
  }

  function handleDeleteSelectedTuning() {
    if (!selectedCustomTuning) return;
    updateTunerSettings({
      customTunings: tunerSettings.customTunings.filter((customTuning) => customTuning.id !== selectedCustomTuning.id),
      selectedTuningId: 'equal',
    });
  }

  const autoDetectedDegree =
    pitchReading.stableFrequencyHz === null
      ? null
      : (measureDegreeDeviation(pitchReading.stableFrequencyHz, tunerSettings.referenceA4Hz, tunerSettings.tonicNoteIndex)
          ?.degree ?? null);
  const degreeToStore = chosenDegree ?? autoDetectedDegree;
  const deviationToStore =
    pitchReading.stableFrequencyHz === null || degreeToStore === null
      ? null
      : measureDeviationFromDegree(
          pitchReading.stableFrequencyHz,
          tunerSettings.referenceA4Hz,
          tunerSettings.tonicNoteIndex,
          degreeToStore,
        );
  const noteNameOfDegree = (degree: number) => t(`notes.${(tunerSettings.tonicNoteIndex + degree) % degreeCount}`);

  function handleStoreCurrentNote() {
    if (!selectedCustomTuning || degreeToStore === null || deviationToStore === null) return;
    replaceCustomTuning(setCustomTuningDegree(selectedCustomTuning, degreeToStore, deviationToStore));
    setStatusMessage(
      t('custom.storedDegree', { note: noteNameOfDegree(degreeToStore), cents: formatSignedCents(deviationToStore) }),
    );
    setChosenDegree(null);
  }

  async function handleSave() {
    if (!tuningTarget || pitchReading.stableFrequencyHz === null) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          frequencyHz: Math.round(pitchReading.stableFrequencyHz * 100) / 100,
          noteName: `${t(`notes.${tuningTarget.noteIndex}`)}${tuningTarget.octave}`,
          targetFrequencyHz: Math.round(tuningTarget.targetFrequencyHz * 100) / 100,
          centsOffset: Math.round(tuningTarget.centsOffset * 10) / 10,
          tuningSystem: selectedCustomTuning ? selectedCustomTuning.name : tunerSettings.selectedTuningId,
          tonicNote: t(`notes.${tunerSettings.tonicNoteIndex}`),
          referenceA4Hz: tunerSettings.referenceA4Hz,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const isInTune = tuningTarget !== null && Math.abs(tuningTarget.centsOffset) <= inTuneCents;
  const needlePosition =
    tuningTarget === null
      ? 0.5
      : 0.5 + Math.max(-gaugeRangeCents, Math.min(gaugeRangeCents, tuningTarget.centsOffset)) / (2 * gaugeRangeCents);
  const inputStyle = [styles.textInput, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  return (
    <ScreenContainer>
      <Card>
        <View style={styles.noteDisplay}>
          <BodyText tone={isInTune ? 'accent' : 'primary'} style={styles.noteName}>
            {tuningTarget ? `${t(`notes.${tuningTarget.noteIndex}`)}${tuningTarget.octave}` : '—'}
          </BodyText>
          <BodyText style={styles.centsText}>
            {tuningTarget ? `${formatSignedCents(tuningTarget.centsOffset)} ct` : t('playANote')}
          </BodyText>
        </View>
        <View style={[styles.gaugeTrack, { backgroundColor: themePalette.border }]}>
          <View style={[styles.gaugeCenter, { backgroundColor: themePalette.textSecondary }]} />
          {tuningTarget ? (
            <View
              style={[
                styles.gaugeNeedle,
                {
                  left: `${needlePosition * 100}%`,
                  backgroundColor: isInTune ? themePalette.accent : themePalette.textPrimary,
                },
              ]}
            />
          ) : null}
        </View>
        <View style={styles.gaugeLabels}>
          <BodyText tone="secondary">{t('flat')}</BodyText>
          <BodyText tone="secondary">{t('sharp')}</BodyText>
        </View>
        {tuningTarget && pitchReading.stableFrequencyHz !== null ? (
          <BodyText tone="secondary" style={styles.frequencyText}>
            {t('frequencies', {
              measured: pitchReading.stableFrequencyHz.toFixed(2),
              target: tuningTarget.targetFrequencyHz.toFixed(2),
            })}
          </BodyText>
        ) : null}
        {microphoneStatus.status === 'error' ? (
          <BodyText tone="danger">{t('microphoneError', { message: microphoneStatus.errorMessage })}</BodyText>
        ) : null}
      </Card>

      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton
            label={isListening ? t('pause') : t('resume')}
            variant="secondary"
            onPress={() => setIsListening((wasListening) => !wasListening)}
          />
        </View>
        <View style={styles.buttonCell}>
          <AppButton
            label={t('core:common.save')}
            onPress={() => void handleSave()}
            isBusy={isSaving}
            isDisabled={!tuningTarget}
          />
        </View>
      </View>
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <Card>
        <SectionTitle>{t('reference.title')}</SectionTitle>
        <View style={styles.referenceRow}>
          <AppButton
            label="−1"
            variant="secondary"
            onPress={() => updateTunerSettings({ referenceA4Hz: clampReferenceA4Hz(tunerSettings.referenceA4Hz - 1) })}
          />
          <BodyText style={styles.referenceValue}>{`La4 = ${tunerSettings.referenceA4Hz} Hz`}</BodyText>
          <AppButton
            label="+1"
            variant="secondary"
            onPress={() => updateTunerSettings({ referenceA4Hz: clampReferenceA4Hz(tunerSettings.referenceA4Hz + 1) })}
          />
        </View>

        <SectionTitle>{t('system.title')}</SectionTitle>
        <View style={styles.chipRow}>
          {builtInTuningSystemIds.map((tuningSystemId) => (
            <Chip
              key={tuningSystemId}
              label={t(`system.${tuningSystemId}`)}
              isSelected={tunerSettings.selectedTuningId === tuningSystemId}
              onPress={() => updateTunerSettings({ selectedTuningId: tuningSystemId })}
            />
          ))}
          {tunerSettings.customTunings.map((customTuning) => (
            <Chip
              key={customTuning.id}
              label={customTuning.name}
              isSelected={tunerSettings.selectedTuningId === customTuning.id}
              onPress={() => updateTunerSettings({ selectedTuningId: customTuning.id })}
            />
          ))}
        </View>
        <BodyText tone="secondary">{t('system.hint')}</BodyText>

        <SectionTitle>{t('tonic.title')}</SectionTitle>
        <View style={styles.chipRow}>
          {noteIndices.map((noteIndex) => (
            <Chip
              key={noteIndex}
              label={t(`notes.${noteIndex}`)}
              isSelected={tunerSettings.tonicNoteIndex === noteIndex}
              onPress={() => updateTunerSettings({ tonicNoteIndex: noteIndex })}
            />
          ))}
        </View>
        <BodyText tone="secondary">{t('tonic.hint')}</BodyText>
      </Card>

      <Card>
        <SectionTitle>{t('custom.title')}</SectionTitle>
        <BodyText tone="secondary">{t('custom.hint')}</BodyText>
        {selectedCustomTuning ? (
          <>
            <View style={styles.degreeGrid}>
              {selectedCustomTuning.centsByDegree.map((degreeCents, degree) => {
                const isChosen = degree === degreeToStore;
                return (
                  <Pressable
                    key={degree}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isChosen }}
                    onPress={() => setChosenDegree((previousDegree) => (previousDegree === degree ? null : degree))}
                    style={[styles.degreeCell, { borderColor: isChosen ? themePalette.accent : themePalette.border }]}>
                    <BodyText tone={isChosen ? 'accent' : 'secondary'}>{noteNameOfDegree(degree)}</BodyText>
                    <BodyText>{formatSignedCents(degreeCents)}</BodyText>
                  </Pressable>
                );
              })}
            </View>
            <BodyText tone="secondary">{t('custom.chooseDegreeHint')}</BodyText>
            <AppButton
              label={
                degreeToStore === null
                  ? t('custom.storeCurrentNote')
                  : t('custom.storeInDegree', { note: noteNameOfDegree(degreeToStore) })
              }
              onPress={handleStoreCurrentNote}
              isDisabled={deviationToStore === null}
            />
            {degreeToStore !== null && pitchReading.stableFrequencyHz !== null && deviationToStore === null ? (
              <BodyText tone="danger">{t('custom.tooFarFromDegree')}</BodyText>
            ) : null}
            <AppButton label={t('custom.delete')} variant="secondary" onPress={handleDeleteSelectedTuning} />
          </>
        ) : null}
        <View style={styles.createRow}>
          <TextInput
            value={newTuningName}
            onChangeText={setNewTuningName}
            placeholder={t('custom.namePlaceholder')}
            placeholderTextColor={themePalette.textSecondary}
            accessibilityLabel={t('custom.namePlaceholder')}
            style={[inputStyle, styles.nameInput]}
          />
          <AppButton label={t('custom.create')} onPress={handleCreateCustomTuning} isDisabled={!newTuningName.trim()} />
        </View>
      </Card>
    </ScreenContainer>
  );
}

function formatSignedCents(centsValue: number): string {
  const roundedCents = Math.round(centsValue) || 0;
  return `${roundedCents > 0 ? '+' : ''}${roundedCents}`;
}

function Chip({ label, isSelected, onPress }: { label: string; isSelected: boolean; onPress: () => void }) {
  const themePalette = useThemePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: isSelected }}
      onPress={onPress}
      style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
      <BodyText tone={isSelected ? 'accent' : 'primary'}>{label}</BodyText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  noteDisplay: { alignItems: 'center', gap: 4 },
  noteName: { fontSize: 56, fontWeight: '700', lineHeight: 64 },
  centsText: { fontSize: 20, fontWeight: '600', fontVariant: ['tabular-nums'] },
  gaugeTrack: { height: 12, borderRadius: 6, marginTop: 12, justifyContent: 'center' },
  gaugeCenter: { position: 'absolute', left: '50%', width: 2, height: 20, marginLeft: -1 },
  gaugeNeedle: { position: 'absolute', width: 6, height: 28, borderRadius: 3, marginLeft: -3 },
  gaugeLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  frequencyText: { textAlign: 'center', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  referenceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  referenceValue: { fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  degreeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  degreeCell: { width: 64, alignItems: 'center', paddingVertical: 6, borderWidth: 1, borderRadius: 8 },
  createRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  textInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 16 },
  nameInput: { flex: 1 },
});
