import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { SensorAvailability } from '@/core/sensors/types';
import type { AcousticBandPreset } from '@/processing/modem/acousticModem';
import { AppButton, BodyText, Card } from '@/ui/components';

import { modemStyles, PermissionNotice } from './modemControls';
import { phoneModemInstrumentId } from './modemConfiguration';
import type { SelfTestState } from './useAcousticSelfTest';

interface SoundSelfTestCardProps {
  selfTestState: SelfTestState;
  microphoneAvailability: SensorAvailability;
  onRun(): void;
  onCancel(): void;
  onUseBand(bandPreset: AcousticBandPreset): void;
}

/** Autoprueba del canal de sonido: el móvil se manda un mensaje a sí mismo en cada banda. */
export function SoundSelfTestCard({
  selfTestState,
  microphoneAvailability,
  onRun,
  onCancel,
  onUseBand,
}: SoundSelfTestCardProps) {
  const { t } = useTranslation(phoneModemInstrumentId);
  const isRunning = selfTestState.phase === 'running';

  return (
    <Card>
      <BodyText>{t('selfTest.title')}</BodyText>
      <BodyText tone="secondary" style={modemStyles.smallText}>
        {t('selfTest.help')}
      </BodyText>
      {microphoneAvailability.status !== 'available' ? (
        <PermissionNotice sensorAvailability={microphoneAvailability} />
      ) : (
        <AppButton
          label={isRunning ? t('selfTest.cancel') : t('selfTest.run')}
          onPress={isRunning ? onCancel : onRun}
          variant="secondary"
        />
      )}
      {selfTestState.phase === 'running' ? (
        <BodyText tone="secondary">{t('selfTest.running', { band: t(`bands.${selfTestState.currentBand}`) })}</BodyText>
      ) : null}
      {selfTestState.phase === 'error' ? (
        <BodyText tone="danger">{t('core:common.error', { message: selfTestState.errorMessage })}</BodyText>
      ) : null}
      {selfTestState.phase === 'done' ? (
        <>
          {selfTestState.bandResults.map((bandResult) => (
            <View key={bandResult.bandPreset} style={styles.resultRow}>
              <BodyText style={styles.resultBand}>{t(`bands.${bandResult.bandPreset}`)}</BodyText>
              <BodyText
                tone={bandResult.outcome === 'received' ? 'accent' : 'danger'}
                style={modemStyles.smallText}>
                {bandResult.qualityScore !== null
                  ? t(`selfTest.outcomes.${bandResult.outcome}WithQuality`, {
                      percent: Math.round(bandResult.qualityScore * 100),
                    })
                  : t(`selfTest.outcomes.${bandResult.outcome}`)}
              </BodyText>
            </View>
          ))}
          {selfTestState.recommendedBand ? (
            <AppButton
              label={t('selfTest.useBand', { band: t(`bands.${selfTestState.recommendedBand}`) })}
              onPress={() => onUseBand(selfTestState.recommendedBand!)}
            />
          ) : (
            <BodyText tone="danger">{t('selfTest.noBand')}</BodyText>
          )}
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  resultRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  resultBand: { flex: 1 },
});
