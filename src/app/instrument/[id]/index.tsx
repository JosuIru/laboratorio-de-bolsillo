import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useResolvedCalibration } from '@/core/calibration/useResolvedCalibration';
import { evaluateInstrumentReadiness } from '@/core/instruments/availability';
import { findInstrument } from '@/core/instruments/registryAccess';
import { saveMeasurementDraft } from '@/core/measurements/measurementService';
import type { MeasurementDraft } from '@/core/measurements/types';
import { useSensorAvailabilityStore } from '@/core/sensors/availabilityStore';
import { BodyText, LoadingState, ScreenContainer } from '@/ui/components';
import { InstrumentCard } from '@/ui/InstrumentCard';

export default function InstrumentHostScreen() {
  const { id: instrumentId } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const instrument = findInstrument(instrumentId);
  const availabilityBySensor = useSensorAvailabilityStore((state) => state.availabilityBySensor);
  const requestSensorPermission = useSensorAvailabilityStore((state) => state.requestSensorPermission);
  const calibrationLoadState = useResolvedCalibration(instrument);
  const activeCalibrationProfile =
    calibrationLoadState.status === 'ready' ? calibrationLoadState.resolvedCalibration.activeProfile : null;

  const saveMeasurement = useCallback(
    (draft: MeasurementDraft) => {
      if (!instrument) throw new Error('Instrumento desconocido');
      return saveMeasurementDraft(draft, {
        instrument,
        ...(activeCalibrationProfile ? { calibrationProfileId: activeCalibrationProfile.id } : {}),
      });
    },
    [instrument, activeCalibrationProfile],
  );

  if (!instrument) {
    return (
      <ScreenContainer>
        <BodyText>{t('instrument.notFound')}</BodyText>
      </ScreenContainer>
    );
  }

  const instrumentName = t(instrument.nameKey, { ns: instrument.id });
  const screenOptions = (
    <Stack.Screen
      options={{
        title: instrumentName,
        headerRight: () => (
          <View style={styles.headerActions}>
            {instrument.calibration ? (
              <HeaderLink
                label={t('instrument.calibrate')}
                onPress={() =>
                  router.push({ pathname: '/instrument/[id]/calibrate', params: { id: instrument.id } })
                }
              />
            ) : null}
            <HeaderLink
              label={t('instrument.history')}
              onPress={() => router.push({ pathname: '/instrument/[id]/history', params: { id: instrument.id } })}
            />
          </View>
        ),
      }}
    />
  );

  if (!availabilityBySensor || calibrationLoadState.status === 'loading') {
    return (
      <>
        {screenOptions}
        <LoadingState label={t('common.loading')} />
      </>
    );
  }

  if (calibrationLoadState.status === 'error') {
    return (
      <>
        {screenOptions}
        <ScreenContainer>
          <BodyText tone="danger">{t('common.error', { message: calibrationLoadState.errorMessage })}</BodyText>
        </ScreenContainer>
      </>
    );
  }

  const readiness = evaluateInstrumentReadiness(instrument, availabilityBySensor);
  if (readiness.status !== 'ready') {
    return (
      <>
        {screenOptions}
        <ScreenContainer>
          <InstrumentCard
            instrument={instrument}
            readiness={readiness}
            onOpen={() => undefined}
            onRequestPermissions={async () => {
              if (readiness.status !== 'needs-permission') return;
              for (const sensorKind of readiness.sensorsNeedingPermission) await requestSensorPermission(sensorKind);
            }}
          />
        </ScreenContainer>
      </>
    );
  }

  const InstrumentScreen = instrument.Screen;
  return (
    <>
      {screenOptions}
      <InstrumentScreen
        instrumentId={instrument.id}
        calibrationParameters={calibrationLoadState.resolvedCalibration.parameters}
        activeCalibrationProfile={activeCalibrationProfile}
        saveMeasurement={saveMeasurement}
        sensorAvailability={availabilityBySensor}
      />
    </>
  );
}

function HeaderLink({ label, onPress }: { label: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      <BodyText tone="accent">{label}</BodyText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', gap: 16 },
});
