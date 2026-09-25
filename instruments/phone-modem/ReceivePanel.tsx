import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Camera } from 'react-native-vision-camera';

import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import type { SensorAvailability } from '@/core/sensors/types';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import type { AcousticBandPreset, AcousticReceiverEvent, AcousticSpeedPreset } from '@/processing/modem/acousticModem';
import type { OpticalReceiverEvent, OpticalSpeedPreset } from '@/processing/modem/opticalModem';
import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { modemStyles, PermissionNotice, ProgressBar } from './modemControls';
import { errorCorrectionByChannel, type ModemChannel, phoneModemInstrumentId } from './modemConfiguration';
import { useAcousticReceiver } from './useAcousticReceiver';
import { tileCoveredFraction, useOpticalReceiverFrames } from './useOpticalReceiverFrames';

/** Lo que el panel comunica a la pantalla: una trama completa (buena o dañada) o una perdida. */
export type ModemReceptionEvent =
  | { type: 'frameReceived'; event: Extract<AcousticReceiverEvent | OpticalReceiverEvent, { type: 'frameReceived' }> }
  | { type: 'frameLost' };

interface ReceivePanelProps {
  channel: ModemChannel;
  acousticBand: AcousticBandPreset;
  acousticSpeed: AcousticSpeedPreset;
  opticalSpeed: OpticalSpeedPreset;
  microphoneAvailability: SensorAvailability;
  cameraAvailability: SensorAvailability;
  /** Otra tarea (la autoprueba) usa el micrófono: no se escucha mientras tanto. */
  isMicrophoneBusy: boolean;
  onReceptionEvent(receptionEvent: ModemReceptionEvent, channel: ModemChannel): void;
}

/** Barras verticales con la energía relativa de cada tono. */
function ToneBars({ tonePurities }: { tonePurities: number[] }) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.toneBarsRow}>
      {tonePurities.map((tonePurity, toneIndex) => (
        <View key={toneIndex} style={[styles.toneBarTrack, { backgroundColor: themePalette.border }]}>
          <View
            style={[styles.toneBarFill, { backgroundColor: themePalette.accent, height: `${Math.round(tonePurity * 100)}%` }]}
          />
        </View>
      ))}
    </View>
  );
}

/** Traza del brillo de los últimos fotogramas, normalizada entre su mínimo y su máximo. */
function LuminanceTrace({ luminanceTrace }: { luminanceTrace: number[] }) {
  const themePalette = useThemePalette();
  const minimumLuminance = Math.min(...luminanceTrace);
  const luminanceRange = Math.max(1, Math.max(...luminanceTrace) - minimumLuminance);
  return (
    <View style={[styles.traceRow, { borderColor: themePalette.border }]}>
      {luminanceTrace.map((luminance, sampleIndex) => (
        <View
          key={sampleIndex}
          style={[
            styles.traceBar,
            {
              backgroundColor: themePalette.accent,
              height: `${Math.max(3, Math.round(((luminance - minimumLuminance) / luminanceRange) * 100))}%`,
            },
          ]}
        />
      ))}
    </View>
  );
}

