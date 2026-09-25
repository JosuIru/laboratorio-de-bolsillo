import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { minimumUltrasonicSampleRateHz } from '@/processing/sonar/chirp';
import type { SonarBandPreset } from '@/processing/sonar/hardwareTest';
import { speedOfSoundMetersPerSecond } from '@/processing/sonar/soundSpeed';
import { SpectrogramView } from '@/ui/charts/SpectrogramView';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { SonarMeasurementValues } from './schema';
import {
  clampTemperatureCelsius,
  defaultTemperatureCelsius,
  defaultVolume,
  echogramMaximumDecibels,
  echogramMinimumDecibels,
  maximumRangeMeters,
  savedProfileColumnCount,
  sonarInstrumentId,
  volumeOptions,
} from './sonarConfiguration';
import { useDopplerGestures } from './useDopplerGestures';
import { useSonarPulses } from './useSonarPulses';
import { useUltrasoundHardwareTest } from './useUltrasoundHardwareTest';

export { sonarInstrumentId };

type SonarMode = 'distance' | 'echogram' | 'gestures';

const sonarModes: readonly SonarMode[] = ['distance', 'echogram', 'gestures'];
const bandPresetOptions: readonly SonarBandPreset[] = ['ultrasonic', 'nearUltrasonic'];
/** Velocidad (m/s) que llena la barra del indicador de gestos. */
const gestureBarFullScaleMetersPerSecond = 1;

function formatKilohertz(frequencyHz: number): string {
  return (frequencyHz / 1000).toFixed(1);
}

