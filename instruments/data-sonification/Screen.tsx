import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import type { SensorKind } from '@/core/sensors/types';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { DataSonificationMeasurementValues } from './schema';
import {
  normalizedValueToMidiNote,
  type SonificationMode,
  type SonificationScaleId,
  type SonificationSourceId,
  sourceRanges,
} from './sonification';
import { useSonificationPlayer } from './useSonificationPlayer';
import { useSourceValue } from './useSourceValue';

export const dataSonificationInstrumentId = 'data-sonification';

const sourceIds: readonly SonificationSourceId[] = ['tilt', 'vibration', 'rotation', 'magnetic', 'light'];
const sensorBySource: Record<SonificationSourceId, SensorKind> = {
  tilt: 'accelerometer',
  vibration: 'accelerometer',
  rotation: 'gyroscope',
  magnetic: 'magnetometer',
  light: 'light',
};
const modes: readonly SonificationMode[] = ['melody', 'theremin'];
const scaleIds: readonly SonificationScaleId[] = ['major-pentatonic', 'minor-pentatonic', 'major', 'chromatic'];

export function DataSonificationScreen({
  saveMeasurement,
  sensorAvailability,
}: InstrumentScreenProps<DataSonificationMeasurementValues>) {
  const { t } = useTranslation(dataSonificationInstrumentId);
  const themePalette = useThemePalette();
  const [sourceId, setSourceId] = useState<SonificationSourceId>('tilt');
  const [mode, setMode] = useState<SonificationMode>('melody');
  const [scaleId, setScaleId] = useState<SonificationScaleId>('major-pentatonic');
  const [isPlaying, setIsPlaying] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const { sourceReading, latestReadingRef } = useSourceValue(sourceId, isPlaying);
  useSonificationPlayer({ isPlaying, mode, scaleId, latestReadingRef });

  const isSourceAvailable = (candidateSource: SonificationSourceId) =>
    sensorAvailability[sensorBySource[candidateSource]].status === 'available';
  const currentMidiNote = sourceReading ? normalizedValueToMidiNote(sourceReading.normalizedValue, scaleId) : null;

  async function handleSave() {
    if (!sourceReading) return;
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          source: sourceId,
          sourceValue: Math.round(sourceReading.sourceValue * 1000) / 1000,
          sourceUnit: sourceRanges[sourceId].unit,
          normalizedValue: Math.round(sourceReading.normalizedValue * 1000) / 1000,
          mode,
          scale: scaleId,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    }
  }

  return (
    <ScreenContainer>
      <Card>
        <SectionTitle>{t('source.title')}</SectionTitle>
        <View style={styles.chipRow}>
          {sourceIds.map((candidateSource) => (
            <Chip
              key={candidateSource}
              label={t(`source.${candidateSource}`)}
              isSelected={candidateSource === sourceId}
              isDisabled={!isSourceAvailable(candidateSource)}
              onPress={() => setSourceId(candidateSource)}
            />
          ))}
        </View>
        <BodyText tone="secondary">{t(`sourceHint.${sourceId}`)}</BodyText>
        {!isSourceAvailable(sourceId) ? <BodyText tone="danger">{t('sourceUnavailable')}</BodyText> : null}

        <SectionTitle>{t('mode.title')}</SectionTitle>
        <View style={styles.chipRow}>
          {modes.map((candidateMode) => (
            <Chip
              key={candidateMode}
              label={t(`mode.${candidateMode}`)}
              isSelected={candidateMode === mode}
              onPress={() => setMode(candidateMode)}
            />
          ))}
        </View>
        {mode === 'melody' ? (
          <>
            <SectionTitle>{t('scale.title')}</SectionTitle>
            <View style={styles.chipRow}>
              {scaleIds.map((candidateScale) => (
                <Chip
                  key={candidateScale}
                  label={t(`scale.${candidateScale}`)}
                  isSelected={candidateScale === scaleId}
                  onPress={() => setScaleId(candidateScale)}
                />
              ))}
            </View>
          </>
        ) : null}
      </Card>

      <AppButton
        label={isPlaying ? t('stop') : t('play')}
        onPress={() => {
          setStatusMessage(null);
          setIsPlaying((wasPlaying) => !wasPlaying);
        }}
        isDisabled={!isPlaying && !isSourceAvailable(sourceId)}
      />

      {isPlaying ? (
        <Card>
          <BodyText style={styles.valueText}>
            {sourceReading
              ? `${sourceReading.sourceValue.toFixed(sourceId === 'light' ? 0 : 2)} ${sourceRanges[sourceId].unit}`
              : t('waiting')}
          </BodyText>
          <View style={[styles.valueTrack, { backgroundColor: themePalette.border }]}>
            <View
              style={[
                styles.valueFill,
                { width: `${(sourceReading?.normalizedValue ?? 0) * 100}%`, backgroundColor: themePalette.accent },
              ]}
            />
          </View>
          {mode === 'melody' && currentMidiNote !== null ? (
            <BodyText tone="secondary" style={styles.noteText}>
              {`${t(`notes.${currentMidiNote % 12}`)}${Math.floor(currentMidiNote / 12) - 1}`}
            </BodyText>
          ) : null}
          <AppButton
            label={t('core:common.save')}
            variant="secondary"
            onPress={() => void handleSave()}
            isDisabled={!sourceReading}
          />
        </Card>
      ) : (
        <BodyText tone="secondary">{t('intro')}</BodyText>
      )}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
    </ScreenContainer>
  );
}

function Chip({
  label,
  isSelected,
  isDisabled = false,
  onPress,
}: {
  label: string;
  isSelected: boolean;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  const themePalette = useThemePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: isSelected, disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: isSelected ? themePalette.accent : themePalette.border, opacity: isDisabled ? 0.4 : 1 },
      ]}
    >
      <BodyText tone={isSelected ? 'accent' : 'primary'}>{label}</BodyText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  valueText: { fontSize: 28, fontWeight: '700', textAlign: 'center', fontVariant: ['tabular-nums'] },
  valueTrack: { height: 12, borderRadius: 6, overflow: 'hidden' },
  valueFill: { height: 12 },
  noteText: { textAlign: 'center', fontSize: 18 },
});
