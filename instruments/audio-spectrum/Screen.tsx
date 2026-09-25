import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { frequencyToMusicalNote } from '@/processing/dsp/musicalNotes';
import type { FrequencyScale } from '@/processing/dsp/spectrogram';
import { SignalChart } from '@/ui/charts/SignalChart';
import { SpectrogramView } from '@/ui/charts/SpectrogramView';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { SoundLevelCalibrationParameters } from './calibration';
import type { AudioSpectrumMeasurementValues } from './schema';
import { minimumDisplayFrequencyHz, useMicrophoneAnalyser } from './useMicrophoneAnalyser';

export const audioSpectrumInstrumentId = 'audio-spectrum';

export const displayMinimumDecibels = -120;
export const displayMaximumDecibels = -20;

function formatFrequency(frequencyHz: number): string {
  return frequencyHz >= 1000 ? `${(frequencyHz / 1000).toFixed(frequencyHz >= 10_000 ? 0 : 1)} kHz` : `${Math.round(frequencyHz)} Hz`;
}

/** −Infinity no cabe en JSON ni pasa la validación: se guarda el suelo de −200 dB, a 0,1 dB. */
function toStorableDecibels(decibelSpectrum: Float32Array): number[] {
  return Array.from(decibelSpectrum, (binDecibels) =>
    Number.isFinite(binDecibels) ? Math.round(Math.max(-200, binDecibels) * 10) / 10 : -200,
  );
}

export function AudioSpectrumScreen({
  calibrationParameters,
  saveMeasurement,
}: InstrumentScreenProps<AudioSpectrumMeasurementValues, SoundLevelCalibrationParameters>) {
  const { t } = useTranslation(audioSpectrumInstrumentId);
  const themePalette = useThemePalette();
  const [isRunning, setIsRunning] = useState(true);
  const [frequencyScale, setFrequencyScale] = useState<FrequencyScale>('logarithmic');
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { microphoneState, isListening } = useMicrophoneAnalyser({ isRunning, frequencyScale });

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
    // En pausa antes de la primera trama: no hay nada que dibujar, pero sí se puede reanudar.
    return (
      <ScreenContainer>
        <BodyText tone="secondary">{t('paused')}</BodyText>
        <AppButton label={t('resume')} onPress={() => setIsRunning(true)} variant="secondary" />
      </ScreenContainer>
    );
  }

  const { frame } = microphoneState;
  const { analysis } = frame;
  const { smoothedLevelDecibelsFullScale } = frame;
  const calibrationOffset = calibrationParameters?.decibelOffset ?? null;
  const musicalNote = analysis.dominantFrequencyHz ? frequencyToMusicalNote(analysis.dominantFrequencyHz) : null;
  const newestRowStart = Math.max(0, frame.history.newestRowIndex) * frame.history.columnCount;
  const maximumDisplayFrequencyHz = Math.min(20_000, frame.sampleRateHz / 2);
  const frequencyLabels: [string, string] = [
    formatFrequency(frequencyScale === 'logarithmic' ? minimumDisplayFrequencyHz : 0),
    formatFrequency(maximumDisplayFrequencyHz),
  ];

  async function handleSave() {
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          sampleRateHz: frame.sampleRateHz,
          fftSize: frame.decibelSpectrum.length * 2,
          levelDecibelsFullScale: Math.round(analysis.levelDecibelsFullScale * 10) / 10,
          ...(calibrationOffset !== null
            ? { soundPressureLevelDecibels: Math.round((analysis.levelDecibelsFullScale + calibrationOffset) * 10) / 10 }
            : {}),
          ...(analysis.dominantFrequencyHz !== null ? { dominantFrequencyHz: analysis.dominantFrequencyHz } : {}),
          ...(analysis.dominantToneDecibelsFullScale !== null
            ? { dominantToneDecibelsFullScale: Math.round(analysis.dominantToneDecibelsFullScale * 10) / 10 }
            : {}),
          spectrumDecibels: toStorableDecibels(frame.decibelSpectrum),
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
      <View style={styles.readingsRow}>
        <Card style={styles.readingCard}>
          <BodyText tone="secondary" style={styles.readingLabel}>
            {t('fields.dominantFrequency')}
          </BodyText>
          <BodyText style={styles.readingValue}>
            {analysis.dominantFrequencyHz !== null ? `${analysis.dominantFrequencyHz.toFixed(1)} Hz` : '—'}
          </BodyText>
          <BodyText tone="secondary">
            {musicalNote
              ? `${t(`notes.${musicalNote.noteIndex}`)}${musicalNote.octave} ${musicalNote.centsOffset >= 0 ? '+' : ''}${musicalNote.centsOffset} ct`
              : ' '}
          </BodyText>
        </Card>
        <Card style={styles.readingCard}>
          <BodyText tone="secondary" style={styles.readingLabel}>
            {calibrationOffset !== null ? t('fields.soundPressureLevel') : t('fields.level')}
          </BodyText>
          <BodyText style={styles.readingValue}>
            {calibrationOffset !== null
              ? `${(smoothedLevelDecibelsFullScale + calibrationOffset).toFixed(0)} dB`
              : `${smoothedLevelDecibelsFullScale.toFixed(1)} dBFS`}
          </BodyText>
          <BodyText tone="secondary">{calibrationOffset !== null ? t('approximate') : t('uncalibrated')}</BodyText>
        </Card>
      </View>

      <SignalChart
        series={[
          {
            values: frame.history.decibelRows,
            color: themePalette.accent,
            startIndex: newestRowStart,
            sampleCount: frame.history.columnCount,
          },
        ]}
        height={140}
        verticalRange={{ mode: 'fixed', minimum: displayMinimumDecibels, maximum: displayMaximumDecibels }}
        revision={frame.revision}
        unitLabel="dB"
        horizontalLabels={frequencyLabels}
        accessibilityLabel={t('spectrumChart')}
      />
      <SpectrogramView
        history={frame.history}
        revision={frame.revision}
        height={180}
        minimumDecibels={displayMinimumDecibels}
        maximumDecibels={displayMaximumDecibels}
        horizontalLabels={frequencyLabels}
        accessibilityLabel={t('waterfallChart')}
      />

      <View style={styles.segmentedRow}>
        {(['logarithmic', 'linear'] as const).map((scaleOption) => {
          const isSelectedScale = scaleOption === frequencyScale;
          return (
            <Pressable
              key={scaleOption}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedScale }}
              onPress={() => setFrequencyScale(scaleOption)}
              style={[styles.segment, { borderColor: isSelectedScale ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelectedScale ? 'accent' : 'primary'}>{t(`scale.${scaleOption}`)}</BodyText>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton
            label={isRunning ? t('pause') : t('resume')}
            onPress={() => setIsRunning((wasRunning) => !wasRunning)}
            variant="secondary"
          />
        </View>
        <View style={styles.buttonCell}>
          <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
        </View>
      </View>
      {!isListening ? <BodyText tone="secondary">{t('paused')}</BodyText> : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  readingsRow: { flexDirection: 'row', gap: 8 },
  readingCard: { flex: 1, padding: 12, gap: 2 },
  readingLabel: { fontSize: 13 },
  readingValue: { fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  privacyNote: { fontSize: 13 },
});
