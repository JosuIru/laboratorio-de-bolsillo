import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { useIsScreenActive } from '@/core/useIsScreenActive';
import { detectorThresholdsBySensitivity, type DetectorSensitivity } from '@/processing/magnetics/magneticField';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { useProximityBeeper } from '@/core/audio/useProximityBeeper';
import type { MetalDetectorCalibrationParameters } from './calibration';
import { detectorBeepHeat } from './detectorBeep';
import { metalDetectorInstrumentId } from './instrumentId';
import type { MetalDetectorMeasurementValues } from './schema';
import { chartDurationSeconds, useMagneticField } from './useMagneticField';

export { metalDetectorInstrumentId };

const sensitivityOptions: readonly DetectorSensitivity[] = ['low', 'medium', 'high'];

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function MetalDetectorScreen({
  calibrationParameters,
  saveMeasurement,
}: InstrumentScreenProps<MetalDetectorMeasurementValues, MetalDetectorCalibrationParameters>) {
  const { t } = useTranslation(metalDetectorInstrumentId);
  const themePalette = useThemePalette();
  const [sensitivity, setSensitivity] = useState<DetectorSensitivity>('medium');
  const [isVibrationEnabled, setIsVibrationEnabled] = useState(true);
  // Apagado por defecto: ya avisa la vibración, y el pitido es para barrer sin mirar la pantalla.
  const [isBeepEnabled, setIsBeepEnabled] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // El magnetómetro y el repintado a 20 fps se paran si Historial o Calibrar tapan la pantalla.
  const isScreenActive = useIsScreenActive();
  const { snapshot, zero } = useMagneticField({
    isRunning: isScreenActive,
    sensitivity,
    isVibrationEnabled,
  });
  const { trigger: alertThreshold } = detectorThresholdsBySensitivity[sensitivity];
  // Pitido tipo contador Geiger (el mismo que el buscador de rastreadores): más agudo y rápido
  // cuanto mayor es ΔB. Calla mientras se pone a cero.
  useProximityBeeper(
    isBeepEnabled && isScreenActive,
    snapshot.isZeroing ? null : detectorBeepHeat(snapshot.deviationMicroteslas, alertThreshold),
  );

  if (snapshot.magnitudeMicroteslas === null) return <LoadingState label={t('starting')} />;

  async function handleSave() {
    if (snapshot.magnitudeMicroteslas === null || snapshot.baselineMagnitudeMicroteslas === null) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          baselineMagnitudeMicroteslas: roundToTenth(snapshot.baselineMagnitudeMicroteslas),
          peakDeviationMicroteslas: roundToTenth(snapshot.peakDeviationMicroteslas),
          currentMagnitudeMicroteslas: roundToTenth(snapshot.magnitudeMicroteslas),
          alertThresholdMicroteslas: alertThreshold,
          sensitivity,
          isHardIronCalibrated: calibrationParameters !== null,
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
      <Card style={snapshot.isAboveThreshold ? { ...styles.deviationCard, borderColor: themePalette.accent, borderWidth: 2 } : styles.deviationCard}>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('fields.deviation')}
        </BodyText>
        <View accessibilityLiveRegion="polite">
          <BodyText style={styles.deviationValue} tone={snapshot.isAboveThreshold ? 'accent' : 'primary'}>
            {snapshot.deviationMicroteslas !== null ? `${snapshot.deviationMicroteslas.toFixed(1)} µT` : '—'}
          </BodyText>
        </View>
        <BodyText tone={snapshot.isAboveThreshold ? 'accent' : 'secondary'}>
          {snapshot.isZeroing ? t('zeroing') : snapshot.isAboveThreshold ? t('metalNearby') : t('nothingNearby')}
        </BodyText>
        <BodyText tone="secondary">
          {t('fieldSummary', {
            magnitude: snapshot.magnitudeMicroteslas.toFixed(1),
            peak: snapshot.peakDeviationMicroteslas.toFixed(1),
          })}
        </BodyText>
      </Card>

      <SignalChart
        series={[{ values: snapshot.chartValues, color: themePalette.accent, sampleCount: snapshot.chartSampleCount }]}
        height={140}
        verticalRange={{ mode: 'from-zero', minimumMaximum: alertThreshold * 2 }}
        revision={snapshot.revision}
        unitLabel="µT"
        horizontalLabels={[`−${chartDurationSeconds} s`, t('now')]}
        accessibilityLabel={t('chart')}
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton label={t('zero')} onPress={zero} variant="secondary" isDisabled={snapshot.isZeroing} />
        </View>
        <View style={styles.buttonCell}>
          <AppButton
            label={t('core:common.save')}
            onPress={() => void handleSave()}
            isBusy={isSaving}
            isDisabled={snapshot.isZeroing || snapshot.baselineMagnitudeMicroteslas === null}
          />
        </View>
      </View>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('zeroHelp')}
      </BodyText>

      <Card>
        <BodyText>{t('sensitivity.title')}</BodyText>
        <View style={styles.segmentedRow}>
          {sensitivityOptions.map((sensitivityOption) => {
            const isSelected = sensitivityOption === sensitivity;
            return (
              <Pressable
                key={sensitivityOption}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() => setSensitivity(sensitivityOption)}
                style={[styles.segment, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
                <BodyText tone={isSelected ? 'accent' : 'primary'}>{t(`sensitivity.${sensitivityOption}`)}</BodyText>
              </Pressable>
            );
          })}
        </View>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('sensitivity.threshold', { threshold: alertThreshold })}
        </BodyText>
        <View style={styles.switchRow}>
          <BodyText>{t('vibrate')}</BodyText>
          <Switch
            value={isVibrationEnabled}
            onValueChange={setIsVibrationEnabled}
            accessibilityLabel={t('vibrate')}
            trackColor={{ true: themePalette.accent, false: themePalette.border }}
          />
        </View>
        <View style={styles.switchRow}>
          <BodyText style={styles.switchLabel}>{t('beep')}</BodyText>
          <Switch
            value={isBeepEnabled}
            onValueChange={setIsBeepEnabled}
            accessibilityLabel={t('beep')}
            trackColor={{ true: themePalette.accent, false: themePalette.border }}
          />
        </View>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('beepHelp')}
        </BodyText>
      </Card>

      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      {calibrationParameters === null ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {t('uncalibratedHint')}
        </BodyText>
      ) : null}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('honestyNote')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  deviationCard: { alignItems: 'center', paddingVertical: 20, gap: 4 },
  deviationValue: { fontSize: 44, lineHeight: 52, fontWeight: '700', fontVariant: ['tabular-nums'] },
  smallText: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  switchLabel: { flex: 1 },
});
