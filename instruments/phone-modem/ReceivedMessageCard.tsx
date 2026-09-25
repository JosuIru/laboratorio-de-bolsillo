import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { decodeMessage, type ReceivedFrame } from '@/processing/modem/frameCodec';
import { AppButton, BodyText, Card } from '@/ui/components';

import { modemStyles } from './modemControls';
import { type ModemChannel, phoneModemInstrumentId } from './modemConfiguration';

export interface ReceivedModemMessage {
  messageId: number;
  channel: ModemChannel;
  frame: ReceivedFrame;
  /** 0-1. */
  qualityScore: number;
  rawBitRate: number;
  receivedAtMilliseconds: number;
  /** Momento en que se descifró (para la autodestrucción), o null. */
  revealedAtMilliseconds: number | null;
}

interface ReceivedMessageCardProps {
  receivedMessage: ReceivedModemMessage;
  decryptionKey: string;
  /** Segundos que quedan antes de autodestruirse, o null si no aplica. */
  selfDestructRemainingSeconds: number | null;
  isSaving: boolean;
  onSave(): void;
}

export function ReceivedMessageCard({
  receivedMessage,
  decryptionKey,
  selfDestructRemainingSeconds,
  isSaving,
  onSave,
}: ReceivedMessageCardProps) {
  const { t } = useTranslation(phoneModemInstrumentId);
  const { frame, channel, qualityScore } = receivedMessage;
  const decodedMessage = decodeMessage(frame, decryptionKey);
  const isDestroyed = selfDestructRemainingSeconds !== null && selfDestructRemainingSeconds <= 0;
  const receivedTime = new Date(receivedMessage.receivedAtMilliseconds).toLocaleTimeString();

  function renderBody() {
    if (!frame.isCrcValid) {
      return (
        <>
          <BodyText tone="danger">{t('messages.damaged')}</BodyText>
          <BodyText tone="secondary" style={modemStyles.smallText} numberOfLines={2}>
            {decodedMessage.garbledText}
          </BodyText>
        </>
      );
    }
    if (isDestroyed) return <BodyText tone="secondary">{t('messages.destroyed')}</BodyText>;
    if (decodedMessage.text !== null) {
      return (
        <>
          <BodyText style={styles.messageText}>{decodedMessage.text}</BodyText>
          {selfDestructRemainingSeconds !== null ? (
            <BodyText tone="danger" style={modemStyles.smallText}>
              {t('messages.selfDestructIn', { seconds: Math.ceil(selfDestructRemainingSeconds) })}
            </BodyText>
          ) : null}
        </>
      );
    }
    return (
      <>
        <BodyText tone="accent">
          {decodedMessage.secretKeyStatus === 'wrong' ? t('messages.wrongKey') : t('messages.secret')}
        </BodyText>
        <BodyText tone="secondary" style={modemStyles.smallText} numberOfLines={2}>
          {decodedMessage.garbledText}
        </BodyText>
      </>
    );
  }

  const isSavable = frame.isCrcValid && decodedMessage.text !== null && !isDestroyed;
  return (
    <Card>
      <View style={styles.headerRow}>
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {`${t(`channels.${channel}`)} · ${receivedTime}`}
        </BodyText>
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {t('messages.quality', { percent: Math.round(qualityScore * 100) })}
        </BodyText>
      </View>
      {renderBody()}
      <BodyText tone="secondary" style={modemStyles.smallText}>
        {t('messages.details', {
          bits: frame.channelBitCount,
          corrected: frame.correctedBitCount,
          rate: receivedMessage.rawBitRate.toFixed(receivedMessage.rawBitRate < 10 ? 1 : 0),
        })}
      </BodyText>
      {isSavable ? (
        <AppButton label={t('core:common.save')} onPress={onSave} variant="secondary" isBusy={isSaving} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  messageText: { fontSize: 20, lineHeight: 28, fontWeight: '600' },
});
