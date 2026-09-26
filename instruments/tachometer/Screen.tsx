import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer } from '@/ui/components';

import {
  frequencyToRevolutionsPerMinute,
  maximumPulsesPerRevolution,
  minimumPulsesPerRevolution,
  roundWithUncertainty,
} from './rpmReading';
import type { TachometerMeasurementValues } from './schema';
import { useTachometerMicrophone } from './useTachometerMicrophone';

export const tachometerInstrumentId = 'tachometer';


export function TachometerScreen({ saveMeasurement }: InstrumentScreenProps<TachometerMeasurementValues>) {
  const { t } = useTranslation(tachometerInstrumentId);
  const [isRunning, setIsRunning] = useState(true);
  const [pulsesPerRevolution, setPulsesPerRevolution] = useState(1);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { microphoneState, isListening } = useTachometerMicrophone({ isRunning });

  if (microphoneState.status === 'error') {
    return (
      <ScreenContainer>
        <BodyText tone="danger">{t('core:common.error', { message: microphoneState.errorMessage })}</BodyText>
      </ScreenContainer>
    );
  }
  if (microphoneState.status === 'starting' || (microphoneState.status === 'running' && !microphoneState.frame)) {
    return <LoadingState label={t('starting')} />;
  }
  if (!microphoneState.frame) {
    // En pausa antes de la primera lectura: no hay nada que mostrar, pero sí se puede reanudar.
    return (
      <ScreenContainer>
        <BodyText tone="secondary">{t('paused')}</BodyText>
        <AppButton label={t('resume')} onPress={() => setIsRunning(true)} variant="secondary" />
      </ScreenContainer>
    );
  }

  const { frame } = microphoneState;
  const { stabilizedReading, latestEstimate } = frame;
  const revolutionsPerMinute = stabilizedReading
    ? frequencyToRevolutionsPerMinute(stabilizedReading.medianFrequencyHz, pulsesPerRevolution)
    : null;
  // Solo se muestran las cifras que permite la incertidumbre (resolución afinada y dispersión).
  const roundedReading =
    stabilizedReading && revolutionsPerMinute !== null
      ? roundWithUncertainty(
          revolutionsPerMinute,
          frequencyToRevolutionsPerMinute(stabilizedReading.frequencyUncertaintyHz, pulsesPerRevolution),
        )
      : null;
  const stabilityLabel = !stabilizedReading
    ? t('noTone')
    : stabilizedReading.isStable
      ? t('stable')
      : t('unstable');

  async function handleSave() {
    if (!stabilizedReading || revolutionsPerMinute === null) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          revolutionsPerMinute: Math.round(revolutionsPerMinute),
          pulseFrequencyHz: Math.round(stabilizedReading.medianFrequencyHz * 100) / 100,
          pulsesPerRevolution,
          relativeSpread: Math.round(stabilizedReading.relativeSpread * 10_000) / 10_000,
          isStable: stabilizedReading.isStable,
          detectedHarmonicCount: latestEstimate?.detectedHarmonicCount ?? 0,
          sampleRateHz: frame.sampleRateHz,
          fftSize: frame.fftSize,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScreenContainer>
      <Card style={styles.readingCard}>
        <BodyText tone="secondary" style={styles.readingLabel}>
          {t('fields.revolutionsPerMinute')}
        </BodyText>
        <View accessibilityLiveRegion="polite">
          <BodyText style={styles.readingValue}>
            {roundedReading ? `${roundedReading.roundedValue.toLocaleString()} rpm` : '—'}
          </BodyText>
          {roundedReading && roundedReading.roundedUncertainty > 0 ? (
            <BodyText tone="secondary">
              {t('uncertaintyValue', { uncertainty: roundedReading.roundedUncertainty.toLocaleString() })}
            </BodyText>
          ) : null}
        </View>
        <BodyText tone={stabilizedReading?.isStable ? 'accent' : 'secondary'}>{stabilityLabel}</BodyText>
        {stabilizedReading ? (
          <BodyText tone="secondary">
            {t('pulseFrequencyValue', { frequency: stabilizedReading.medianFrequencyHz.toFixed(1) })}
          </BodyText>
        ) : null}
      </Card>

      <Card>
        <BodyText>{t('fields.pulsesPerRevolution')}</BodyText>
        <View style={styles.stepperRow}>
          <View style={styles.stepperButton}>
            <AppButton
              label="−"
              variant="secondary"
              isDisabled={pulsesPerRevolution <= minimumPulsesPerRevolution}
              onPress={() => setPulsesPerRevolution((previousPulses) => Math.max(minimumPulsesPerRevolution, previousPulses - 1))}
            />
          </View>
          <View style={styles.stepperValueCell} accessible accessibilityLabel={t('pulsesAccessibility', { count: pulsesPerRevolution })}>
            <BodyText style={styles.stepperValue}>{pulsesPerRevolution}</BodyText>
          </View>
          <View style={styles.stepperButton}>
            <AppButton
              label="+"
              variant="secondary"
              isDisabled={pulsesPerRevolution >= maximumPulsesPerRevolution}
              onPress={() => setPulsesPerRevolution((previousPulses) => Math.min(maximumPulsesPerRevolution, previousPulses + 1))}
            />
          </View>
        </View>
        <BodyText tone="secondary" style={styles.hintText}>
          {t('pulsesHint')}
        </BodyText>
      </Card>

      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton
            label={isRunning ? t('pause') : t('resume')}
            onPress={() => setIsRunning((wasRunning) => !wasRunning)}
            variant="secondary"
          />
        </View>
        <View style={styles.buttonCell}>
          <AppButton
            label={t('core:common.save')}
            onPress={() => void handleSave()}
            isBusy={isSaving}
            isDisabled={revolutionsPerMinute === null}
          />
        </View>
      </View>
      {!isListening ? <BodyText tone="secondary">{t('paused')}</BodyText> : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.hintText}>
        {t('howTo')}
      </BodyText>
      <BodyText tone="secondary" style={styles.hintText}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  readingCard: { alignItems: 'center', paddingVertical: 24, gap: 4 },
  readingLabel: { fontSize: 13 },
  readingValue: { fontSize: 44, lineHeight: 52, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepperButton: { width: 56 },
  stepperValueCell: { flex: 1 },
  stepperValue: { textAlign: 'center', fontSize: 24, fontWeight: '600', fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  hintText: { fontSize: 13 },
});
