import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { CalibrationScreenProps } from '@/core/calibration/types';
import {
  amplitudeChangePercentPerTenGrams,
  type CalibrationPoint,
  fitCalibration,
  minimumCalibrationMassSpanGrams,
  minimumCalibrationPointCount,
  relativeAmplitudeSpread,
  responseMeasurementFromAnalysis,
} from '@/processing/resonanceScale/massCalibration';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { ResonanceScaleCalibrationParameters } from './calibration';
import { emptyMassSelection, type MassSelection, MassSelector, MeasurementStatus, selectedMassGrams } from './components';
import { formatGrams, irregularPulseSpreadThreshold } from './formatting';
import { resonanceScaleInstrumentId } from './instrumentId';
import { usePulseMeasurement } from './usePulseMeasurement';

/**
 * Calibración: se mide la respuesta con el móvil vacío y con dos o más masas conocidas
 * (monedas) sobre la misma superficie, y se ajusta la recta rasgo-masa.
 */
export function ResonanceScaleCalibrationScreen({
  activeProfile,
  saveProfile,
  cancel,
}: CalibrationScreenProps<ResonanceScaleCalibrationParameters>) {
  const { t } = useTranslation(resonanceScaleInstrumentId);
  const themePalette = useThemePalette();
  const [calibrationPoints, setCalibrationPoints] = useState<CalibrationPoint[]>([]);
  const [massSelection, setMassSelection] = useState<MassSelection>(emptyMassSelection);
  const [pendingMassGrams, setPendingMassGrams] = useState<number | null>(null);
  const [lastPointSpread, setLastPointSpread] = useState<number | null>(null);
  const [profileName, setProfileName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const { measurementState, startMeasurement, cancelMeasurement } = usePulseMeasurement({
    onMeasured: (analysis) => {
      if (pendingMassGrams === null) return;
      const responseMeasurement = responseMeasurementFromAnalysis(analysis);
      setCalibrationPoints((previousPoints) => [...previousPoints, { massGrams: pendingMassGrams, ...responseMeasurement }]);
      setLastPointSpread(relativeAmplitudeSpread(responseMeasurement));
      setPendingMassGrams(null);
    },
  });
  const isMeasuring = measurementState.status === 'measuring';
  const massToMeasure = selectedMassGrams(massSelection);
  const { bestModel } = fitCalibration(calibrationPoints);
  const distinctMassCount = new Set(calibrationPoints.map((point) => point.massGrams)).size;
  const hasEmptyPoint = calibrationPoints.some((point) => point.massGrams === 0);

  function handleMeasure() {
    if (massToMeasure === null) return;
    setPendingMassGrams(massToMeasure);
    setLastPointSpread(null);
    startMeasurement();
  }

  async function handleSave() {
    if (!bestModel) return;
    setIsSaving(true);
    try {
      await saveProfile(profileName, { model: bestModel, points: calibrationPoints });
    } finally {
      setIsSaving(false);
    }
  }

  const sensitivityPercent = bestModel ? amplitudeChangePercentPerTenGrams(bestModel) : null;

  return (
    <View style={styles.column}>
      <Card>
        <BodyText>{t('calibration.instructions')}</BodyText>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('calibration.plan')}
        </BodyText>
        {activeProfile ? (
          <BodyText tone="secondary" style={styles.smallText}>
            {t('calibration.replacesActive', { name: activeProfile.name })}
          </BodyText>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>{t('calibration.whatIsOnTop')}</SectionTitle>
        <MassSelector massSelection={massSelection} onChange={setMassSelection} isDisabled={isMeasuring} />
        <AppButton
          label={
            massToMeasure === null
              ? t('calibration.invalidMass')
              : massToMeasure === 0
                ? t('calibration.measureEmpty')
                : t('calibration.measureWith', { grams: formatGrams(massToMeasure) })
          }
          onPress={handleMeasure}
          isDisabled={isMeasuring || massToMeasure === null}
        />
      </Card>

      <MeasurementStatus measurementState={measurementState} onCancel={cancelMeasurement} />
      {lastPointSpread !== null && lastPointSpread > irregularPulseSpreadThreshold ? (
        <BodyText tone="danger">{t('irregularPulses', { percent: Math.round(lastPointSpread * 100) })}</BodyText>
      ) : null}

      {calibrationPoints.length > 0 ? (
        <Card>
          <SectionTitle>{t('calibration.points')}</SectionTitle>
          {calibrationPoints.map((point, pointIndex) => (
            <View key={pointIndex} style={styles.pointRow}>
              <BodyText style={styles.pointText}>
                {t('calibration.pointSummary', {
                  grams: formatGrams(point.massGrams),
                  amplitude: point.amplitudeRms.toFixed(3),
                  frequency: point.peakFrequencyHz === null ? '—' : point.peakFrequencyHz.toFixed(1),
                })}
              </BodyText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('calibration.removePoint')}
                disabled={isMeasuring}
                onPress={() =>
                  setCalibrationPoints((previousPoints) =>
                    previousPoints.filter((_, candidateIndex) => candidateIndex !== pointIndex),
                  )
                }
                style={styles.removeButton}>
                <BodyText tone="danger">✕</BodyText>
              </Pressable>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        {bestModel ? (
          <>
            <BodyText tone="accent" style={styles.emphasis}>
              {t(`calibration.model.${bestModel.feature}`)}
            </BodyText>
            {bestModel.crossValidationErrorGrams !== null ? (
              <BodyText>
                {t('calibration.crossValidation', { grams: formatGrams(bestModel.crossValidationErrorGrams) })}
              </BodyText>
            ) : null}
            {sensitivityPercent !== null ? (
              <BodyText tone="secondary">
                {t('calibration.sensitivity', { percent: Math.abs(sensitivityPercent).toFixed(1) })}
              </BodyText>
            ) : null}
            <BodyText tone="secondary" style={styles.smallText}>
              {t('calibration.range', {
                minimum: formatGrams(bestModel.minimumMassGrams),
                maximum: formatGrams(bestModel.maximumMassGrams),
              })}
            </BodyText>
          </>
        ) : (
          <BodyText tone="secondary">
            {calibrationPoints.length < minimumCalibrationPointCount || distinctMassCount < 2
              ? t('calibration.needMorePoints', { count: minimumCalibrationPointCount })
              : t('calibration.noUsableModel', { span: minimumCalibrationMassSpanGrams })}
          </BodyText>
        )}
        {calibrationPoints.length > 0 && !hasEmptyPoint ? (
          <BodyText tone="secondary" style={styles.smallText}>
            {t('calibration.addEmptyPoint')}
          </BodyText>
        ) : null}
        <TextInput
          value={profileName}
          onChangeText={setProfileName}
          placeholder={t('calibration.profileNameHint')}
          placeholderTextColor={themePalette.textSecondary}
          style={[styles.nameInput, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
        />
        <AppButton
          label={t('core:common.save')}
          onPress={() => void handleSave()}
          isBusy={isSaving}
          isDisabled={!bestModel || isMeasuring}
        />
        <AppButton label={t('core:common.cancel')} onPress={cancel} variant="secondary" />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { gap: 12 },
  smallText: { fontSize: 13 },
  emphasis: { fontWeight: '600' },
  pointRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pointText: { flex: 1, fontVariant: ['tabular-nums'] },
  removeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  nameInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
