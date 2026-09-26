import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { useIsScreenActive } from '@/core/useIsScreenActive';
import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import type { TiltAngles } from '@/processing/signal/orientation';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { parseDecimalInput } from '@/ui/decimalInput';
import { useThemePalette } from '@/ui/theme';

import {
  applyZeroOffset,
  computeFourWheelLifts,
  computeSingleAxleLeveling,
  isVehicleLevel,
  levelToleranceDegrees,
  type VehicleLayout,
  vehicleTiltFromPhoneTilt,
  zeroOffsetFromInversion,
} from './levelingGeometry';
import { rvLevelerInstrumentId } from './rvLevelerInstrumentId';
import type { RvLevelerMeasurementValues } from './schema';
import { useAveragedTilt } from './useAveragedTilt';
import { roundedCentimeters, VehicleDiagram } from './VehicleDiagram';
import {
  defaultVehicleSettings,
  isValidDimension,
  loadVehicleSettings,
  maximumDimensionCentimeters,
  minimumDimensionCentimeters,
  saveVehicleSettings,
  type VehicleSettings,
} from './vehicleSettingsStorage';

/** Si las lecturas de la ventana varían más que esto, el vehículo se está moviendo. */
const steadinessThresholdDegrees = 0.5;
/** Altura de un calzo de rampa habitual: por encima se avisa. */
const typicalRampMaximumCentimeters = 12;
const vehicleLayoutOptions: readonly VehicleLayout[] = ['fourWheels', 'singleAxle'];

type ZeroCalibrationStep =
  | { stepName: 'idle' }
  | { stepName: 'waitingFirstReading' }
  | { stepName: 'waitingRotatedReading'; firstReading: TiltAngles };

type DimensionKey = 'trackWidthCentimeters' | 'wheelbaseCentimeters' | 'jockeyDistanceCentimeters';

function lateralDirectionText(t: TFunction, lateralTiltDegrees: number): string {
  if (Math.abs(lateralTiltDegrees) < levelToleranceDegrees) return t('direction.level');
  return lateralTiltDegrees > 0 ? t('direction.rightHigher') : t('direction.leftHigher');
}

function longitudinalDirectionText(t: TFunction, longitudinalTiltDegrees: number): string {
  if (Math.abs(longitudinalTiltDegrees) < levelToleranceDegrees) return t('direction.level');
  return longitudinalTiltDegrees > 0 ? t('direction.frontHigher') : t('direction.rearHigher');
}