function SegmentedChoice<TOption extends string | number>({
  options,
  selectedOption,
  onSelect,
  labelFor,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  onSelect(option: NoInfer<TOption>): void;
  labelFor(option: NoInfer<TOption>): string;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.segmentedRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[styles.segment, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
            <BodyText tone={isSelected ? 'accent' : 'primary'} style={styles.segmentLabel}>
              {labelFor(option)}
            </BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

type PositionBarVariant = 'marker' | 'fill' | 'centered';

/**
 * Barra horizontal: `marker` pone una marca en `fraction` (0-1), `fill` rellena hasta ella y
 * `centered` rellena desde el centro hacia un lado (`fraction` entre −1 y 1).
 */
function PositionBar({ fraction, variant = 'marker' }: { fraction: number | null; variant?: PositionBarVariant }) {
  const themePalette = useThemePalette();
  const isCentered = variant === 'centered';
  const clampedFraction = fraction === null ? null : Math.min(1, Math.max(isCentered ? -1 : 0, fraction));
  let indicatorStyle = null;
  if (clampedFraction !== null) {
    if (variant === 'marker') {
      indicatorStyle = [
        styles.positionMarker,
        { backgroundColor: themePalette.accent, left: `${clampedFraction * 100}%` as const },
      ];
    } else if (variant === 'fill') {
      indicatorStyle = [
        styles.positionFill,
        { backgroundColor: themePalette.accent, left: 0, width: `${clampedFraction * 100}%` as const },
      ];
    } else {
      indicatorStyle = [
        styles.positionFill,
        {
          backgroundColor: themePalette.accent,
          left: `${50 + Math.min(0, clampedFraction) * 50}%` as const,
          width: `${Math.abs(clampedFraction) * 50}%` as const,
        },
      ];
    }
  }
  return (
    <View style={[styles.positionTrack, { backgroundColor: themePalette.border }]}>
      {isCentered ? (
        <View style={[styles.positionCenterLine, { backgroundColor: themePalette.textSecondary }]} />
      ) : null}
      {indicatorStyle ? <View style={indicatorStyle} /> : null}
    </View>
  );
}

export function SonarScreen({ saveMeasurement }: InstrumentScreenProps<SonarMeasurementValues>) {
  const { t } = useTranslation(sonarInstrumentId);
  const [sonarMode, setSonarMode] = useState<SonarMode>('distance');
  const [isRunning, setIsRunning] = useState(false);
  const [bandPreset, setBandPreset] = useState<SonarBandPreset>('ultrasonic');
  const [volume, setVolume] = useState(defaultVolume);
  const [temperatureCelsius, setTemperatureCelsius] = useState(defaultTemperatureCelsius);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const { testState, runTest, cancelTest } = useUltrasoundHardwareTest(volume);
  const isTestRunning = testState.phase === 'running';
  const isPulseModeActive = isRunning && !isTestRunning && sonarMode !== 'gestures';
  const isGestureModeActive = isRunning && !isTestRunning && sonarMode === 'gestures';
  const { pulsesStatus, snapshot, echogramHistory, recordBackground, clearBackground } = useSonarPulses({
    isRunning: isPulseModeActive,
    bandPreset,
    volume,
    temperatureCelsius,
  });
  const { dopplerStatus, reading } = useDopplerGestures({
    isRunning: isGestureModeActive,
    bandPreset,
    volume,
    temperatureCelsius,
  });
  const speedOfSound = speedOfSoundMetersPerSecond(temperatureCelsius);
  const strongestEcho = snapshot.strongestEcho;

  function handleStartTest() {
    setIsRunning(false);
    void runTest();
  }

  async function handleSave() {
    if (!strongestEcho || !snapshot.band || snapshot.sampleRateHz === null) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      // Reduce el perfil del ecograma a menos columnas (máximo de cada grupo).
      const columnsPerSavedColumn = Math.max(
        1,
        Math.floor(snapshot.latestEchogramRow.length / savedProfileColumnCount),
      );
      const echoProfileDecibels = Array.from({ length: savedProfileColumnCount }, (_, savedColumnIndex) => {
        const groupColumns = snapshot.latestEchogramRow.slice(
          savedColumnIndex * columnsPerSavedColumn,
          (savedColumnIndex + 1) * columnsPerSavedColumn,
        );
        return groupColumns.length > 0 ? Math.round(Math.max(...groupColumns) * 10) / 10 : 0;
      });
      await saveMeasurement({
        values: {
          distanceMeters: Math.round(strongestEcho.distanceMeters * 1000) / 1000,
          echoDelayMilliseconds: Math.round(strongestEcho.echoDelaySeconds * 1e6) / 1000,
          temperatureCelsius,
          speedOfSoundMetersPerSecond: Math.round(speedOfSound * 10) / 10,
          relativeEchoLevelDecibels: Math.round(20 * Math.log10(strongestEcho.relativeAmplitude) * 10) / 10,
          signalToNoiseRatio: Math.round(strongestEcho.signalToNoiseRatio * 10) / 10,
          bandLowFrequencyHz: Math.round(snapshot.band.lowFrequencyHz),
          bandHighFrequencyHz: Math.round(snapshot.band.highFrequencyHz),
          sampleRateHz: snapshot.sampleRateHz,
          averagedPulseCount: snapshot.averagedPulseCount,
          isBackgroundSubtracted: snapshot.hasBackground,
          echoProfileDecibels,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const activeStatus = sonarMode === 'gestures' ? dopplerStatus : pulsesStatus;
  const sampleRateHz = snapshot.sampleRateHz;

  function renderPulseStatus() {
    if (pulsesStatus.status === 'starting') return <BodyText tone="secondary">{t('starting')}</BodyText>;
    if (pulsesStatus.status === 'inputSampleRateTooLow') {
      return (
        <BodyText tone="danger">{t('inputSampleRateTooLow', { sampleRate: pulsesStatus.inputSampleRateHz })}</BodyText>
      );
    }
    if (pulsesStatus.status === 'running' && snapshot.pulseCount > 0 && !snapshot.isDirectPathDetected) {
      return <BodyText tone="danger">{t('directPathMissing')}</BodyText>;
    }
    return null;
  }

  function renderBackgroundControls() {
    const isRecordingBackground = snapshot.backgroundProgress !== null;
    return (
      <>
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton
              label={
                isRecordingBackground
                  ? t('background.recording', { percent: Math.round((snapshot.backgroundProgress ?? 0) * 100) })
                  : t('background.record')
              }
              onPress={recordBackground}
              variant="secondary"
              isDisabled={pulsesStatus.status !== 'running' || isRecordingBackground}
            />
          </View>
          <View style={styles.buttonCell}>
            <AppButton
              label={t('background.clear')}
              onPress={clearBackground}
              variant="secondary"
              isDisabled={!snapshot.hasBackground}
            />
          </View>
        </View>
        <BodyText tone="secondary" style={styles.smallText}>
          {snapshot.hasBackground ? t('background.active') : t('background.help')}
        </BodyText>
      </>
    );
  }

  return (
    <ScreenContainer>
      <Card>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('hearingWarning')}
        </BodyText>
      </Card>

      <SegmentedChoice
        options={sonarModes}
        selectedOption={sonarMode}
        onSelect={setSonarMode}
        labelFor={(mode) => t(`modes.${mode}`)}
      />

      <AppButton
        label={isRunning ? t('stop') : t('start')}
        onPress={() => setIsRunning((wasRunning) => !wasRunning)}
        variant={isRunning ? 'secondary' : 'primary'}
        isDisabled={isTestRunning}
      />
      {activeStatus.status === 'error' ? (
        <BodyText tone="danger">{t('core:common.error', { message: activeStatus.errorMessage })}</BodyText>
      ) : null}

      {sonarMode === 'distance' ? (
        <>
          <Card style={styles.readingCard}>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('fields.distance')}
            </BodyText>
            <View accessibilityLiveRegion="polite">
              <BodyText style={styles.readingValue} tone={strongestEcho ? 'accent' : 'secondary'}>
                {strongestEcho ? `${strongestEcho.distanceMeters.toFixed(2)} m` : '—'}
              </BodyText>
            </View>
            <PositionBar fraction={strongestEcho ? strongestEcho.distanceMeters / maximumRangeMeters : null} />
            <View style={styles.axisRow}>
              <BodyText tone="secondary" style={styles.smallText}>
                0 m
              </BodyText>
              <BodyText tone="secondary" style={styles.smallText}>
                {`${maximumRangeMeters} m`}
              </BodyText>
            </View>
            {strongestEcho ? (
              <BodyText tone="secondary" style={styles.smallText}>
                {t('echoSummary', {
                  delay: (strongestEcho.echoDelaySeconds * 1000).toFixed(2),
                  level: (20 * Math.log10(strongestEcho.relativeAmplitude)).toFixed(0),
                  clarity: strongestEcho.signalToNoiseRatio.toFixed(0),
                })}
              </BodyText>
            ) : isPulseModeActive && pulsesStatus.status === 'running' && snapshot.isDirectPathDetected ? (
              <BodyText tone="secondary">{t('noEcho')}</BodyText>
            ) : null}
            {renderPulseStatus()}
          </Card>
          {renderBackgroundControls()}
          <AppButton
            label={t('core:common.save')}
            onPress={() => void handleSave()}
            isBusy={isSaving}
            isDisabled={!strongestEcho || !isPulseModeActive}
          />
          <BodyText tone="secondary" style={styles.smallText}>
            {t('distanceHelp')}
          </BodyText>
        </>
      ) : null}

      {sonarMode === 'echogram' ? (
        <>
          <SpectrogramView
            history={echogramHistory}
            revision={snapshot.pulseCount}
            height={240}
            minimumDecibels={echogramMinimumDecibels}
            maximumDecibels={echogramMaximumDecibels}
            horizontalLabels={['0 m', `${maximumRangeMeters} m`]}
            accessibilityLabel={t('echogram.accessibilityLabel')}
          />
          {renderPulseStatus()}
          <BodyText tone="secondary" style={styles.smallText}>
            {strongestEcho
              ? t('echogram.strongest', { distance: strongestEcho.distanceMeters.toFixed(2) })
              : t('echogram.help')}
          </BodyText>
          {renderBackgroundControls()}
        </>
      ) : null}

      {sonarMode === 'gestures' ? (
        <Card style={styles.readingCard}>
          <View accessibilityLiveRegion="polite">
            <BodyText
              style={styles.gestureValue}
              tone={reading && reading.gesture !== 'still' ? 'accent' : 'secondary'}>
              {t(`gestures.${reading?.gesture ?? 'still'}`)}
            </BodyText>
          </View>
          <PositionBar
            variant="centered"
            fraction={reading ? reading.velocityMetersPerSecond / gestureBarFullScaleMetersPerSecond : null}
          />
          <View style={styles.axisRow}>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('gestures.away')}
            </BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('gestures.closer')}
            </BodyText>
          </View>
          {reading ? (
            <BodyText tone="secondary" style={styles.smallText}>
              {t('gestures.summary', {
                carrier: formatKilohertz(reading.carrierFrequencyHz),
                shift: reading.shiftHz.toFixed(0),
                velocity: reading.velocityMetersPerSecond.toFixed(2),
              })}
            </BodyText>
          ) : dopplerStatus.status === 'starting' ? (
            <BodyText tone="secondary">{t('starting')}</BodyText>
          ) : null}
          {reading && !reading.isCarrierHeard ? <BodyText tone="danger">{t('gestures.toneMissing')}</BodyText> : null}
          <BodyText tone="secondary" style={styles.smallText}>
            {t('gestures.help')}
          </BodyText>
        </Card>
      ) : null}

      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <SectionTitle>{t('settings.title')}</SectionTitle>
      <Card>
        <BodyText>{t('settings.band')}</BodyText>
        <SegmentedChoice
          options={bandPresetOptions}
          selectedOption={bandPreset}
          onSelect={setBandPreset}
          labelFor={(preset) => t(`bands.${preset}`)}
        />
        {snapshot.band && sonarMode !== 'gestures' ? (
          <BodyText tone="secondary" style={styles.smallText}>
            {t('settings.activeBand', {
              low: formatKilohertz(snapshot.band.lowFrequencyHz),
              high: formatKilohertz(snapshot.band.highFrequencyHz),
              sampleRate: sampleRateHz ?? '—',
            })}
          </BodyText>
        ) : null}
        {sampleRateHz !== null && sampleRateHz < minimumUltrasonicSampleRateHz ? (
          <BodyText tone="danger" style={styles.smallText}>
            {t('settings.lowSampleRate', { sampleRate: sampleRateHz })}
          </BodyText>
        ) : snapshot.band?.isLikelyAudible ? (
          <BodyText tone="danger" style={styles.smallText}>
            {t('settings.audibleBand')}
          </BodyText>
        ) : null}

        <BodyText>{t('settings.volume')}</BodyText>
        <SegmentedChoice
          options={volumeOptions}
          selectedOption={volume}
          onSelect={setVolume}
          labelFor={(volumeOption) => `${Math.round(volumeOption * 100)} %`}
        />

        <BodyText>{t('settings.temperature')}</BodyText>
        <View style={styles.temperatureRow}>
          <View style={styles.stepButton}>
            <AppButton
              label="−"
              variant="secondary"
              onPress={() => setTemperatureCelsius((previous) => clampTemperatureCelsius(previous - 1))}
            />
          </View>
          <BodyText style={styles.temperatureValue}>{`${temperatureCelsius} °C`}</BodyText>
          <View style={styles.stepButton}>
            <AppButton
              label="+"
              variant="secondary"
              onPress={() => setTemperatureCelsius((previous) => clampTemperatureCelsius(previous + 1))}
            />
          </View>
        </View>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('settings.speedOfSound', { speed: speedOfSound.toFixed(1) })}
        </BodyText>
      </Card>

      <SectionTitle>{t('hardwareTest.title')}</SectionTitle>
      <Card>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('hardwareTest.help')}
        </BodyText>
        {testState.phase === 'running' ? (
          <>
            <BodyText>
              {testState.currentFrequencyHz === null
                ? t('hardwareTest.measuringNoise')
                : t('hardwareTest.progress', {
                    frequency: formatKilohertz(testState.currentFrequencyHz),
                    step: testState.completedStepCount + 1,
                    total: testState.totalStepCount,
                  })}
            </BodyText>
            <AppButton label={t('hardwareTest.cancel')} onPress={cancelTest} variant="secondary" />
          </>
        ) : (
          <AppButton label={t('hardwareTest.run')} onPress={handleStartTest} variant="secondary" />
        )}
        {testState.phase === 'error' ? (
          <BodyText tone="danger">{t('core:common.error', { message: testState.errorMessage })}</BodyText>
        ) : null}
        {testState.phase === 'done' ? (
          <>
            <BodyText
              tone={testState.summary.verdict === 'notSupported' ? 'danger' : 'accent'}
              style={styles.verdictText}>
              {t(`hardwareTest.verdicts.${testState.summary.verdict}`)}
            </BodyText>
            {testState.bandResults.map((bandResult) => (
              <View key={bandResult.frequencyHz} style={styles.bandResultRow}>
                <BodyText style={styles.bandFrequency}>{`${formatKilohertz(bandResult.frequencyHz)} kHz`}</BodyText>
                <View style={styles.bandBarCell}>
                  <PositionBar variant="fill" fraction={Math.max(0, bandResult.signalToNoiseDecibels) / 50} />
                </View>
                <BodyText
                  tone={
                    bandResult.reception === 'good' ? 'accent' : bandResult.reception === 'weak' ? 'primary' : 'danger'
                  }
                  style={styles.bandReception}>
                  {t(`hardwareTest.reception.${bandResult.reception}`, {
                    decibels: bandResult.signalToNoiseDecibels.toFixed(0),
                  })}
                </BodyText>
              </View>
            ))}
            {testState.summary.recommendedPreset && testState.summary.recommendedPreset !== bandPreset ? (
              <AppButton
                label={t('hardwareTest.useRecommended', {
                  band: t(`bands.${testState.summary.recommendedPreset}`),
                })}
                onPress={() => setBandPreset(testState.summary.recommendedPreset ?? 'ultrasonic')}
              />
            ) : null}
          </>
        ) : null}
      </Card>

      <BodyText tone="secondary" style={styles.smallText}>
        {t('honestyNote')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  readingCard: { alignItems: 'stretch', paddingVertical: 20, gap: 6 },
  readingValue: { fontSize: 44, lineHeight: 52, fontWeight: '700', fontVariant: ['tabular-nums'], textAlign: 'center' },
  gestureValue: { fontSize: 30, lineHeight: 38, fontWeight: '700', textAlign: 'center' },
  smallText: { fontSize: 13 },
  verdictText: { fontWeight: '600' },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  segmentLabel: { fontSize: 14, textAlign: 'center' },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between' },
  positionTrack: { height: 10, borderRadius: 5, overflow: 'hidden', justifyContent: 'center' },
  positionMarker: { position: 'absolute', width: 6, marginLeft: -3, top: 0, bottom: 0, borderRadius: 3 },
  positionFill: { position: 'absolute', top: 0, bottom: 0 },
  positionCenterLine: { position: 'absolute', left: '50%', width: 2, top: 0, bottom: 0 },
  temperatureRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  temperatureValue: { flex: 1, textAlign: 'center', fontSize: 20, fontVariant: ['tabular-nums'] },
  stepButton: { width: 56 },
  bandResultRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bandFrequency: { width: 72, fontVariant: ['tabular-nums'] },
  bandBarCell: { flex: 1 },
  bandReception: { width: 110, fontSize: 13, textAlign: 'right' },
});