export function ReceivePanel({
  channel,
  acousticBand,
  acousticSpeed,
  opticalSpeed,
  microphoneAvailability,
  cameraAvailability,
  isMicrophoneBusy,
  onReceptionEvent,
}: ReceivePanelProps) {
  const { t } = useTranslation(phoneModemInstrumentId);
  const themePalette = useThemePalette();
  const [isReceiving, setIsReceiving] = useState(false);
  const [cameraErrorMessage, setCameraErrorMessage] = useState<string | null>(null);
  const isCameraAllowed = useIsCameraAllowed();

  const isMicrophoneAvailable = microphoneAvailability.status === 'available';
  const isCameraAvailable = cameraAvailability.status === 'available';
  const isSoundReceiving = isReceiving && channel === 'sound' && isMicrophoneAvailable && !isMicrophoneBusy;
  const isLightReceiving = isReceiving && channel === 'light' && isCameraAvailable;

  const handleReceiverEvent = useCallback(
    (receiverEvent: AcousticReceiverEvent | OpticalReceiverEvent, eventChannel: ModemChannel) => {
      // El preámbulo ya se ve en el estado («recibiendo…»); aquí solo interesan las tramas.
      if (receiverEvent.type === 'frameReceived') {
        onReceptionEvent({ type: 'frameReceived', event: receiverEvent }, eventChannel);
      } else if (receiverEvent.type === 'frameLost') {
        onReceptionEvent({ type: 'frameLost' }, eventChannel);
      }
    },
    [onReceptionEvent],
  );
  const handleAcousticEvent = useCallback(
    (receiverEvent: AcousticReceiverEvent) => handleReceiverEvent(receiverEvent, 'sound'),
    [handleReceiverEvent],
  );
  const handleOpticalEvent = useCallback(
    (receiverEvent: OpticalReceiverEvent) => handleReceiverEvent(receiverEvent, 'light'),
    [handleReceiverEvent],
  );

  const { listenerState, receiverStatus: acousticStatus } = useAcousticReceiver({
    isListening: isSoundReceiving,
    bandPreset: acousticBand,
    speedPreset: acousticSpeed,
    errorCorrection: errorCorrectionByChannel.sound,
    onReceiverEvent: handleAcousticEvent,
  });
  const { frameOutput, snapshot: opticalSnapshot } = useOpticalReceiverFrames({
    isReceiving: isLightReceiving,
    speedPreset: opticalSpeed,
    errorCorrection: errorCorrectionByChannel.light,
    onReceiverEvent: handleOpticalEvent,
  });

  const receiverPhase = channel === 'sound' ? acousticStatus?.phase : opticalSnapshot?.receiverStatus.phase;
  const collectedBitCount =
    channel === 'sound' ? acousticStatus?.collectedBitCount : opticalSnapshot?.receiverStatus.collectedBitCount;
  const expectedBitCount =
    channel === 'sound' ? acousticStatus?.expectedBitCount : opticalSnapshot?.receiverStatus.expectedBitCount;

  function renderReceptionStatus() {
    if (receiverPhase === 'receiving') {
      return (
        <>
          <BodyText tone="accent">
            {expectedBitCount
              ? t('receive.receivingBits', { collected: collectedBitCount ?? 0, expected: expectedBitCount })
              : t('receive.receivingHeader')}
          </BodyText>
          <ProgressBar fraction={expectedBitCount ? (collectedBitCount ?? 0) / expectedBitCount : 0} />
        </>
      );
    }
    return <BodyText tone="secondary">{t('receive.searching')}</BodyText>;
  }

  function renderSoundStatus() {
    if (!isMicrophoneAvailable) return <PermissionNotice sensorAvailability={microphoneAvailability} />;
    if (isMicrophoneBusy) return <BodyText tone="secondary">{t('receive.microphoneBusy')}</BodyText>;
    if (!isReceiving) return null;
    if (listenerState.status === 'starting') return <BodyText tone="secondary">{t('receive.starting')}</BodyText>;
    if (listenerState.status === 'sampleRateTooLow') {
      return <BodyText tone="danger">{t('sound.sampleRateTooLow', { sampleRate: listenerState.sampleRateHz })}</BodyText>;
    }
    if (listenerState.status === 'error') {
      return <BodyText tone="danger">{t('core:common.error', { message: listenerState.errorMessage })}</BodyText>;
    }
    if (!acousticStatus) return null;
    return (
      <>
        {renderReceptionStatus()}
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {t('receive.soundLevel', { level: acousticStatus.inputLevelDecibels.toFixed(0) })}
        </BodyText>
        <ToneBars tonePurities={acousticStatus.latestTonePurities} />
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {t('receive.toneBarsHelp')}
        </BodyText>
      </>
    );
  }

  function renderLightStatus() {
    if (!isCameraAvailable) return <PermissionNotice sensorAvailability={cameraAvailability} />;
    if (!isReceiving) return null;
    return (
      <>
        <View style={[styles.cameraPreview, { borderColor: themePalette.border }]}>
          <Camera
            style={StyleSheet.absoluteFill}
            device="back"
            isActive={isCameraAllowed && isLightReceiving}
            outputs={[frameOutput]}
            resizeMode="cover"
            onError={(cameraError) => {
              if (!isExpectedCameraInterruption(cameraError)) setCameraErrorMessage(cameraError.message);
            }}
          />
          <View pointerEvents="none" style={styles.targetOverlay}>
            <View style={[styles.targetSquare, { borderColor: themePalette.onAccent }]} />
          </View>
        </View>
        {cameraErrorMessage ? (
          <BodyText tone="danger">{t('core:common.error', { message: cameraErrorMessage })}</BodyText>
        ) : null}
        {opticalSnapshot ? (
          <>
            {opticalSnapshot.receiverStatus.isSignalPresent ? (
              renderReceptionStatus()
            ) : (
              <BodyText tone="secondary">{t('receive.noBlinking')}</BodyText>
            )}
            <LuminanceTrace luminanceTrace={opticalSnapshot.luminanceTrace} />
            <BodyText tone="secondary" style={modemStyles.smallText}>
              {t('receive.lightDetails', {
                contrast: Math.round(opticalSnapshot.receiverStatus.contrast * 100),
                fps: opticalSnapshot.framesPerSecond.toFixed(0),
              })}
            </BodyText>
          </>
        ) : (
          <BodyText tone="secondary">{t('receive.starting')}</BodyText>
        )}
      </>
    );
  }

  return (
    <>
      <AppButton
        label={isReceiving ? t('receive.stop') : t('receive.start')}
        onPress={() => setIsReceiving((wasReceiving) => !wasReceiving)}
        variant={isReceiving ? 'secondary' : 'primary'}
      />
      <Card>
        {channel === 'sound' ? renderSoundStatus() : renderLightStatus()}
        <BodyText tone="secondary" style={modemStyles.smallText}>
          {channel === 'sound' ? t('receive.soundHelp') : t('receive.lightHelp')}
        </BodyText>
      </Card>
    </>
  );
}

const targetSizePercent = `${Math.round(tileCoveredFraction * 100)}%` as const;

const styles = StyleSheet.create({
  toneBarsRow: { flexDirection: 'row', gap: 12, height: 64, alignItems: 'flex-end' },
  toneBarTrack: { flex: 1, height: '100%', borderRadius: 6, overflow: 'hidden', justifyContent: 'flex-end' },
  toneBarFill: { width: '100%' },
  cameraPreview: { height: 240, borderRadius: 12, overflow: 'hidden', borderWidth: 1 },
  targetOverlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  targetSquare: { width: targetSizePercent, height: targetSizePercent, borderWidth: 2, borderStyle: 'dashed', borderRadius: 8 },
  traceRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 56,
    gap: 1,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  traceBar: { flex: 1, borderRadius: 1 },
});
