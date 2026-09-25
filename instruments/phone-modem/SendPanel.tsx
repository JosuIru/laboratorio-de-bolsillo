import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Camera, type CameraRef } from 'react-native-vision-camera';

import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import type { SensorAvailability } from '@/core/sensors/types';
import {
  type AcousticBandPreset,
  acousticConfigurationFor,
  type AcousticSpeedPreset,
  acousticTransmissionDurationSeconds,
} from '@/processing/modem/acousticModem';
import { MessageTooLongError, maximumTextUnitCount, prepareMessage, type PreparedMessage } from '@/processing/modem/frameCodec';
import {
  buildOpticalChipSequence,
  opticalConfigurationFor,
  type OpticalSpeedPreset,
  opticalTransmissionDurationSeconds,
} from '@/processing/modem/opticalModem';
import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { modemStyles, PermissionNotice, ProgressBar } from './modemControls';
import {
  channelBitRates,
  errorCorrectionByChannel,
  type LightEmitter,
  type ModemChannel,
  phoneModemInstrumentId,
  preferredEncodingByChannel,
  spyPresetKeys,
} from './modemConfiguration';
import { useAcousticTransmitter } from './useAcousticTransmitter';
import { useOpticalTransmitter } from './useOpticalTransmitter';

interface SendPanelProps {
  channel: ModemChannel;
  acousticBand: AcousticBandPreset;
  acousticSpeed: AcousticSpeedPreset;
  opticalSpeed: OpticalSpeedPreset;
  lightEmitter: LightEmitter;
  cameraAvailability: SensorAvailability;
}

type PreparationResult =
  | { status: 'empty' }
  | { status: 'ready'; preparedMessage: PreparedMessage; durationSeconds: number }
  | { status: 'tooLong'; textUnitCount: number };

