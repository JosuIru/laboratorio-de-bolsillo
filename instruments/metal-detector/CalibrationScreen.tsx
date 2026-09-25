import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput } from 'react-native';

import type { CalibrationScreenProps } from '@/core/calibration/types';
import { magnetometerSource } from '@/core/sensors/adapters/motionAndEnvironment';
import { useSensorSubscription } from '@/core/sensors/useSensorSubscription';
import {
  createHardIronEstimator,
  type HardIronEstimate,
  isHardIronCoverageSufficient,
  minimumCalibrationAxisRangeMicroteslas,
} from '@/processing/magnetics/magneticField';
import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { MetalDetectorCalibrationParameters } from './calibration';
import { metalDetectorInstrumentId } from './instrumentId';

const collectionDurationSeconds = 10;
const progressIntervalMilliseconds = 200;

/**
 * Calibración hard-iron: se gira el móvil en ocho durante unos segundos y se guarda el centro
 * de las lecturas por eje, que es el campo magnético del propio móvil.
 */
export function MetalDetectorCalibrationScreen({ saveProfile, cancel }: CalibrationScreenProps<MetalDetectorCalibrationParameters>) {
  const { t } = useTranslation(metalDetectorInstrumentId);
  const themePalette = useThemePalette();
  const [hardIronEstimator] = useState(createHardIronEstimator);
  const [isCollecting, setIsCollecting] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [hardIronEstimate, setHardIronEstimate] = useState<HardIronEstimate | null>(null);
  const [profileName, setProfileName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useSensorSubscription(
    magnetometerSource,
    ({ value }) => hardIronEstimator.push(value),
    { isActive: isCollecting, targetRateHz: 100 },
  );

  useEffect(() => {
    if (!isCollecting) return;
    const startedAt = Date.now();
    const progressTimer = setInterval(() => {
      const collectedSeconds = (Date.now() - startedAt) / 1000;
      setElapsedSeconds(collectedSeconds);
      setHardIronEstimate(hardIronEstimator.estimate());
      if (collectedSeconds >= collectionDurationSeconds) setIsCollecting(false);
    }, progressIntervalMilliseconds);
    return () => clearInterval(progressTimer);
  }, [isCollecting, hardIronEstimator]);

  function handleStart() {
    hardIronEstimator.reset();
    setHardIronEstimate(null);
    setElapsedSeconds(0);
    setIsCollecting(true);
  }

  const hasEnoughCoverage = hardIronEstimate !== null && isHardIronCoverageSufficient(hardIronEstimate);
  const isFinished = !isCollecting && hardIronEstimate !== null;

  async function handleSave() {
    if (!hardIronEstimate || !hasEnoughCoverage) return;
    setIsSaving(true);
    try {
      const { offsetX, offsetY, offsetZ } = hardIronEstimate.hardIronOffset;
      await saveProfile(profileName, {
        offsetX: Math.round(offsetX * 100) / 100,
        offsetY: Math.round(offsetY * 100) / 100,
        offsetZ: Math.round(offsetZ * 100) / 100,
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card>
      <BodyText>{t('calibration.instructions', { seconds: collectionDurationSeconds })}</BodyText>
      {isCollecting ? (
        <BodyText tone="accent">
          {t('calibration.collecting', { seconds: Math.max(0, Math.ceil(collectionDurationSeconds - elapsedSeconds)) })}
        </BodyText>
      ) : null}
      {hardIronEstimate ? (
        <BodyText tone="secondary">
          {t('calibration.axisRanges', {
            rangeX: Math.round(hardIronEstimate.axisRanges.x),
            rangeY: Math.round(hardIronEstimate.axisRanges.y),
            rangeZ: Math.round(hardIronEstimate.axisRanges.z),
            minimum: minimumCalibrationAxisRangeMicroteslas,
          })}
        </BodyText>
      ) : null}
      {isFinished && !hasEnoughCoverage ? <BodyText tone="danger">{t('calibration.notEnoughRotation')}</BodyText> : null}
      {isFinished && hasEnoughCoverage ? (
        <BodyText tone="secondary">
          {t('calibration.result', {
            offsetX: hardIronEstimate.hardIronOffset.offsetX.toFixed(1),
            offsetY: hardIronEstimate.hardIronOffset.offsetY.toFixed(1),
            offsetZ: hardIronEstimate.hardIronOffset.offsetZ.toFixed(1),
          })}
        </BodyText>
      ) : null}
      <AppButton
        label={isFinished ? t('calibration.repeat') : t('calibration.start')}
        onPress={handleStart}
        isDisabled={isCollecting}
        variant={isFinished ? 'secondary' : 'primary'}
      />
      <TextInput
        value={profileName}
        onChangeText={setProfileName}
        placeholder={t('core:calibration.profileName')}
        placeholderTextColor={themePalette.textSecondary}
        style={[styles.nameInput, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
      />
      <AppButton
        label={t('core:common.save')}
        onPress={() => void handleSave()}
        isBusy={isSaving}
        isDisabled={!isFinished || !hasEnoughCoverage}
      />
      <AppButton label={t('core:common.cancel')} onPress={cancel} variant="secondary" />
    </Card>
  );
}

const styles = StyleSheet.create({
  nameInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