export function RvLevelerScreen({ saveMeasurement }: InstrumentScreenProps<RvLevelerMeasurementValues>) {
  const { t } = useTranslation(rvLevelerInstrumentId);
  const themePalette = useThemePalette();
  const averagedTilt = useAveragedTilt();
  const isScreenActive = useIsScreenActive();
  // Mientras se calza el vehículo el móvil queda en el suelo: la pantalla no debe apagarse.
  useKeepScreenOnWhile(isScreenActive, rvLevelerInstrumentId);

  const [vehicleSettings, setVehicleSettings] = useState<VehicleSettings>(loadVehicleSettings);
  const [dimensionTexts, setDimensionTexts] = useState<Record<DimensionKey, string>>(() => ({
    trackWidthCentimeters: String(vehicleSettings.trackWidthCentimeters),
    wheelbaseCentimeters: String(vehicleSettings.wheelbaseCentimeters),
    jockeyDistanceCentimeters: String(vehicleSettings.jockeyDistanceCentimeters),
  }));
  const [zeroCalibrationStep, setZeroCalibrationStep] = useState<ZeroCalibrationStep>({ stepName: 'idle' });
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Se recuerdan las medidas y el cero para la próxima vez.
  useEffect(() => {
    saveVehicleSettings(vehicleSettings);
  }, [vehicleSettings]);

  function handleDimensionChange(dimensionKey: DimensionKey, dimensionText: string) {
    setDimensionTexts((previousTexts) => ({ ...previousTexts, [dimensionKey]: dimensionText }));
    const dimensionCentimeters = parseDecimalInput(dimensionText);
    if (isValidDimension(dimensionCentimeters)) {
      setVehicleSettings((previousSettings) => ({ ...previousSettings, [dimensionKey]: dimensionCentimeters }));
    }
  }

  const isSteady =
    averagedTilt !== null && averagedTilt.spreadDegrees < steadinessThresholdDegrees;

  function handleZeroReading() {
    if (!averagedTilt || !isSteady) return;
    if (zeroCalibrationStep.stepName === 'waitingFirstReading') {
      setZeroCalibrationStep({ stepName: 'waitingRotatedReading', firstReading: averagedTilt.meanTilt });
      return;
    }
    if (zeroCalibrationStep.stepName === 'waitingRotatedReading') {
      const zeroOffset = zeroOffsetFromInversion(zeroCalibrationStep.firstReading, averagedTilt.meanTilt);
      setVehicleSettings((previousSettings) => ({ ...previousSettings, zeroOffset }));
      setZeroCalibrationStep({ stepName: 'idle' });
      setStatusMessage(t('zero.saved'));
    }
  }

  if (!averagedTilt) {
    return (
      <ScreenContainer>
        <BodyText tone="secondary">{t('waiting')}</BodyText>
      </ScreenContainer>
    );
  }

  const vehicleTilt = vehicleTiltFromPhoneTilt(applyZeroOffset(averagedTilt.meanTilt, vehicleSettings.zeroOffset));
  const isLevel = isVehicleLevel(vehicleTilt);
  const isFourWheels = vehicleSettings.vehicleLayout === 'fourWheels';
  const wheelLifts = computeFourWheelLifts(
    vehicleTilt,
    vehicleSettings.trackWidthCentimeters,
    vehicleSettings.wheelbaseCentimeters,
  );
  const singleAxleLeveling = computeSingleAxleLeveling(
    vehicleTilt,
    vehicleSettings.trackWidthCentimeters,
    vehicleSettings.jockeyDistanceCentimeters,
  );
  const largestWheelLiftCentimeters = isFourWheels
    ? Math.max(
        wheelLifts.frontLeftLiftCentimeters,
        wheelLifts.frontRightLiftCentimeters,
        wheelLifts.rearLeftLiftCentimeters,
        wheelLifts.rearRightLiftCentimeters,
      )
    : Math.max(singleAxleLeveling.leftWheelLiftCentimeters, singleAxleLeveling.rightWheelLiftCentimeters);
  const hasZeroOffset = vehicleSettings.zeroOffset.tiltXDegrees !== 0 || vehicleSettings.zeroOffset.tiltYDegrees !== 0;

  async function handleSave() {
    setIsSaving(true);
    setStatusMessage(null);
    const commonValues = {
      vehicleLayout: vehicleSettings.vehicleLayout,
      lateralTiltDegrees: vehicleTilt.lateralTiltDegrees,
      longitudinalTiltDegrees: vehicleTilt.longitudinalTiltDegrees,
      isLevel,
      trackWidthCentimeters: vehicleSettings.trackWidthCentimeters,
    };
    const measurementValues: RvLevelerMeasurementValues = isFourWheels
      ? {
          ...commonValues,
          wheelbaseCentimeters: vehicleSettings.wheelbaseCentimeters,
          frontLeftLiftCentimeters: wheelLifts.frontLeftLiftCentimeters,
          frontRightLiftCentimeters: wheelLifts.frontRightLiftCentimeters,
          rearLeftLiftCentimeters: wheelLifts.rearLeftLiftCentimeters,
          rearRightLiftCentimeters: wheelLifts.rearRightLiftCentimeters,
        }
      : {
          ...commonValues,
          jockeyDistanceCentimeters: vehicleSettings.jockeyDistanceCentimeters,
          leftWheelLiftCentimeters: singleAxleLeveling.leftWheelLiftCentimeters,
          rightWheelLiftCentimeters: singleAxleLeveling.rightWheelLiftCentimeters,
          jockeyWheelChangeCentimeters: singleAxleLeveling.jockeyWheelChangeCentimeters,
        };
    try {
      await saveMeasurement({ values: measurementValues });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const inputStyle = [styles.textInput, { color: themePalette.textPrimary, borderColor: themePalette.border }];
  const visibleDimensionKeys: DimensionKey[] = isFourWheels
    ? ['trackWidthCentimeters', 'wheelbaseCentimeters']
    : ['trackWidthCentimeters', 'jockeyDistanceCentimeters'];

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('instructions')}</BodyText>

      <Card style={styles.statusCard}>
        <BodyText style={{ ...styles.statusText, color: isLevel ? themePalette.success : themePalette.textPrimary }}>
          {isLevel ? t('status.level') : t('status.notLevel')}
        </BodyText>
        <View style={styles.readingsRow}>
          <View style={styles.reading}>
            <BodyText tone="secondary">{t('fields.lateralTilt')}</BodyText>
            <BodyText style={styles.readingValue}>{`${vehicleTilt.lateralTiltDegrees.toFixed(1)}°`}</BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {lateralDirectionText(t, vehicleTilt.lateralTiltDegrees)}
            </BodyText>
          </View>
          <View style={styles.reading}>
            <BodyText tone="secondary">{t('fields.longitudinalTilt')}</BodyText>
            <BodyText style={styles.readingValue}>{`${vehicleTilt.longitudinalTiltDegrees.toFixed(1)}°`}</BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {longitudinalDirectionText(t, vehicleTilt.longitudinalTiltDegrees)}
            </BodyText>
          </View>
        </View>
        {!isSteady ? <BodyText tone="danger">{t('status.moving')}</BodyText> : null}
      </Card>

      <Card>
        {isFourWheels ? (
          <VehicleDiagram vehicleLayout="fourWheels" wheelLifts={wheelLifts} />
        ) : (
          <VehicleDiagram vehicleLayout="singleAxle" singleAxleLeveling={singleAxleLeveling} />
        )}
        {isFourWheels ? (
          <>
            <BodyText>
              {t('axles.front', { centimeters: roundedCentimeters(wheelLifts.frontAxleLiftCentimeters) })}
            </BodyText>
            <BodyText>{t('axles.rear', { centimeters: roundedCentimeters(wheelLifts.rearAxleLiftCentimeters) })}</BodyText>
          </>
        ) : null}
        <BodyText tone="secondary" style={styles.smallText}>
          {isFourWheels ? t('diagram.fourWheelsHelp') : t('diagram.singleAxleHelp')}
        </BodyText>
        {largestWheelLiftCentimeters > typicalRampMaximumCentimeters ? (
          <BodyText tone="danger">{t('tooHigh', { centimeters: typicalRampMaximumCentimeters })}</BodyText>
        ) : null}
      </Card>

      <AppButton label={t('core:common.save')} onPress={handleSave} isBusy={isSaving} />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <Card>
        <SectionTitle>{t('vehicle.title')}</SectionTitle>
        <View style={styles.segmentedRow}>
          {vehicleLayoutOptions.map((vehicleLayoutOption) => {
            const isSelected = vehicleLayoutOption === vehicleSettings.vehicleLayout;
            return (
              <Pressable
                key={vehicleLayoutOption}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() =>
                  setVehicleSettings((previousSettings) => ({ ...previousSettings, vehicleLayout: vehicleLayoutOption }))
                }
                style={[styles.segment, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
                <BodyText tone={isSelected ? 'accent' : 'primary'}>{t(`vehicle.layouts.${vehicleLayoutOption}`)}</BodyText>
              </Pressable>
            );
          })}
        </View>
        {visibleDimensionKeys.map((dimensionKey) => {
          const isDimensionValid = isValidDimension(parseDecimalInput(dimensionTexts[dimensionKey]));
          return (
            <View key={dimensionKey} style={styles.dimensionBlock}>
              <View style={styles.dimensionRow}>
                <BodyText style={styles.dimensionLabel}>{t(`vehicle.${dimensionKey}`)}</BodyText>
                <TextInput
                  value={dimensionTexts[dimensionKey]}
                  onChangeText={(dimensionText) => handleDimensionChange(dimensionKey, dimensionText)}
                  keyboardType="decimal-pad"
                  accessibilityLabel={t(`vehicle.${dimensionKey}`)}
                  placeholder={String(defaultVehicleSettings[dimensionKey])}
                  placeholderTextColor={themePalette.textSecondary}
                  style={inputStyle}
                />
                <BodyText>cm</BodyText>
              </View>
              {!isDimensionValid ? (
                <BodyText tone="danger" style={styles.smallText}>
                  {t('vehicle.invalidDimension', {
                    minimum: minimumDimensionCentimeters,
                    maximum: maximumDimensionCentimeters,
                  })}
                </BodyText>
              ) : null}
            </View>
          );
        })}
        <BodyText tone="secondary" style={styles.smallText}>
          {isFourWheels ? t('vehicle.fourWheelsHelp') : t('vehicle.singleAxleHelp')}
        </BodyText>
      </Card>

      <Card>
        <SectionTitle>{t('zero.title')}</SectionTitle>
        <BodyText tone="secondary">
          {hasZeroOffset
            ? t('zero.current', {
                tiltX: vehicleSettings.zeroOffset.tiltXDegrees.toFixed(2),
                tiltY: vehicleSettings.zeroOffset.tiltYDegrees.toFixed(2),
              })
            : t('zero.none')}
        </BodyText>
        {zeroCalibrationStep.stepName === 'idle' ? (
          <>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('zero.explanation')}
            </BodyText>
            <AppButton
              label={t('zero.start')}
              onPress={() => setZeroCalibrationStep({ stepName: 'waitingFirstReading' })}
              variant="secondary"
            />
            {hasZeroOffset ? (
              <AppButton
                label={t('zero.clear')}
                onPress={() =>
                  setVehicleSettings((previousSettings) => ({
                    ...previousSettings,
                    zeroOffset: defaultVehicleSettings.zeroOffset,
                  }))
                }
                variant="danger"
              />
            ) : null}
          </>
        ) : (
          <>
            <BodyText>
              {zeroCalibrationStep.stepName === 'waitingFirstReading' ? t('zero.firstStep') : t('zero.secondStep')}
            </BodyText>
            {!isSteady ? <BodyText tone="danger">{t('status.moving')}</BodyText> : null}
            <AppButton label={t('zero.measure')} onPress={handleZeroReading} isDisabled={!isSteady} />
            <AppButton
              label={t('core:common.cancel')}
              onPress={() => setZeroCalibrationStep({ stepName: 'idle' })}
              variant="secondary"
            />
          </>
        )}
      </Card>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  statusCard: { alignItems: 'center' },
  statusText: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  readingsRow: { flexDirection: 'row', justifyContent: 'space-around', alignSelf: 'stretch' },
  reading: { alignItems: 'center', gap: 2, flex: 1 },
  readingValue: { fontSize: 32, lineHeight: 40, fontWeight: '600', fontVariant: ['tabular-nums'] },
  smallText: { fontSize: 13, lineHeight: 18 },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  dimensionBlock: { gap: 2 },
  dimensionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dimensionLabel: { flex: 1 },
  textInput: { minWidth: 80, borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 16 },
});
