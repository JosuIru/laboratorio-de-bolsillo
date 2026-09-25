import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer } from '@/ui/components';

import { BubbleView } from './BubbleView';
import { applyLevelCalibration, type LevelCalibrationParameters } from './calibration';
import type { LevelMeasurementValues } from './schema';
import { useTiltAngles } from './useTiltAngles';

export const levelInstrumentId = 'example-level';

export function LevelScreen({
  calibrationParameters,
  saveMeasurement,
}: InstrumentScreenProps<LevelMeasurementValues, LevelCalibrationParameters>) {
  const { t } = useTranslation(levelInstrumentId);
  const rawTiltAngles = useTiltAngles();
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (!rawTiltAngles) {
    return (
      <ScreenContainer>
        <BodyText tone="secondary">{t('waiting')}</BodyText>
      </ScreenContainer>
    );
  }

  const tiltAngles = applyLevelCalibration(rawTiltAngles, calibrationParameters);

  async function handleSave() {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({ values: tiltAngles });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('instructions')}</BodyText>
      <BubbleView tiltAngles={tiltAngles} />
      <Card>
        <View style={styles.readingsRow}>
          <Reading label={t('fields.tiltX')} degrees={tiltAngles.tiltXDegrees} />
          <Reading label={t('fields.tiltY')} degrees={tiltAngles.tiltYDegrees} />
        </View>
      </Card>
      <AppButton label={t('core:common.save')} onPress={handleSave} isBusy={isSaving} />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
    </ScreenContainer>
  );
}

function Reading({ label, degrees }: { label: string; degrees: number }) {
  return (
    <View style={styles.reading}>
      <BodyText tone="secondary">{label}</BodyText>
      <BodyText style={styles.readingValue}>{`${degrees.toFixed(1)}°`}</BodyText>
    </View>
  );
}

const styles = StyleSheet.create({
  readingsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  reading: { alignItems: 'center', gap: 4 },
  readingValue: { fontSize: 32, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
