import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput } from 'react-native';

import type { CalibrationScreenProps } from '@/core/calibration/types';
import { mean } from '@/processing/signal/smoothing';
import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import {
  computeDecibelOffset,
  parseDecimalInput,
  type SoundLevelCalibrationParameters,
  validateSoundLevelCalibration,
} from './calibration';
import { audioSpectrumInstrumentId } from './Screen';
import { useMicrophoneAnalyser } from './useMicrophoneAnalyser';

/** Tramas que se promedian (~3 s a 20 tramas/s) para una lectura estable. */
const averagedFrameCount = 60;

/**
 * Calibración contra un sonómetro: se pone un sonido estable (ruido rosa, un tono, un
 * ventilador), se anota lo que marca el sonómetro junto al móvil y se guarda el desplazamiento.
 */
export function AudioSpectrumCalibrationScreen({
  saveProfile,
  cancel,
}: CalibrationScreenProps<SoundLevelCalibrationParameters>) {
  const { t } = useTranslation(audioSpectrumInstrumentId);
  const themePalette = useThemePalette();
  const { microphoneState } = useMicrophoneAnalyser({ isRunning: true, frequencyScale: 'linear' });
  const recentLevels = useRef<number[]>([]);
  const [averagedLevelDecibelsFullScale, setAveragedLevelDecibelsFullScale] = useState<number | null>(null);
  const [referenceLevelText, setReferenceLevelText] = useState('');
  const [profileName, setProfileName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const latestLevel =
    microphoneState.status === 'running' && microphoneState.frame
      ? microphoneState.frame.analysis.levelDecibelsFullScale
      : null;
  const frameRevision = microphoneState.status === 'running' ? microphoneState.frame?.revision : undefined;

  useEffect(() => {
    if (latestLevel === null) return;
    recentLevels.current.push(latestLevel);
    if (recentLevels.current.length > averagedFrameCount) recentLevels.current.shift();
    // Se promedia en potencia (no en dB) para no infravalorar los picos.
    const averagedPower = mean(recentLevels.current.map((levelDecibels) => 10 ** (levelDecibels / 10)));
    setAveragedLevelDecibelsFullScale(10 * Math.log10(averagedPower));
  }, [frameRevision, latestLevel]);

  async function handleSave() {
    const referenceLevelDecibels = parseDecimalInput(referenceLevelText);
    if (referenceLevelDecibels === null || averagedLevelDecibelsFullScale === null) {
      setErrorMessage(t('calibration.invalidReference'));
      return;
    }
    let parameters: SoundLevelCalibrationParameters;
    try {
      parameters = validateSoundLevelCalibration({
        decibelOffset: computeDecibelOffset(referenceLevelDecibels, averagedLevelDecibelsFullScale),
      });
    } catch {
      setErrorMessage(t('calibration.implausible'));
      return;
    }
    setIsSaving(true);
    try {
      await saveProfile(profileName, parameters);
    } finally {
      setIsSaving(false);
    }
  }

  const inputStyle = [styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }];
  return (
    <Card>
      <BodyText>{t('calibration.instructions')}</BodyText>
      {microphoneState.status === 'error' ? (
        <BodyText tone="danger">{t('core:common.error', { message: microphoneState.errorMessage })}</BodyText>
      ) : (
        <BodyText style={styles.levelReading}>
          {averagedLevelDecibelsFullScale !== null ? `${averagedLevelDecibelsFullScale.toFixed(1)} dBFS` : '…'}
        </BodyText>
      )}
      <TextInput
        value={referenceLevelText}
        onChangeText={setReferenceLevelText}
        keyboardType="decimal-pad"
        placeholder={t('calibration.referencePlaceholder')}
        placeholderTextColor={themePalette.textSecondary}
        style={inputStyle}
      />
      <TextInput
        value={profileName}
        onChangeText={setProfileName}
        placeholder={t('core:calibration.profileName')}
        placeholderTextColor={themePalette.textSecondary}
        style={inputStyle}
      />
      {errorMessage ? <BodyText tone="danger">{errorMessage}</BodyText> : null}
      <AppButton
        label={t('core:common.save')}
        onPress={() => void handleSave()}
        isBusy={isSaving}
        isDisabled={averagedLevelDecibelsFullScale === null}
      />
      <AppButton label={t('core:common.cancel')} onPress={cancel} variant="secondary" />
    </Card>
  );
}

const styles = StyleSheet.create({
  levelReading: { fontSize: 28, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'center' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
