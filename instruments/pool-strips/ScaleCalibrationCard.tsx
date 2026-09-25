import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';

import { AppButton, BodyText, Card } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import { buildCalibratedScale, type CalibratedStripScales, resolveStripScale } from './stripEngine';
import {
  maximumPadCount,
  poolStripsInstrumentId,
  type StripParameterId,
  stripParameters,
  type StripPresetId,
  stripPresets,
} from './stripPresets';
import { Chip } from './StripSetupCard';

/** Valores de partida para calibrar: los de la escala en uso (calibrada u orientativa). */
export function initialLevelTexts(parameterId: StripParameterId, calibratedScales: CalibratedStripScales): string[] {
  return resolveStripScale(parameterId, calibratedScales).levels.map((level) => String(level.value));
}

interface ScaleCalibrationCardProps {
  presetId: StripPresetId;
  parameterId: StripParameterId;
  onSelectParameter(parameterId: StripParameterId): void;
  /** Un texto por casilla de la guía, en el mismo orden que la fila de la carta. */
  levelValueTexts: string[];
  onLevelValueTextsChange(updatedTexts: string[]): void;
  /** Color corregido medido ahora en cada casilla (null si aún no hay lectura). */
  measuredCellHexColors: (string | null)[] | null;
  calibratedScales: CalibratedStripScales;
  onCalibratedScalesChange(updatedScales: CalibratedStripScales): void;
}

/**
 * Calibrar una escala con la carta del bote: se encuadra una fila de la carta en la guía, se
 * escriben sus valores y se guardan los colores medidos. Sustituye a la escala orientativa.
 */
export function ScaleCalibrationCard({
  presetId,
  parameterId,
  onSelectParameter,
  levelValueTexts,
  onLevelValueTextsChange,
  measuredCellHexColors,
  calibratedScales,
  onCalibratedScalesChange,
}: ScaleCalibrationCardProps) {
  const { t, i18n } = useTranslation(poolStripsInstrumentId);
  const themePalette = useThemePalette();
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const parameterName = t(`quantities.${stripParameters[parameterId].quantity}`);
  const calibratedScale = calibratedScales[parameterId];
  const inputStyle = [styles.levelInput, { color: themePalette.textPrimary, borderColor: themePalette.border }];

  function handleSave() {
    const captureResult = buildCalibratedScale(
      levelValueTexts.map(parseDecimalInput),
      measuredCellHexColors ?? [],
      Date.now(),
    );
    if (typeof captureResult === 'string') {
      setStatusMessage({ text: t(`calibration.problems.${captureResult}`), isError: true });
      return;
    }
    onCalibratedScalesChange({ ...calibratedScales, [parameterId]: captureResult });
    setStatusMessage({ text: t('calibration.saved', { parameter: parameterName }), isError: false });
  }

  function handleResetToDefault() {
    const remainingScales = { ...calibratedScales };
    delete remainingScales[parameterId];
    onCalibratedScalesChange(remainingScales);
    onLevelValueTextsChange(initialLevelTexts(parameterId, remainingScales));
    setStatusMessage(null);
  }

  return (
    <Card>
      <BodyText style={styles.title}>{t('calibration.title')}</BodyText>
      <BodyText tone="secondary">{t('calibration.intro')}</BodyText>
      <View style={styles.chipRow}>
        {stripPresets[presetId].parameterIds.map((candidateParameterId) => (
          <Chip
            key={candidateParameterId}
            label={`${t(`quantities.${stripParameters[candidateParameterId].quantity}`)}${
              calibratedScales[candidateParameterId] ? ' ✓' : ''
            }`}
            isSelected={candidateParameterId === parameterId}
            onPress={() => {
              setStatusMessage(null);
              onSelectParameter(candidateParameterId);
            }}
          />
        ))}
      </View>
      <BodyText tone="secondary">
        {calibratedScale
          ? t('calibration.currentCalibrated', {
              date: new Date(calibratedScale.calibratedAt).toLocaleDateString(i18n.language),
            })
          : t('calibration.currentDefault')}
      </BodyText>

      <BodyText tone="secondary">{t('calibration.levelsHint')}</BodyText>
      <View style={styles.levelRow}>
        {levelValueTexts.map((levelText, levelIndex) => (
          <View key={levelIndex} style={styles.levelColumn}>
            <View
              style={[
                styles.measuredSwatch,
                {
                  borderColor: themePalette.border,
                  backgroundColor: measuredCellHexColors?.[levelIndex] ?? 'transparent',
                },
              ]}
            />
            <TextInput
              value={levelText}
              onChangeText={(changedText) =>
                onLevelValueTextsChange(
                  levelValueTexts.map((candidateText, candidateIndex) => (candidateIndex === levelIndex ? changedText : candidateText)),
                )
              }
              keyboardType="decimal-pad"
              accessibilityLabel={t('calibration.levelLabel', { index: levelIndex + 1 })}
              style={inputStyle}
            />
          </View>
        ))}
      </View>
      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton
            label={t('calibration.addLevel')}
            variant="secondary"
            isDisabled={levelValueTexts.length >= maximumPadCount}
            onPress={() => onLevelValueTextsChange([...levelValueTexts, ''])}
          />
        </View>
        <View style={styles.buttonCell}>
          <AppButton
            label={t('calibration.removeLevel')}
            variant="secondary"
            isDisabled={levelValueTexts.length <= 2}
            onPress={() => onLevelValueTextsChange(levelValueTexts.slice(0, -1))}
          />
        </View>
      </View>
      <AppButton label={t('calibration.save')} onPress={handleSave} isDisabled={!measuredCellHexColors} />
      {statusMessage ? <BodyText tone={statusMessage.isError ? 'danger' : 'secondary'}>{statusMessage.text}</BodyText> : null}
      {calibratedScale ? (
        <AppButton label={t('calibration.resetToDefault')} variant="danger" onPress={handleResetToDefault} />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  levelRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  levelColumn: { alignItems: 'center', gap: 4, width: 64 },
  measuredSwatch: { width: 40, height: 40, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  levelInput: {
    width: 64,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    fontSize: 15,
    textAlign: 'center',
  },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