export function SendPanel({
  channel,
  acousticBand,
  acousticSpeed,
  opticalSpeed,
  lightEmitter,
  cameraAvailability,
}: SendPanelProps) {
  const { t } = useTranslation(phoneModemInstrumentId);
  const themePalette = useThemePalette();
  const [messageText, setMessageText] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [isTorchReady, setIsTorchReady] = useState(false);
  const cameraRef = useRef<CameraRef>(null);
  const isCameraAllowed = useIsCameraAllowed();

  const { transmissionState: acousticState, transmitFrame, cancelTransmission: cancelAcoustic } = useAcousticTransmitter();
  const setTorchLevel = useCallback((lightLevel: number) => {
    void cameraRef.current?.controller?.setTorchMode(lightLevel ? 'on' : 'off').catch(() => undefined);
  }, []);
  const handleLightLevelChange = useCallback(
    (lightLevel: number) => {
      if (lightEmitter === 'torch') setTorchLevel(lightLevel);
    },
    [lightEmitter, setTorchLevel],
  );
  const {
    transmissionState: opticalState,
    lightLevel,
    transmitChips,
    cancelTransmission: cancelOptical,
  } = useOpticalTransmitter(handleLightLevelChange);

  const errorCorrection = errorCorrectionByChannel[channel];
  const preparation = useMemo((): PreparationResult => {
    if (messageText.trim().length === 0) return { status: 'empty' };
    try {
      const preparedMessage = prepareMessage(
        { text: messageText.trim(), secretKey, preferredEncoding: preferredEncodingByChannel[channel] },
        errorCorrection,
      );
      const durationSeconds =
        channel === 'sound'
          ? acousticTransmissionDurationSeconds(
              preparedMessage.channelBits.length,
              acousticConfigurationFor(acousticBand, acousticSpeed),
            )
          : opticalTransmissionDurationSeconds(preparedMessage.channelBits.length, opticalConfigurationFor(opticalSpeed));
      return { status: 'ready', preparedMessage, durationSeconds };
    } catch (preparationError) {
      if (preparationError instanceof MessageTooLongError) {
        return { status: 'tooLong', textUnitCount: preparationError.textUnitCount };
      }
      throw preparationError;
    }
  }, [messageText, secretKey, channel, errorCorrection, acousticBand, acousticSpeed, opticalSpeed]);

  const isSending = acousticState.status === 'sending' || opticalState.status === 'sending';
  const needsCamera = channel === 'light' && lightEmitter === 'torch';
  const isCameraAvailable = cameraAvailability.status === 'available';
  const bitRates = channelBitRates(channel, acousticSpeed, opticalSpeed);

  function handleSend() {
    if (preparation.status !== 'ready') return;
    const { channelBits } = preparation.preparedMessage;
    if (channel === 'sound') {
      void transmitFrame(channelBits, acousticConfigurationFor(acousticBand, acousticSpeed));
    } else {
      transmitChips(buildOpticalChipSequence(channelBits), opticalConfigurationFor(opticalSpeed));
    }
  }

  function handleCancel() {
    cancelAcoustic();
    cancelOptical();
  }

  const sendingProgress =
    acousticState.status === 'sending' ? acousticState.progress : opticalState.status === 'sending' ? opticalState.progress : 0;
  const isScreenFlashing = channel === 'light' && lightEmitter === 'screen' && opticalState.status === 'sending';
  const isSendDisabled =
    preparation.status !== 'ready' || (needsCamera && (!isCameraAvailable || !isTorchReady));

  return (
    <>
      <Card>
        <BodyText>{t('send.messageLabel')}</BodyText>
        <TextInput
          value={messageText}
          onChangeText={setMessageText}
          placeholder={t('send.messagePlaceholder')}
          placeholderTextColor={themePalette.textSecondary}
          maxLength={maximumTextUnitCount}
          editable={!isSending}
          style={[modemStyles.textInput, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
        />
        <View style={modemStyles.chipRow}>
          {spyPresetKeys.map((presetKey) => (
            <Pressable
              key={presetKey}
              accessibilityRole="button"
              disabled={isSending}
              onPress={() => setMessageText(t(`presets.${presetKey}`))}
              style={[modemStyles.presetChip, { borderColor: themePalette.border }]}>
              <BodyText style={modemStyles.smallText}>{t(`presets.${presetKey}`)}</BodyText>
            </Pressable>
          ))}
        </View>

        <BodyText>{t('send.secretKeyLabel')}</BodyText>
        <TextInput
          value={secretKey}
          onChangeText={setSecretKey}
          placeholder={t('send.secretKeyPlaceholder')}
          placeholderTextColor={themePalette.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSending}
          style={[modemStyles.textInput, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
        />
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {t('send.secretKeyHelp')}
        </BodyText>

        {preparation.status === 'ready' ? (
          <>
            {preparation.preparedMessage.transmittedText !== messageText.trim() ? (
              <BodyText tone="secondary" style={modemStyles.smallText}>
                {t('send.willSendAs', { text: preparation.preparedMessage.transmittedText })}
              </BodyText>
            ) : null}
            <BodyText tone="secondary" style={modemStyles.smallText}>
              {t('send.summary', {
                bits: preparation.preparedMessage.channelBits.length,
                seconds: preparation.durationSeconds.toFixed(1),
                rawRate: bitRates.rawBitsPerSecond.toFixed(bitRates.rawBitsPerSecond < 10 ? 1 : 0),
                usefulRate: bitRates.usefulBitsPerSecond.toFixed(bitRates.usefulBitsPerSecond < 10 ? 1 : 0),
              })}
            </BodyText>
          </>
        ) : preparation.status === 'tooLong' ? (
          <BodyText tone="danger" style={modemStyles.smallText}>
            {t('send.tooLong', { units: preparation.textUnitCount, maximum: maximumTextUnitCount })}
          </BodyText>
        ) : null}
      </Card>

      {needsCamera ? (
        <Card>
          {isCameraAvailable ? (
            <View style={modemStyles.statusRow}>
              <View style={[styles.torchPreview, { borderColor: themePalette.border }]}>
                <Camera
                  ref={cameraRef}
                  style={StyleSheet.absoluteFill}
                  device="back"
                  isActive={isCameraAllowed}
                  resizeMode="cover"
                  onStarted={() => setIsTorchReady(true)}
                  onStopped={() => setIsTorchReady(false)}
                  onError={() => setIsTorchReady(false)}
                />
              </View>
              <BodyText tone="secondary" style={styles.torchStatusText}>
                {isTorchReady ? t('send.torchReady') : t('send.torchStarting')}
              </BodyText>
            </View>
          ) : (
            <PermissionNotice sensorAvailability={cameraAvailability} />
          )}
        </Card>
      ) : null}

      {isSending ? (
        <Card>
          <BodyText>{t('send.sending', { percent: Math.round(sendingProgress * 100) })}</BodyText>
          <ProgressBar fraction={sendingProgress} />
          {channel === 'light' && lightEmitter === 'torch' ? (
            <BodyText tone="secondary" style={modemStyles.smallText}>
              {lightLevel ? t('send.lightOn') : t('send.lightOff')}
            </BodyText>
          ) : null}
          <AppButton label={t('send.cancel')} onPress={handleCancel} variant="secondary" />
        </Card>
      ) : (
        <AppButton label={t('send.send')} onPress={handleSend} isDisabled={isSendDisabled} />
      )}
      {acousticState.status === 'sampleRateTooLow' ? (
        <BodyText tone="danger">{t('sound.sampleRateTooLow', { sampleRate: acousticState.sampleRateHz })}</BodyText>
      ) : null}
      {acousticState.status === 'error' ? (
        <BodyText tone="danger">{t('core:common.error', { message: acousticState.errorMessage })}</BodyText>
      ) : null}
      <BodyText tone="secondary" style={modemStyles.smallText}>
        {channel === 'sound' ? t('send.soundHelp') : lightEmitter === 'screen' ? t('send.screenHelp') : t('send.torchHelp')}
      </BodyText>

      <Modal visible={isScreenFlashing} animationType="none" statusBarTranslucent onRequestClose={handleCancel}>
        <View style={[styles.flashScreen, { backgroundColor: lightLevel ? '#FFFFFF' : '#000000' }]}>
          <Pressable accessibilityRole="button" onPress={handleCancel} style={styles.flashCancel}>
            <BodyText style={styles.flashCancelText}>
              {`${t('send.cancel')} · ${Math.round(sendingProgress * 100)} %`}
            </BodyText>
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  torchPreview: { width: 72, height: 72, borderRadius: 8, overflow: 'hidden', borderWidth: 1 },
  torchStatusText: { flex: 1, fontSize: 13 },
  flashScreen: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  flashCancel: { paddingVertical: 16, paddingHorizontal: 24, marginBottom: 32 },
  flashCancelText: { color: '#808080', fontSize: 13 },
});
