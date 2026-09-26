import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { LockedCameraSettings } from '@/core/camera/useLockedCameraSettings';
import { formatExposureDuration } from '@/processing/image/lunarExposure';
import { AppButton, BodyText, Card } from '@/ui/components';

import { colorimeterInstrumentId } from './ScaleEditor';

/**
 * Estado de la «Cámara fijada» (`useLockedCameraSettings`) con sus botones. Lo comparten los
 * instrumentos que miden color con la cámara; los textos están en el espacio del colorímetro.
 */
export function LockedCameraPanel({
  lockedCamera,
  isEnabled,
  onEnabledChange,
  waitingForTargetHint,
}: {
  lockedCamera: LockedCameraSettings;
  isEnabled: boolean;
  onEnabledChange: (isEnabled: boolean) => void;
  /** Qué hay que colocar para fijar, en palabras del instrumento. */
  waitingForTargetHint?: string;
}) {
  const { t } = useTranslation(colorimeterInstrumentId);
  const { status, lockedExposure, isWhiteBalanceLocked, exposureOutcome } = lockedCamera;

  if (status === 'unsupported') {
    return (
      <Card>
        <BodyText tone="secondary">{t('lockedCamera.status.unsupported')}</BodyText>
      </Card>
    );
  }

  let statusText: string;
  if (status === 'locked') {
    if (lockedExposure && isWhiteBalanceLocked) statusText = t('lockedCamera.status.locked');
    else if (lockedExposure) statusText = t('lockedCamera.status.lockedExposureOnly');
    else statusText = t('lockedCamera.status.lockedWhiteBalanceOnly');
  } else if (status === 'waitingForTarget') {
    statusText = waitingForTargetHint ?? t('lockedCamera.status.waitingForTarget');
  } else {
    statusText = t(`lockedCamera.status.${status}`);
  }

  return (
    <Card>
      <BodyText style={styles.title}>{t('lockedCamera.title')}</BodyText>
      <BodyText tone={status === 'locked' ? 'accent' : status === 'failed' ? 'danger' : 'secondary'}>{statusText}</BodyText>
      {lockedCamera.isSettling ? <BodyText tone="secondary">{t('lockedCamera.waitBeforeSaving')}</BodyText> : null}
      {status === 'locked' && lockedExposure ? (
        <BodyText tone="secondary" style={styles.exposureValues}>
          {t('lockedCamera.exposureValues', {
            duration: formatExposureDuration(lockedExposure.durationSeconds),
            iso: Math.round(lockedExposure.iso),
          })}
        </BodyText>
      ) : null}
      {status === 'locked' && exposureOutcome === 'limitReached' ? (
        <BodyText tone="danger">{t('lockedCamera.limitReached')}</BodyText>
      ) : null}
      {status === 'locked' && exposureOutcome === 'gaveUp' ? (
        <BodyText tone="danger">{t('lockedCamera.gaveUp')}</BodyText>
      ) : null}
      <View style={styles.buttonRow}>
        {isEnabled ? (
          <View style={styles.buttonCell}>
            <AppButton
              label={t('lockedCamera.relock')}
              variant="secondary"
              onPress={lockedCamera.relock}
              isDisabled={status === 'waitingForTarget'}
            />
          </View>
        ) : null}
        <View style={styles.buttonCell}>
          <AppButton
            label={isEnabled ? t('lockedCamera.disable') : t('lockedCamera.enable')}
            variant="secondary"
            onPress={() => onEnabledChange(!isEnabled)}
          />
        </View>
      </View>
      <BodyText tone="secondary" style={styles.hint}>
        {t('lockedCamera.hint')}
      </BodyText>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontWeight: '600' },
  exposureValues: { fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  hint: { fontSize: 13 },
});
