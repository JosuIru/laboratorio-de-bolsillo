import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import {
  type RotationVibration,
  solveFourRunBalancing,
  splitCorrectionBetweenBlades,
  trialPositionsDegrees,
} from './balancingEngine';
import type { PropellerBalancerMeasurementValues } from './schema';
import { useVibrationCapture, type VibrationCaptureState } from './useVibrationCapture';

export const propellerBalancerInstrumentId = 'propeller-balancer';

const bladeCountOptions = [2, 3, 4, 5, 6] as const;
/** Pasadas: sin peso y con el peso de prueba en 0°, 120° y 240°. */
const runCount = 1 + trialPositionsDegrees.length;
/** Si la velocidad de una pasada se aparta más de esto de la primera, se avisa. */
const maximumSpeedChangeFraction = 0.05;

export function PropellerBalancerScreen({
  saveMeasurement,
}: InstrumentScreenProps<PropellerBalancerMeasurementValues>) {
  const { t } = useTranslation(propellerBalancerInstrumentId);
  const themePalette = useThemePalette();
  const { captureState, startCapture, resetCapture } = useVibrationCapture();

  const [bladeCount, setBladeCount] = useState<number>(2);
  const [trialMassText, setTrialMassText] = useState('1');
  const [runVibrations, setRunVibrations] = useState<(RotationVibration | null)[]>(() =>
    new Array(runCount).fill(null),
  );
  const [checkVibration, setCheckVibration] = useState<RotationVibration | null>(null);
  const [isMeasuringCheck, setIsMeasuringCheck] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const trialMassGrams = parseDecimalInput(trialMassText);
  const isTrialMassValid = trialMassGrams !== null && trialMassGrams > 0;
  const nextRunIndex = runVibrations.findIndex((runVibration) => runVibration === null);
  const referenceFrequencyHz = runVibrations[0]?.rotationFrequencyHz ?? null;

  // Cada captura terminada se guarda en su pasada (o en la comprobación final).
  const [handledCapture, setHandledCapture] = useState<VibrationCaptureState | null>(null);
  if (captureState.status === 'done' && handledCapture !== captureState) {
    setHandledCapture(captureState);
    if (isMeasuringCheck) {
      setCheckVibration(captureState.vibration);
      setIsMeasuringCheck(false);
    } else if (nextRunIndex >= 0) {
      setRunVibrations(
        runVibrations.map((runVibration, runIndex) =>
          runIndex === nextRunIndex ? captureState.vibration : runVibration,
        ),
      );
    }
  }

  const areRunsComplete = nextRunIndex < 0;
  const balancingResult =
    areRunsComplete && isTrialMassValid
      ? solveFourRunBalancing({
          initialAmplitude: runVibrations[0]!.amplitude,
          trialAmplitudes: [runVibrations[1]!.amplitude, runVibrations[2]!.amplitude, runVibrations[3]!.amplitude],
          trialMassGrams,
        })
      : null;
  const balancingSolution = balancingResult && typeof balancingResult === 'object' ? balancingResult : null;
  const bladeCorrections = balancingSolution
    ? splitCorrectionBetweenBlades(
        balancingSolution.correctionMassGrams,
        balancingSolution.correctionAngleDegrees,
        bladeCount,
      )
    : [];
  const hasSpeedChanged =
    referenceFrequencyHz !== null &&
    runVibrations.some(
      (runVibration) =>
        runVibration !== null &&
        Math.abs(runVibration.rotationFrequencyHz - referenceFrequencyHz) / referenceFrequencyHz >
          maximumSpeedChangeFraction,
    );
  const isCapturing = captureState.status === 'capturing';

  function handleMeasure() {
    setStatusMessage(null);
    startCapture(nextRunIndex === 0 ? null : referenceFrequencyHz);
  }

  function handleMeasureCheck() {
    setStatusMessage(null);
    setIsMeasuringCheck(true);
    startCapture(referenceFrequencyHz);
  }

  function handleRestart() {
    setRunVibrations(new Array(runCount).fill(null));
    setCheckVibration(null);
    setIsMeasuringCheck(false);
    setStatusMessage(null);
    resetCapture();
  }

  async function handleSave() {
    if (!areRunsComplete || !isTrialMassValid) return;
    setIsSaving(true);
    setStatusMessage(null);
    const roundTo = (numericValue: number, fractionDigits: number) =>
      Math.round(numericValue * 10 ** fractionDigits) / 10 ** fractionDigits;
    try {
      await saveMeasurement({
        values: {
          rotationSpeedRpm: Math.round(runVibrations[0]!.rotationFrequencyHz * 60),
          bladeCount,
          trialMassGrams,
          runAmplitudes: runVibrations.map((runVibration) => roundTo(runVibration!.amplitude, 4)),
          ...(balancingSolution
            ? {
                correctionMassGrams: roundTo(balancingSolution.correctionMassGrams, 2),
                correctionAngleDegrees: Math.round(balancingSolution.correctionAngleDegrees),
              }
            : {}),
          ...(checkVibration ? { amplitudeAfterCorrection: roundTo(checkVibration.amplitude, 4) } : {}),
          outcome: typeof balancingResult === 'string' ? balancingResult : 'solved',
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const inputStyle = [styles.textInput, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  return (
    <ScreenContainer>
      <Card>
        <SectionTitle>{t('howTo.title')}</SectionTitle>
        <BodyText tone="secondary">{t('howTo.mount')}</BodyText>
        <BodyText tone="secondary">{t('howTo.marks')}</BodyText>
        <BodyText tone="secondary">{t('howTo.safety')}</BodyText>
      </Card>

      <Card>
        <SectionTitle>{t('setup.title')}</SectionTitle>
        <BodyText>{t('setup.bladeCount')}</BodyText>
        <View style={styles.chipRow}>
          {bladeCountOptions.map((bladeCountOption) => {
            const isSelected = bladeCountOption === bladeCount;
            return (
              <Pressable
                key={bladeCountOption}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() => setBladeCount(bladeCountOption)}
                style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}
              >
                <BodyText tone={isSelected ? 'accent' : 'primary'}>{String(bladeCountOption)}</BodyText>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.inputRow}>
          <BodyText>{t('setup.trialMass')}</BodyText>
          <TextInput
            value={trialMassText}
            onChangeText={setTrialMassText}
            keyboardType="decimal-pad"
            accessibilityLabel={t('setup.trialMass')}
            style={inputStyle}
          />
          <BodyText>g</BodyText>
        </View>
        {!isTrialMassValid ? <BodyText tone="danger">{t('setup.trialMassInvalid')}</BodyText> : null}
      </Card>

      <Card>
        <SectionTitle>{t('runs.title')}</SectionTitle>
        {runVibrations.map((runVibration, runIndex) => (
          <View key={runIndex} style={[styles.runRow, { borderBottomColor: themePalette.border }]}>
            <BodyText style={styles.runLabel} tone={runIndex === nextRunIndex ? 'accent' : 'primary'}>
              {runIndex === 0 ? t('runs.initial') : t('runs.trial', { angle: trialPositionsDegrees[runIndex - 1] })}
            </BodyText>
            <BodyText style={styles.runValue}>
              {runVibration
                ? t('runs.value', {
                    amplitude: runVibration.amplitude.toFixed(3),
                    rpm: Math.round(runVibration.rotationFrequencyHz * 60),
                  })
                : '—'}
            </BodyText>
          </View>
        ))}
        {!areRunsComplete ? (
          <BodyText tone="secondary">
            {nextRunIndex === 0
              ? t('runs.instructionInitial')
              : t('runs.instructionTrial', { angle: trialPositionsDegrees[nextRunIndex - 1], mass: trialMassText })}
          </BodyText>
        ) : null}
        {isCapturing ? (
          <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
            <View
              style={[
                styles.progressFill,
                { width: `${captureState.progress * 100}%`, backgroundColor: themePalette.accent },
              ]}
            />
          </View>
        ) : null}
        {captureState.status === 'failed' ? <BodyText tone="danger">{t('runs.failed')}</BodyText> : null}
        {hasSpeedChanged ? <BodyText tone="danger">{t('runs.speedChanged')}</BodyText> : null}
        {!areRunsComplete ? (
          <AppButton
            label={isCapturing ? t('runs.measuring') : t('runs.measure')}
            onPress={handleMeasure}
            isBusy={isCapturing}
            isDisabled={isCapturing || !isTrialMassValid}
          />
        ) : null}
      </Card>

      {areRunsComplete ? (
        <Card>
          <SectionTitle>{t('result.title')}</SectionTitle>
          {balancingSolution ? (
            <>
              <BodyText style={styles.mainValue}>
                {t('result.correction', {
                  mass: balancingSolution.correctionMassGrams.toFixed(2),
                  angle: Math.round(balancingSolution.correctionAngleDegrees),
                })}
              </BodyText>
              <BodyText tone="secondary">{t('result.removeTrial')}</BodyText>
              {bladeCorrections.map((bladeCorrection) => (
                <BodyText key={bladeCorrection.bladeNumber}>
                  {t('result.blade', {
                    blade: bladeCorrection.bladeNumber,
                    mass: bladeCorrection.massGrams.toFixed(2),
                  })}
                </BodyText>
              ))}
              <BodyText tone="secondary">{t('result.checkHint')}</BodyText>
              <AppButton
                label={isMeasuringCheck && isCapturing ? t('runs.measuring') : t('result.measureCheck')}
                variant="secondary"
                onPress={handleMeasureCheck}
                isDisabled={isCapturing}
              />
              {checkVibration ? (
                <BodyText>
                  {t('result.checkValue', {
                    before: runVibrations[0]!.amplitude.toFixed(3),
                    after: checkVibration.amplitude.toFixed(3),
                    reduction: Math.round((1 - checkVibration.amplitude / runVibrations[0]!.amplitude) * 100),
                  })}
                </BodyText>
              ) : null}
            </>
          ) : (
            <BodyText tone="danger">{balancingResult ? t(`problem.${balancingResult}`) : ''}</BodyText>
          )}
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
            </View>
            <View style={styles.buttonCell}>
              <AppButton label={t('restart')} variant="secondary" onPress={handleRestart} />
            </View>
          </View>
        </Card>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1.5 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  textInput: { minWidth: 64, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 16 },
  runRow: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  runLabel: { flex: 1 },
  runValue: { flex: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8 },
  mainValue: { fontSize: 22, fontWeight: '700' },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
