import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import {
  appendTap,
  beatsPerMinuteFromTaps,
  clampBeatsPerMinute,
  maximumBeatsPerMinute,
  minimumBeatsPerMinute,
} from './metronomeTiming';
import { beatsPerBarOptions, loadMetronomeSettings, saveMetronomeSettings } from './metronomeSettingsStorage';
import type { MetronomeMeasurementValues } from './schema';
import { useMetronome } from './useMetronome';

export const metronomeInstrumentId = 'metronome';

const tempoSteps: readonly number[] = [-5, -1, 1, 5];
const beatFlashMilliseconds = 120;

function BeatIndicator({
  beatsPerBar,
  currentBeatInBar,
  soundedBeatCount,
}: {
  beatsPerBar: number;
  currentBeatInBar: number | null;
  soundedBeatCount: number;
}) {
  const themePalette = useThemePalette();
  const [flashOpacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (soundedBeatCount === 0) return;
    flashOpacity.setValue(1);
    Animated.timing(flashOpacity, {
      toValue: 0,
      duration: beatFlashMilliseconds,
      useNativeDriver: true,
    }).start();
  }, [soundedBeatCount, flashOpacity]);

  return (
    <View style={styles.beatDotsRow}>
      {Array.from({ length: beatsPerBar }, (_, beatInBar) => {
        const isCurrentBeat = beatInBar === currentBeatInBar;
        const isAccentBeat = beatsPerBar > 1 && beatInBar === 0;
        return (
          <View
            key={beatInBar}
            style={[
              styles.beatDot,
              isAccentBeat ? styles.accentBeatDot : null,
              { borderColor: themePalette.accent },
            ]}>
            {isCurrentBeat ? (
              <Animated.View
                style={[styles.beatDotFill, { backgroundColor: themePalette.accent, opacity: flashOpacity }]}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function MetronomeScreen(_screenProps: InstrumentScreenProps<MetronomeMeasurementValues>) {
  const { t } = useTranslation(metronomeInstrumentId);
  const themePalette = useThemePalette();
  const [storedSettings] = useState(loadMetronomeSettings);
  const [beatsPerMinute, setBeatsPerMinute] = useState(storedSettings.beatsPerMinute);
  const [beatsPerBar, setBeatsPerBar] = useState(storedSettings.beatsPerBar);
  const [tapTimesSeconds, setTapTimesSeconds] = useState<number[]>([]);
  const { metronomeState, start, stop } = useMetronome(beatsPerMinute, beatsPerBar);
  const isPlaying = metronomeState.phase === 'playing';
  useKeepScreenOnWhile(isPlaying, 'metronome');

  // Se recuerdan el tempo y el compás para la próxima vez.
  useEffect(() => {
    saveMetronomeSettings({ beatsPerMinute, beatsPerBar });
  }, [beatsPerMinute, beatsPerBar]);

  function handleTap() {
    const updatedTapTimesSeconds = appendTap(tapTimesSeconds, performance.now() / 1000);
    setTapTimesSeconds(updatedTapTimesSeconds);
    const tappedBeatsPerMinute = beatsPerMinuteFromTaps(updatedTapTimesSeconds);
    if (tappedBeatsPerMinute !== null) setBeatsPerMinute(tappedBeatsPerMinute);
  }

  return (
    <ScreenContainer>
      <Card style={styles.tempoCard}>
        <BodyText style={styles.tempoValue}>{beatsPerMinute}</BodyText>
        <BodyText tone="secondary">BPM</BodyText>
        <BeatIndicator
          beatsPerBar={beatsPerBar}
          currentBeatInBar={isPlaying ? metronomeState.currentBeatInBar : null}
          soundedBeatCount={isPlaying ? metronomeState.soundedBeatCount : 0}
        />
      </Card>

      <View style={styles.stepRow}>
        {tempoSteps.map((tempoStep) => {
          const steppedBeatsPerMinute = clampBeatsPerMinute(beatsPerMinute + tempoStep);
          return (
            <View key={tempoStep} style={styles.stepCell}>
              <AppButton
                label={tempoStep > 0 ? `+${tempoStep}` : `−${-tempoStep}`}
                onPress={() => setBeatsPerMinute(steppedBeatsPerMinute)}
                variant="secondary"
                isDisabled={steppedBeatsPerMinute === beatsPerMinute}
              />
            </View>
          );
        })}
      </View>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('tempoRange', { minimum: minimumBeatsPerMinute, maximum: maximumBeatsPerMinute })}
      </BodyText>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('tapTempo')}
        onPress={handleTap}
        style={({ pressed }) => [
          styles.tapArea,
          { borderColor: themePalette.border, backgroundColor: pressed ? themePalette.border : themePalette.surface },
        ]}>
        <BodyText>{t('tapTempo')}</BodyText>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('tapTempoHelp')}
        </BodyText>
      </Pressable>

      <BodyText tone="secondary">{t('beatsPerBar')}</BodyText>
      <View style={styles.segmentedRow}>
        {beatsPerBarOptions.map((beatsPerBarOption) => {
          const isSelected = beatsPerBarOption === beatsPerBar;
          return (
            <Pressable
              key={beatsPerBarOption}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              onPress={() => setBeatsPerBar(beatsPerBarOption)}
              style={[styles.segment, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
              <BodyText tone={isSelected ? 'accent' : 'primary'}>{beatsPerBarOption}</BodyText>
            </Pressable>
          );
        })}
      </View>

      {metronomeState.phase === 'error' ? (
        <BodyText tone="danger">{t('core:common.error', { message: metronomeState.errorMessage })}</BodyText>
      ) : null}

      <AppButton label={isPlaying ? t('stop') : t('start')} onPress={isPlaying ? stop : () => void start()} />
      <BodyText tone="secondary" style={styles.smallText}>
        {t('backgroundNote')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  tempoCard: { alignItems: 'center', paddingVertical: 20, gap: 4 },
  tempoValue: { fontSize: 64, lineHeight: 72, fontWeight: '700', fontVariant: ['tabular-nums'] },
  beatDotsRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  beatDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, overflow: 'hidden' },
  accentBeatDot: { width: 30, height: 30, borderRadius: 15 },
  beatDotFill: StyleSheet.absoluteFill,
  stepRow: { flexDirection: 'row', gap: 8 },
  stepCell: { flex: 1 },
  tapArea: { alignItems: 'center', paddingVertical: 20, borderRadius: 12, borderWidth: 1.5, gap: 4 },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  smallText: { fontSize: 13 },
});
