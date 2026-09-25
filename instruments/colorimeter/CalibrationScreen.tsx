import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { CalibrationScreenProps } from '@/core/calibration/types';
import { hexToRgb8 } from '@/processing/color/colorSpaces';
import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import {
  type ColorimeterCalibrationParameters,
  createCardFromPreset,
  defaultReferenceCard,
  maximumPatchCount,
  type ReferenceCard,
  type ReferenceCardPresetId,
  validateColorimeterCalibration,
} from './referenceCards';
import { colorimeterInstrumentId } from './ScaleEditor';

const presetIds: ReferenceCardPresetId[] = ['white-paper', 'colorchecker-six'];

/** Elegir la tarjeta de referencia: un preajuste o parches propios con su color real. */
export function ColorimeterCalibrationScreen({
  activeProfile,
  saveProfile,
  cancel,
}: CalibrationScreenProps<ColorimeterCalibrationParameters>) {
  const { t } = useTranslation(colorimeterInstrumentId);
  const themePalette = useThemePalette();
  const [editedCard, setEditedCard] = useState<ReferenceCard>(activeProfile?.parameters.card ?? defaultReferenceCard);
  const [profileName, setProfileName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const inputStyle = [styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  function updatePatch(patchIndex: number, changedFields: { name?: string; hexColor?: string }) {
    setEditedCard((previousCard) => ({
      presetId: 'custom',
      patches: previousCard.patches.map((patch, candidateIndex) =>
        candidateIndex === patchIndex ? { ...patch, ...changedFields } : patch,
      ),
    }));
  }

  async function handleSave() {
    let parameters: ColorimeterCalibrationParameters;
    try {
      parameters = validateColorimeterCalibration({ card: editedCard });
    } catch {
      setErrorMessage(t('card.invalid'));
      return;
    }
    setIsSaving(true);
    try {
      await saveProfile(profileName || t(`card.preset.${editedCard.presetId}`), parameters);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card>
      <BodyText>{t('card.instructions')}</BodyText>
      <View style={styles.chipRow}>
        {presetIds.map((presetId) => {
          const isSelectedPreset = editedCard.presetId === presetId;
          return (
            <Pressable
              key={presetId}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedPreset }}
              onPress={() => setEditedCard(createCardFromPreset(presetId))}
              style={[styles.chip, { borderColor: isSelectedPreset ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelectedPreset ? 'accent' : 'primary'}>{t(`card.preset.${presetId}`)}</BodyText>
            </Pressable>
          );
        })}
      </View>

      {editedCard.patches.map((patch, patchIndex) => {
        const isValidColor = hexToRgb8(patch.hexColor) !== null;
        return (
          <View key={patch.id} style={styles.patchRow}>
            <View
              style={[
                styles.patchSwatch,
                { backgroundColor: isValidColor ? patch.hexColor : 'transparent', borderColor: themePalette.border },
              ]}
            />
            <TextInput
              value={patch.name}
              onChangeText={(name) => updatePatch(patchIndex, { name })}
              placeholder={t('card.patchName')}
              placeholderTextColor={themePalette.textSecondary}
              style={[inputStyle, styles.nameInput]}
            />
            <TextInput
              value={patch.hexColor}
              onChangeText={(hexColor) => updatePatch(patchIndex, { hexColor })}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="#RRGGBB"
              placeholderTextColor={themePalette.textSecondary}
              style={[inputStyle, styles.hexInput, !isValidColor ? { borderColor: themePalette.danger } : null]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('core:common.delete')}
              hitSlop={8}
              disabled={editedCard.patches.length <= 1}
              onPress={() =>
                setEditedCard((previousCard) => ({
                  presetId: 'custom',
                  patches: previousCard.patches.filter((_, candidateIndex) => candidateIndex !== patchIndex),
                }))
              }>
              <BodyText tone="danger">✕</BodyText>
            </Pressable>
          </View>
        );
      })}
      <AppButton
        label={t('card.addPatch')}
        variant="secondary"
        isDisabled={editedCard.patches.length >= maximumPatchCount}
        onPress={() =>
          setEditedCard((previousCard) => ({
            presetId: 'custom',
            patches: [
              ...previousCard.patches,
              { id: `patch-${Date.now()}`, name: `${previousCard.patches.length + 1}`, hexColor: '#808080' },
            ],
          }))
        }
      />
      <TextInput
        value={profileName}
        onChangeText={setProfileName}
        placeholder={t('core:calibration.profileName')}
        placeholderTextColor={themePalette.textSecondary}
        style={inputStyle}
      />
      {errorMessage ? <BodyText tone="danger">{errorMessage}</BodyText> : null}
      <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
      <AppButton label={t('core:common.cancel')} onPress={cancel} variant="secondary" />
    </Card>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  patchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  patchSwatch: { width: 28, height: 28, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  nameInput: { flex: 1 },
  hexInput: { width: 100, fontVariant: ['tabular-nums'] },
});
