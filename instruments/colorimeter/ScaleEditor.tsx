import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { AppButton, BodyText, Card } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import type { UserColorScale } from './colorimeterEngine';

export const colorimeterInstrumentId = 'colorimeter';

interface ScaleEditorProps {
  scales: UserColorScale[];
  selectedScaleId: string | null;
  /** Color corregido que se está midiendo ahora, para añadirlo a la escala. */
  currentSampleHex: string | null;
  onScalesChange(updatedScales: UserColorScale[]): void;
  onSelectScale(scaleId: string | null): void;
}

/**
 * Escalas del usuario: se crean con nombre y unidad, y cada color se añade midiéndolo con la
 * cámara (p. ej. apuntando a cada cuadro de la carta del fabricante de las tiras).
 */
export function ScaleEditor({ scales, selectedScaleId, currentSampleHex, onScalesChange, onSelectScale }: ScaleEditorProps) {
  const { t } = useTranslation(colorimeterInstrumentId);
  const themePalette = useThemePalette();
  const [newScaleName, setNewScaleName] = useState('');
  const [newScaleUnit, setNewScaleUnit] = useState('');
  const [entryLabel, setEntryLabel] = useState('');
  const [entryValueText, setEntryValueText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const selectedScale = scales.find((scale) => scale.id === selectedScaleId) ?? null;
  const inputStyle = [styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  function handleCreateScale() {
    if (!newScaleName.trim()) return;
    const createdScale: UserColorScale = { id: randomUUID(), name: newScaleName.trim(), unit: newScaleUnit.trim(), entries: [] };
    onScalesChange([...scales, createdScale]);
    onSelectScale(createdScale.id);
    setNewScaleName('');
    setNewScaleUnit('');
  }

  function handleAddEntry() {
    const entryValue = parseDecimalInput(entryValueText);
    if (!selectedScale || !currentSampleHex || entryValue === null) {
      setErrorMessage(t('scales.entryInvalid'));
      return;
    }
    setErrorMessage(null);
    const updatedEntries = [
      ...selectedScale.entries,
      { label: entryLabel.trim() || entryValueText.trim(), value: entryValue, hexColor: currentSampleHex },
    ].sort((leftEntry, rightEntry) => leftEntry.value - rightEntry.value);
    onScalesChange(scales.map((scale) => (scale.id === selectedScale.id ? { ...scale, entries: updatedEntries } : scale)));
    setEntryLabel('');
    setEntryValueText('');
  }

  function handleRemoveEntry(entryIndex: number) {
    if (!selectedScale) return;
    onScalesChange(
      scales.map((scale) =>
        scale.id === selectedScale.id
          ? { ...scale, entries: scale.entries.filter((_, candidateIndex) => candidateIndex !== entryIndex) }
          : scale,
      ),
    );
  }

  function handleDeleteScale() {
    if (!selectedScale) return;
    onScalesChange(scales.filter((scale) => scale.id !== selectedScale.id));
    onSelectScale(null);
  }

  return (
    <Card>
      <BodyText style={styles.title}>{t('scales.title')}</BodyText>
      <View style={styles.chipRow}>
        <Chip label={t('scales.none')} isSelected={selectedScaleId === null} onPress={() => onSelectScale(null)} />
        {scales.map((scale) => (
          <Chip
            key={scale.id}
            label={scale.name}
            isSelected={scale.id === selectedScaleId}
            onPress={() => onSelectScale(scale.id)}
          />
        ))}
      </View>

      {selectedScale ? (
        <View style={styles.section}>
          {selectedScale.entries.length === 0 ? <BodyText tone="secondary">{t('scales.emptyScale')}</BodyText> : null}
          {selectedScale.entries.map((entry, entryIndex) => (
            <View key={`${entry.label}-${entryIndex}`} style={styles.entryRow}>
              <View style={[styles.entrySwatch, { backgroundColor: entry.hexColor, borderColor: themePalette.border }]} />
              <BodyText style={styles.entryText}>
                {`${entry.label} · ${entry.value}${selectedScale.unit ? ` ${selectedScale.unit}` : ''}`}
              </BodyText>
              <Pressable accessibilityRole="button" onPress={() => handleRemoveEntry(entryIndex)} hitSlop={8}>
                <BodyText tone="danger">{t('core:common.delete')}</BodyText>
              </Pressable>
            </View>
          ))}
          <BodyText tone="secondary">{t('scales.addHint')}</BodyText>
          <View style={styles.inputRow}>
            <TextInput
              value={entryLabel}
              onChangeText={setEntryLabel}
              placeholder={t('scales.entryLabel')}
              placeholderTextColor={themePalette.textSecondary}
              style={[inputStyle, styles.flexInput]}
            />
            <TextInput
              value={entryValueText}
              onChangeText={setEntryValueText}
              keyboardType="decimal-pad"
              placeholder={t('scales.entryValue')}
              placeholderTextColor={themePalette.textSecondary}
              style={[inputStyle, styles.flexInput]}
            />
          </View>
          {errorMessage ? <BodyText tone="danger">{errorMessage}</BodyText> : null}
          <AppButton
            label={t('scales.addCurrentColor')}
            onPress={handleAddEntry}
            variant="secondary"
            isDisabled={!currentSampleHex}
          />
          <AppButton label={t('scales.deleteScale')} onPress={handleDeleteScale} variant="danger" />
        </View>
      ) : null}

      <View style={styles.section}>
        <BodyText tone="secondary">{t('scales.newScale')}</BodyText>
        <View style={styles.inputRow}>
          <TextInput
            value={newScaleName}
            onChangeText={setNewScaleName}
            placeholder={t('scales.scaleName')}
            placeholderTextColor={themePalette.textSecondary}
            style={[inputStyle, styles.flexInput]}
          />
          <TextInput
            value={newScaleUnit}
            onChangeText={setNewScaleUnit}
            placeholder={t('scales.scaleUnit')}
            placeholderTextColor={themePalette.textSecondary}
            style={[inputStyle, styles.unitInput]}
          />
        </View>
        <AppButton label={t('scales.create')} onPress={handleCreateScale} variant="secondary" isDisabled={!newScaleName.trim()} />
      </View>
    </Card>
  );
}

function Chip({ label, isSelected, onPress }: { label: string; isSelected: boolean; onPress(): void }) {
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
  title: { fontWeight: '600' },
  section: { gap: 8, marginTop: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  entrySwatch: { width: 28, height: 28, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  entryText: { flex: 1 },
  inputRow: { flexDirection: 'row', gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  flexInput: { flex: 1 },
  unitInput: { width: 90 },
});
