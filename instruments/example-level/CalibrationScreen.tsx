import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput } from 'react-native';

import type { CalibrationScreenProps } from '@/core/calibration/types';
import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { LevelCalibrationParameters } from './calibration';
import { levelInstrumentId } from './Screen';
import { useTiltAngles } from './useTiltAngles';

/** Guarda como desfase la inclinación que mide el móvil sobre una superficie a nivel. */
export function LevelCalibrationScreen({ saveProfile, cancel }: CalibrationScreenProps<LevelCalibrationParameters>) {
  const { t } = useTranslation(levelInstrumentId);
  const themePalette = useThemePalette();
  const rawTiltAngles = useTiltAngles();
  const [profileName, setProfileName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  async function handleSave() {
    if (!rawTiltAngles) return;
    setIsSaving(true);
    try {
      await saveProfile(profileName, {
        offsetXDegrees: rawTiltAngles.tiltXDegrees,
        offsetYDegrees: rawTiltAngles.tiltYDegrees,
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card>
      <BodyText>{t('calibration.instructions')}</BodyText>
      {rawTiltAngles ? (
        <BodyText tone="secondary">
          {t('calibration.currentReading', {
            tiltX: rawTiltAngles.tiltXDegrees.toFixed(2),
            tiltY: rawTiltAngles.tiltYDegrees.toFixed(2),
          })}
        </BodyText>
      ) : null}
      <TextInput
        value={profileName}
        onChangeText={setProfileName}
        placeholder={t('core:calibration.profileName')}
        placeholderTextColor={themePalette.textSecondary}
        style={[styles.nameInput, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
      />
      <AppButton label={t('core:common.save')} onPress={handleSave} isBusy={isSaving} isDisabled={!rawTiltAngles} />
      <AppButton label={t('core:common.cancel')} onPress={cancel} variant="secondary" />
    </Card>
  );
}

const styles = StyleSheet.create({
  nameInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
