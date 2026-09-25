import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { AcousticBandPreset, AcousticSpeedPreset } from '@/processing/modem/acousticModem';
import { decodeMessage } from '@/processing/modem/frameCodec';
import type { OpticalSpeedPreset } from '@/processing/modem/opticalModem';
import { BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { modemStyles, SegmentedChoice } from './modemControls';
import {
  acousticBandOptions,
  acousticSpeedOptions,
  channelBitRates,
  type LightEmitter,
  type ModemChannel,
  type ModemDirection,
  opticalSpeedOptions,
  phoneModemInstrumentId,
  selfDestructSeconds,
} from './modemConfiguration';
import { type ModemReceptionEvent, ReceivePanel } from './ReceivePanel';
import { ReceivedMessageCard, type ReceivedModemMessage } from './ReceivedMessageCard';
import type { PhoneModemMeasurementValues } from './schema';
import { SendPanel } from './SendPanel';
import { SoundSelfTestCard } from './SoundSelfTestCard';
import { useAcousticSelfTest } from './useAcousticSelfTest';

const directionOptions: readonly ModemDirection[] = ['send', 'receive'];
const channelOptions: readonly ModemChannel[] = ['sound', 'light'];
const lightEmitterOptions: readonly LightEmitter[] = ['screen', 'torch'];
/** Mensajes que se guardan en la lista (los más recientes arriba). */
const maximumListedMessages = 20;

function formatBitRate(bitsPerSecond: number): string {
  return bitsPerSecond < 10 ? bitsPerSecond.toFixed(1) : bitsPerSecond.toFixed(0);
}

/** Anota cuándo se descifra cada mensaje secreto (desde ahí corre la autodestrucción). */
function markRevealedMessages(messages: ReceivedModemMessage[], candidateKey: string): ReceivedModemMessage[] {
  return messages.map((receivedMessage) =>
    receivedMessage.revealedAtMilliseconds === null &&
    receivedMessage.frame.header.isSecret &&
    decodeMessage(receivedMessage.frame, candidateKey).secretKeyStatus === 'correct'
      ? { ...receivedMessage, revealedAtMilliseconds: Date.now() }
      : receivedMessage,
  );
}

export function PhoneModemScreen({ saveMeasurement, sensorAvailability }: InstrumentScreenProps<PhoneModemMeasurementValues>) {
  const { t } = useTranslation(phoneModemInstrumentId);
  const themePalette = useThemePalette();
  // Una emisión por luz dura decenas de segundos: la pantalla no debe apagarse a medias.
  useKeepAwake();
  const [direction, setDirection] = useState<ModemDirection>('send');
  const [channel, setChannel] = useState<ModemChannel>('sound');
  const [acousticBand, setAcousticBand] = useState<AcousticBandPreset>('ultrasonic');
  const [acousticSpeed, setAcousticSpeed] = useState<AcousticSpeedPreset>('normal');
  const [opticalSpeed, setOpticalSpeed] = useState<OpticalSpeedPreset>('normal');
  const [lightEmitter, setLightEmitter] = useState<LightEmitter>('screen');
  const [receivedMessages, setReceivedMessages] = useState<ReceivedModemMessage[]>([]);
  const [lostFrameCount, setLostFrameCount] = useState(0);
  const [decryptionKey, setDecryptionKey] = useState('');
  const [isSelfDestructEnabled, setIsSelfDestructEnabled] = useState(false);
  const [currentMilliseconds, setCurrentMilliseconds] = useState(() => Date.now());
  const [savingMessageId, setSavingMessageId] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const { selfTestState, runSelfTest, cancelSelfTest } = useAcousticSelfTest();
  const isSelfTestRunning = selfTestState.phase === 'running';

  const handleReceptionEvent = useCallback(
    (receptionEvent: ModemReceptionEvent, eventChannel: ModemChannel) => {
      if (receptionEvent.type === 'frameLost') {
        setLostFrameCount((previousCount) => previousCount + 1);
        return;
      }
      const { frame, linkQuality } = receptionEvent.event;
      const receivedMessage: ReceivedModemMessage = {
        messageId: Date.now() + Math.random(),
        channel: eventChannel,
        frame,
        qualityScore: linkQuality.qualityScore,
        rawBitRate: channelBitRates(eventChannel, acousticSpeed, opticalSpeed).rawBitsPerSecond,
        receivedAtMilliseconds: Date.now(),
        revealedAtMilliseconds: null,
      };
      setReceivedMessages((previousMessages) => {
        const [markedMessage] = isSelfDestructEnabled
          ? markRevealedMessages([receivedMessage], decryptionKey)
          : [receivedMessage];
        return [markedMessage!, ...previousMessages].slice(0, maximumListedMessages);
      });
    },
    [acousticSpeed, opticalSpeed, isSelfDestructEnabled, decryptionKey],
  );

  // Autodestrucción: marca la hora a la que se descifra cada mensaje secreto y lleva un reloj
  // mientras quede alguno en cuenta atrás.
  const hasPendingSelfDestruct =
    isSelfDestructEnabled &&
    receivedMessages.some(
      (receivedMessage) =>
        receivedMessage.frame.header.isSecret &&
        (receivedMessage.revealedAtMilliseconds === null ||
          currentMilliseconds - receivedMessage.revealedAtMilliseconds < selfDestructSeconds * 1000),
    );
  useEffect(() => {
    if (!hasPendingSelfDestruct) return;
    const clockTimer = setInterval(() => setCurrentMilliseconds(Date.now()), 500);
    return () => clearInterval(clockTimer);
  }, [hasPendingSelfDestruct]);
  function handleDecryptionKeyChange(newDecryptionKey: string) {
    setDecryptionKey(newDecryptionKey);
    if (isSelfDestructEnabled) {
      setReceivedMessages((previousMessages) => markRevealedMessages(previousMessages, newDecryptionKey));
    }
  }

  function handleSelfDestructToggle() {
    const willBeEnabled = !isSelfDestructEnabled;
    setIsSelfDestructEnabled(willBeEnabled);
    setCurrentMilliseconds(Date.now());
    setReceivedMessages((previousMessages) =>
      willBeEnabled
        ? markRevealedMessages(previousMessages, decryptionKey)
        : previousMessages.map((receivedMessage) => ({ ...receivedMessage, revealedAtMilliseconds: null })),
    );
  }

  function selfDestructRemainingSeconds(receivedMessage: ReceivedModemMessage): number | null {
    if (!isSelfDestructEnabled || receivedMessage.revealedAtMilliseconds === null) return null;
    return selfDestructSeconds - (currentMilliseconds - receivedMessage.revealedAtMilliseconds) / 1000;
  }

  async function handleSave(receivedMessage: ReceivedModemMessage) {
    const messageText = decodeMessage(receivedMessage.frame, decryptionKey).text;
    if (messageText === null) return;
    setSavingMessageId(receivedMessage.messageId);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          channel: receivedMessage.channel,
          messageText,
          isSecret: receivedMessage.frame.header.isSecret,
          rawBitRate: Math.round(receivedMessage.rawBitRate * 10) / 10,
          linkQualityPercent: Math.round(receivedMessage.qualityScore * 100),
          channelBitCount: receivedMessage.frame.channelBitCount,
          correctedBitCount: receivedMessage.frame.correctedBitCount,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setSavingMessageId(null);
    }
  }

  const speedLabel = (speedName: string, bitsPerSecond: number) =>
    `${t(`speeds.${speedName}`)}\n${formatBitRate(bitsPerSecond)} bit/s`;

  return (
    <ScreenContainer>
      <Card>
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {t('intro')}
        </BodyText>
      </Card>

      <SegmentedChoice
        options={directionOptions}
        selectedOption={direction}
        onSelect={setDirection}
        labelFor={(directionOption) => t(`directions.${directionOption}`)}
      />
      <SegmentedChoice
        options={channelOptions}
        selectedOption={channel}
        onSelect={setChannel}
        labelFor={(channelOption) => t(`channels.${channelOption}`)}
      />

      <Card>
        {channel === 'sound' ? (
          <>
            <BodyText>{t('settings.band')}</BodyText>
            <SegmentedChoice
              options={acousticBandOptions}
              selectedOption={acousticBand}
              onSelect={setAcousticBand}
              labelFor={(bandOption) => t(`bands.${bandOption}`)}
            />
            <BodyText>{t('settings.speed')}</BodyText>
            <SegmentedChoice
              options={acousticSpeedOptions}
              selectedOption={acousticSpeed}
              onSelect={setAcousticSpeed}
              labelFor={(speedOption) =>
                speedLabel(speedOption, channelBitRates('sound', speedOption, opticalSpeed).rawBitsPerSecond)
              }
            />
            <BodyText tone="secondary" style={modemStyles.smallText}>
              {acousticBand === 'ultrasonic' ? t('sound.ultrasonicWarning') : t('sound.audibleNote')}
            </BodyText>
          </>
        ) : (
          <>
            {direction === 'send' ? (
              <>
                <BodyText>{t('settings.emitter')}</BodyText>
                <SegmentedChoice
                  options={lightEmitterOptions}
                  selectedOption={lightEmitter}
                  onSelect={setLightEmitter}
                  labelFor={(emitterOption) => t(`emitters.${emitterOption}`)}
                />
              </>
            ) : null}
            <BodyText>{t('settings.speed')}</BodyText>
            <SegmentedChoice
              options={opticalSpeedOptions}
              selectedOption={opticalSpeed}
              onSelect={setOpticalSpeed}
              labelFor={(speedOption) =>
                speedLabel(speedOption, channelBitRates('light', acousticSpeed, speedOption).rawBitsPerSecond)
              }
            />
            <BodyText tone="secondary" style={modemStyles.smallText}>
              {t('light.speedNote')}
            </BodyText>
          </>
        )}
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {t('settings.sameSettings')}
        </BodyText>
      </Card>

      {channel === 'sound' ? (
        <SoundSelfTestCard
          selfTestState={selfTestState}
          microphoneAvailability={sensorAvailability.microphone}
          onRun={() => void runSelfTest()}
          onCancel={cancelSelfTest}
          onUseBand={setAcousticBand}
        />
      ) : null}

      {direction === 'send' ? (
        <SendPanel
          channel={channel}
          acousticBand={acousticBand}
          acousticSpeed={acousticSpeed}
          opticalSpeed={opticalSpeed}
          lightEmitter={lightEmitter}
          cameraAvailability={sensorAvailability.camera}
        />
      ) : (
        <>
          <ReceivePanel
            channel={channel}
            acousticBand={acousticBand}
            acousticSpeed={acousticSpeed}
            opticalSpeed={opticalSpeed}
            microphoneAvailability={sensorAvailability.microphone}
            cameraAvailability={sensorAvailability.camera}
            isMicrophoneBusy={isSelfTestRunning}
            onReceptionEvent={handleReceptionEvent}
          />

          <SectionTitle>{t('messages.title')}</SectionTitle>
          <Card>
            <BodyText>{t('messages.decryptionKeyLabel')}</BodyText>
            <TextInput
              value={decryptionKey}
              onChangeText={handleDecryptionKeyChange}
              placeholder={t('messages.decryptionKeyPlaceholder')}
              placeholderTextColor={themePalette.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              style={[modemStyles.textInput, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
            />
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: isSelfDestructEnabled }}
              onPress={handleSelfDestructToggle}
              style={styles.toggleRow}>
              <View
                style={[
                  styles.toggleBox,
                  {
                    borderColor: themePalette.accent,
                    backgroundColor: isSelfDestructEnabled ? themePalette.accent : 'transparent',
                  },
                ]}
              />
              <BodyText style={styles.toggleLabel}>{t('messages.selfDestructToggle', { seconds: selfDestructSeconds })}</BodyText>
            </Pressable>
            {lostFrameCount > 0 ? (
              <BodyText tone="secondary" style={modemStyles.smallText}>
                {t('messages.lostFrames', { count: lostFrameCount })}
              </BodyText>
            ) : null}
          </Card>
          {receivedMessages.length === 0 ? (
            <BodyText tone="secondary">{t('messages.empty')}</BodyText>
          ) : (
            receivedMessages.map((receivedMessage) => (
              <ReceivedMessageCard
                key={receivedMessage.messageId}
                receivedMessage={receivedMessage}
                decryptionKey={decryptionKey}
                selfDestructRemainingSeconds={selfDestructRemainingSeconds(receivedMessage)}
                isSaving={savingMessageId === receivedMessage.messageId}
                onSave={() => void handleSave(receivedMessage)}
              />
            ))
          )}
        </>
      )}

      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <SectionTitle>{t('limits.title')}</SectionTitle>
      <Card>
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {channel === 'sound' ? t('limits.sound') : t('limits.light')}
        </BodyText>
      </Card>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  toggleBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2 },
  toggleLabel: { flex: 1 },
});
