import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { StepMusicMeasurementValues } from './schema';
import { cadenceToMusicBpm, compareWithTarget, energyForCadence } from './stepCadence';
import { type GrooveSettings, useGroovePlayer } from './useGroovePlayer';
import { useStepCadence } from './useStepCadence';

export const stepMusicInstrumentId = 'step-music';

type MusicMode = 'follow' | 'target';
const targetCadencePresets = [100, 120, 160, 170, 180] as const;
/** Tempo mientras aún no se ha detectado ningún paso. */
const idleMusicBpm = 96;

export function StepMusicScreen({ saveMeasurement }: InstrumentScreenProps<StepMusicMeasurementValues>) {
  const { t } = useTranslation(stepMusicInstrumentId);
  const themePalette = useThemePalette();
  const [mode, setMode] = useState<MusicMode>('follow');
  const [targetCadence, setTargetCadence] = useState<number>(170);
  const [isPlaying, setIsPlaying] = useState(false);
  // Se usa con el móvil en el bolsillo: si la pantalla se apagara, la música se pararía.
  useKeepScreenOnWhile(isPlaying, 'step-music');
  const [seed, setSeed] = useState(1);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const cadenceEstimate = useStepCadence(isPlaying);

  // Estadísticas de la sesión: cadencia media y tiempo al ritmo del objetivo. Se actualizan
  // durante el render al llegar cada estimación nueva (el patrón de React para derivar estado).
  const [sessionStats, setSessionStats] = useState({ cadenceSum: 0, cadenceCount: 0, onPaceCount: 0 });
  const [countedEstimate, setCountedEstimate] = useState<typeof cadenceEstimate>(null);
  if (cadenceEstimate && cadenceEstimate !== countedEstimate) {
    setCountedEstimate(cadenceEstimate);
    setSessionStats((previousStats) => ({
      cadenceSum: previousStats.cadenceSum + cadenceEstimate.stepsPerMinute,
      cadenceCount: previousStats.cadenceCount + 1,
      onPaceCount:
        previousStats.onPaceCount +
        (compareWithTarget(cadenceEstimate.stepsPerMinute, targetCadence) === 'on-pace' ? 1 : 0),
    }));
  }
  const sessionStartedAtRef = useRef(0);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  useEffect(() => {
    if (!isPlaying) return;
    const clockTimer = setInterval(
      () => setSessionSeconds(Math.round((Date.now() - sessionStartedAtRef.current) / 1000)),
      1000,
    );
    return () => clearInterval(clockTimer);
  }, [isPlaying]);

  const musicBpm =
    mode === 'target'
      ? cadenceToMusicBpm(targetCadence)
      : cadenceEstimate
        ? cadenceToMusicBpm(cadenceEstimate.stepsPerMinute)
        : idleMusicBpm;
  const energy =
    mode === 'target'
      ? energyForCadence(targetCadence)
      : cadenceEstimate
        ? energyForCadence(cadenceEstimate.stepsPerMinute)
        : 0;
  const grooveSettingsRef = useRef<GrooveSettings>({ musicBpm, energy });
  useEffect(() => {
    grooveSettingsRef.current = { musicBpm, energy };
  }, [musicBpm, energy]);
  useGroovePlayer({ isPlaying, grooveSettingsRef, seed });

  const paceComparison =
    cadenceEstimate && mode === 'target' ? compareWithTarget(cadenceEstimate.stepsPerMinute, targetCadence) : null;

  function handleToggle() {
    setStatusMessage(null);
    if (!isPlaying) {
      sessionStartedAtRef.current = Date.now();
      setSessionStats({ cadenceSum: 0, cadenceCount: 0, onPaceCount: 0 });
      setSessionSeconds(0);
      setSeed(Math.floor(Math.random() * 1_000_000));
    }
    setIsPlaying((wasPlaying) => !wasPlaying);
  }

  async function handleSave() {
    const { cadenceSum, cadenceCount, onPaceCount } = sessionStats;
    if (cadenceCount === 0) return;
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          mode,
          durationSeconds: sessionSeconds,
          meanCadence: Math.round(cadenceSum / cadenceCount),
          ...(mode === 'target'
            ? { targetCadence, onPacePercent: Math.round((100 * onPaceCount) / cadenceCount) }
            : {}),
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
        <SectionTitle>{t('mode.title')}</SectionTitle>
        <View style={styles.chipRow}>
          {(['follow', 'target'] as const).map((candidateMode) => (
            <Chip
              key={candidateMode}
              label={t(`mode.${candidateMode}`)}
              isSelected={candidateMode === mode}
              onPress={() => setMode(candidateMode)}
            />
          ))}
        </View>
        <BodyText tone="secondary">{t(`modeHint.${mode}`)}</BodyText>
        {mode === 'target' ? (
          <>
            <SectionTitle>{t('target.title')}</SectionTitle>
            <View style={styles.chipRow}>
              {targetCadencePresets.map((cadencePreset) => (
                <Chip
                  key={cadencePreset}
                  label={t('target.preset', { cadence: cadencePreset, label: t(`target.label.${cadencePreset}`) })}
                  isSelected={cadencePreset === targetCadence}
                  onPress={() => setTargetCadence(cadencePreset)}
                />
              ))}
            </View>
          </>
        ) : null}
      </Card>

      <AppButton label={isPlaying ? t('stop') : t('start')} onPress={handleToggle} />

      {isPlaying ? (
        <Card>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('cadenceLabel')}
          </BodyText>
          <BodyText style={styles.cadenceValue}>
            {cadenceEstimate ? Math.round(cadenceEstimate.stepsPerMinute) : '—'}
          </BodyText>
          <BodyText tone="secondary" style={styles.centeredText}>
            {cadenceEstimate ? t('stepsPerMinute') : t('waitingSteps')}
          </BodyText>
          {paceComparison ? (
            <BodyText tone={paceComparison === 'on-pace' ? 'accent' : 'primary'} style={styles.paceText}>
              {t(`pace.${paceComparison}`)}
            </BodyText>
          ) : null}
          <View style={[styles.energyRow]}>
            {[0, 1, 2, 3].map((energyLevel) => (
              <View
                key={energyLevel}
                style={[
                  styles.energyBar,
                  {
                    backgroundColor: energyLevel <= energy ? themePalette.accent : themePalette.border,
                    height: 10 + 8 * energyLevel,
                  },
                ]}
              />
            ))}
          </View>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('musicTempo', {
              bpm: Math.round(musicBpm),
              minutes: Math.floor(sessionSeconds / 60),
              seconds: String(sessionSeconds % 60).padStart(2, '0'),
            })}
          </BodyText>
        </Card>
      ) : sessionStats.cadenceCount > 0 ? (
        <AppButton label={t('core:common.save')} variant="secondary" onPress={() => void handleSave()} />
      ) : (
        <BodyText tone="secondary">{t('intro')}</BodyText>
      )}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
    </ScreenContainer>
  );
}

function Chip({ label, isSelected, onPress }: { label: string; isSelected: boolean; onPress: () => void }) {
  const themePalette = useThemePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: isSelected }}
      onPress={onPress}
      style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}
    >
      <BodyText tone={isSelected ? 'accent' : 'primary'}>{label}</BodyText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  centeredText: { textAlign: 'center' },
  cadenceValue: { fontSize: 64, fontWeight: '700', lineHeight: 72, textAlign: 'center', fontVariant: ['tabular-nums'] },
  paceText: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  energyRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', gap: 6, marginVertical: 8 },
  energyBar: { width: 16, borderRadius: 3 },
});
