import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { type EuroCoin, euroCoinMassesGrams, massOfCoins } from '@/processing/resonanceScale/massCalibration';
import type { PulseResponseAnalysis } from '@/processing/resonanceScale/pulseResponse';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import { resonanceScaleInstrumentId } from './instrumentId';
import { measurementDurationSeconds, type PulseMeasurementState } from './usePulseMeasurement';

const coinOrder: readonly EuroCoin[] = ['oneEuro', 'twoEuros', 'fiftyCents'];
const maximumCoinsPerKind = 20;

export interface MassSelection {
  coinCounts: Record<EuroCoin, number>;
  extraGramsText: string;
}

export const emptyMassSelection: MassSelection = {
  coinCounts: { oneEuro: 0, twoEuros: 0, fiftyCents: 0 },
  extraGramsText: '',
};

/** Masa total elegida, o null si el texto de gramos extra no es un número válido. */
export function selectedMassGrams(massSelection: MassSelection): number | null {
  const coinsMassGrams = massOfCoins(massSelection.coinCounts);
  if (massSelection.extraGramsText.trim() === '') return coinsMassGrams;
  const extraGrams = parseDecimalInput(massSelection.extraGramsText);
  if (extraGrams === null || extraGrams < 0) return null;
  return Math.round((coinsMassGrams + extraGrams) * 10) / 10;
}

/** Contadores de monedas de euro y un campo para otra masa conocida. */
export function MassSelector({
  massSelection,
  onChange,
  isDisabled,
}: {
  massSelection: MassSelection;
  onChange(nextSelection: MassSelection): void;
  isDisabled: boolean;
}) {
  const { t } = useTranslation(resonanceScaleInstrumentId);
  const themePalette = useThemePalette();

  function changeCoinCount(coin: EuroCoin, countChange: number) {
    const nextCount = Math.min(maximumCoinsPerKind, Math.max(0, massSelection.coinCounts[coin] + countChange));
    onChange({ ...massSelection, coinCounts: { ...massSelection.coinCounts, [coin]: nextCount } });
  }

  return (
    <View style={styles.selectorColumn}>
      {coinOrder.map((coin) => (
        <View key={coin} style={styles.coinRow}>
          <BodyText style={styles.coinLabel}>
            {t(`coins.${coin}`, { grams: euroCoinMassesGrams[coin].toLocaleString() })}
          </BodyText>
          <StepperButton
            label="−"
            accessibilityLabel={t('coins.remove', { coin: t(`coins.${coin}Short`) })}
            onPress={() => changeCoinCount(coin, -1)}
            isDisabled={isDisabled || massSelection.coinCounts[coin] === 0}
          />
          <BodyText style={styles.coinCount}>{massSelection.coinCounts[coin]}</BodyText>
          <StepperButton
            label="+"
            accessibilityLabel={t('coins.add', { coin: t(`coins.${coin}Short`) })}
            onPress={() => changeCoinCount(coin, 1)}
            isDisabled={isDisabled || massSelection.coinCounts[coin] >= maximumCoinsPerKind}
          />
        </View>
      ))}
      <View style={styles.coinRow}>
        <BodyText style={styles.coinLabel}>{t('coins.extraGrams')}</BodyText>
        <TextInput
          value={massSelection.extraGramsText}
          onChangeText={(extraGramsText) => onChange({ ...massSelection, extraGramsText })}
          editable={!isDisabled}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor={themePalette.textSecondary}
          accessibilityLabel={t('coins.extraGrams')}
          style={[styles.gramsInput, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
        />
      </View>
    </View>
  );
}

function StepperButton({
  label,
  accessibilityLabel,
  onPress,
  isDisabled,
}: {
  label: string;
  accessibilityLabel: string;
  onPress(): void;
  isDisabled: boolean;
}) {
  const themePalette = useThemePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.stepperButton,
        { borderColor: themePalette.accent, opacity: isDisabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}>
      <BodyText tone="accent" style={styles.stepperLabel}>
        {label}
      </BodyText>
    </Pressable>
  );
}

/** Barra de progreso y aviso de no tocar mientras vibra, o el error de la última medida. */
export function MeasurementStatus({
  measurementState,
  onCancel,
}: {
  measurementState: PulseMeasurementState;
  onCancel(): void;
}) {
  const { t } = useTranslation(resonanceScaleInstrumentId);
  const themePalette = useThemePalette();
  if (measurementState.status === 'measuring') {
    return (
      <Card>
        <BodyText tone="accent" style={styles.emphasis}>
          {t('measuring', { seconds: measurementDurationSeconds })}
        </BodyText>
        <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
          <View
            style={[
              styles.progressFill,
              { backgroundColor: themePalette.accent, width: `${Math.round(measurementState.progress * 100)}%` },
            ]}
          />
        </View>
        <AppButton label={t('core:common.cancel')} onPress={onCancel} variant="secondary" />
      </Card>
    );
  }
  if (measurementState.status === 'error') {
    return <BodyText tone="danger">{t(`failures.${measurementState.failure}`)}</BodyText>;
  }
  return null;
}

/** Espectro medio de los pulsos: el pico es el motor (o su alias si pasa de la mitad del muestreo). */
export function PulseSpectrum({ analysis, revision }: { analysis: PulseResponseAnalysis; revision: number }) {
  const { t } = useTranslation(resonanceScaleInstrumentId);
  const themePalette = useThemePalette();
  if (analysis.spectrumAmplitudes.length === 0) return null;
  const nyquistHz = Math.round(analysis.sampleRateHz / 2);
  return (
    <SignalChart
      series={[{ values: analysis.spectrumAmplitudes, color: themePalette.accent }]}
      height={120}
      verticalRange={{ mode: 'from-zero', minimumMaximum: 0.05 }}
      revision={revision}
      unitLabel="m/s²"
      horizontalLabels={['0 Hz', `${nyquistHz} Hz`]}
      accessibilityLabel={t('spectrumChart')}
    />
  );
}

const styles = StyleSheet.create({
  selectorColumn: { gap: 8 },
  coinRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  coinLabel: { flex: 1 },
  coinCount: { minWidth: 28, textAlign: 'center', fontVariant: ['tabular-nums'], fontWeight: '600' },
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperLabel: { fontSize: 22, lineHeight: 26, fontWeight: '600' },
  gramsInput: { width: 90, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15 },
  emphasis: { fontWeight: '600' },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4 },
});
