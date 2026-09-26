import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { formatIdealRange, type StripPadReading, type StripReading } from './stripEngine';
import { poolStripsInstrumentId, stripParameters } from './stripPresets';

interface StripReadingCardProps {
  stripReading: StripReading | null;
  isFrozen: boolean;
  /** Segundos desde que se mojó la tira cuando se fijó la lectura (null si no se usó la cuenta atrás). */
  frozenAtSeconds: number | null;
  onFreeze(): void;
  onUnfreeze(): void;
}

/** Resultado de cada almohadilla: valor, rango recomendado, confianza del color y consejo. */
export function StripReadingCard({ stripReading, isFrozen, frozenAtSeconds, onFreeze, onUnfreeze }: StripReadingCardProps) {
  const { t } = useTranslation(poolStripsInstrumentId);
  const usesDefaultScale = stripReading?.padReadings.some((padReading) => !padReading.isScaleCalibrated) ?? false;

  return (
    <Card>
      <BodyText style={styles.title}>{t('reading.title')}</BodyText>
      {isFrozen ? (
        <BodyText tone="accent">
          {frozenAtSeconds !== null
            ? t('reading.frozenAt', { seconds: Math.round(frozenAtSeconds) })
            : t('reading.frozen')}
        </BodyText>
      ) : null}
      {!stripReading ? (
        <BodyText tone="secondary">{t('reading.waiting')}</BodyText>
      ) : (
        stripReading.padReadings.map((padReading) => <PadResultRow key={padReading.slotIndex} padReading={padReading} />)
      )}
      {usesDefaultScale ? <BodyText tone="secondary">{t('reading.orientativeNotice')}</BodyText> : null}
      {isFrozen ? (
        <AppButton label={t('reading.live')} variant="secondary" onPress={onUnfreeze} />
      ) : (
        <AppButton label={t('reading.freeze')} variant="secondary" onPress={onFreeze} isDisabled={!stripReading} />
      )}
    </Card>
  );
}

function PadResultRow({ padReading }: { padReading: StripPadReading }) {
  const { t, i18n } = useTranslation(poolStripsInstrumentId);
  const themePalette = useThemePalette();
  const parameter = stripParameters[padReading.parameterId];
  const numberFormatter = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: parameter.displayFractionDigits,
    maximumFractionDigits: parameter.displayFractionDigits,
  });
  const rangeFormatter = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });
  const parameterName = t(`quantities.${parameter.quantity}`);
  const valueText = `≈ ${numberFormatter.format(padReading.estimatedValue)}${parameter.unit ? ` ${parameter.unit}` : ''}`;
  // Si el color no se parece a la escala, el valor no es fiable: ni «bien» ni «alto», ni consejo
  // químico (podría recomendar tratar el agua por una lectura errónea).
  const isReliable = padReading.confidence !== 'poor';
  const statusColor = !isReliable
    ? themePalette.textSecondary
    : padReading.rangeStatus === 'ideal'
      ? themePalette.success
      : themePalette.danger;
  const statusText = isReliable ? t(`status.${padReading.rangeStatus}`) : t('status.uncertain');
  const rangeText = t('reading.idealRange', {
    range: `${formatIdealRange(parameter.idealRange, (rangeValue) => rangeFormatter.format(rangeValue))}${
      parameter.unit ? ` ${parameter.unit}` : ''
    }`,
  });
  const confidenceText = t('reading.confidence', {
    deltaE: padReading.interpolationDeltaE.toFixed(1),
    confidence: t(`confidence.${padReading.confidence}`),
  });
  const scaleText = padReading.isScaleCalibrated ? t('reading.calibratedScale') : t('reading.defaultScale');

  return (
    <View
      accessible
      accessibilityLabel={`${padReading.slotIndex + 1}. ${parameterName}: ${valueText}, ${statusText}. ${rangeText}. ${confidenceText}.`}
      style={[styles.padRow, { borderColor: themePalette.border }]}>
      <View
        style={[
          styles.padSwatch,
          { backgroundColor: padReading.colorReading.correctedSampleHex, borderColor: themePalette.border },
        ]}
      />
      <View style={styles.padDetails}>
        <View style={styles.padHeader}>
          <BodyText style={styles.padName}>{`${padReading.slotIndex + 1} · ${parameterName}`}</BodyText>
          <View style={[styles.statusPill, { borderColor: statusColor }]}>
            <BodyText style={{ ...styles.statusText, color: statusColor }}>{statusText}</BodyText>
          </View>
        </View>
        <BodyText style={styles.padValue}>{valueText}</BodyText>
        <BodyText tone="secondary">{rangeText}</BodyText>
        <BodyText tone={padReading.confidence === 'poor' ? 'danger' : 'secondary'}>{`${confidenceText} · ${scaleText}`}</BodyText>
        {!padReading.colorReading.isSampleUniform ? <BodyText tone="danger">{t('reading.nonUniform')}</BodyText> : null}
        {!isReliable ? (
          <BodyText tone="danger">{t('reading.unreliableAdvice')}</BodyText>
        ) : padReading.rangeStatus !== 'ideal' ? (
          <BodyText tone="secondary">{t(`advice.${padReading.parameterId}.${padReading.rangeStatus}`)}</BodyText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontWeight: '600' },
  padRow: { flexDirection: 'row', gap: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  padSwatch: { width: 40, height: 40, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  padDetails: { flex: 1, gap: 2 },
  padHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  padName: { flex: 1, fontWeight: '600' },
  statusPill: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 2 },
  statusText: { fontSize: 13, fontWeight: '700' },
  padValue: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
