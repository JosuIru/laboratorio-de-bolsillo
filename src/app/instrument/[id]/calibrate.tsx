import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';

import { createActiveCalibrationProfile, listCalibrationProfiles } from '@/core/calibration/calibrationService';
import { getDeviceFingerprint } from '@/core/calibration/deviceFingerprint';
import { sqliteCalibrationRepository } from '@/core/calibration/sqliteCalibrationRepository';
import type { CalibrationProfile } from '@/core/calibration/types';
import { findInstrument } from '@/core/instruments/registryAccess';
import { AppButton, BodyText, Card, LoadingState, ScreenContainer } from '@/ui/components';

export default function CalibrationManagerScreen() {
  const { id: instrumentId } = useLocalSearchParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const instrument = findInstrument(instrumentId);
  const [calibrationProfiles, setCalibrationProfiles] = useState<CalibrationProfile[] | null>(null);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const reloadProfiles = useCallback(async () => {
    if (!instrument) return;
    try {
      setCalibrationProfiles(await listCalibrationProfiles(instrument));
      setErrorMessage(null);
    } catch (loadError) {
      setErrorMessage(String(loadError));
    }
  }, [instrument]);

  useFocusEffect(
    useCallback(() => {
      void reloadProfiles();
    }, [reloadProfiles]),
  );

  if (!instrument) {
    return (
      <ScreenContainer>
        <BodyText>{t('instrument.notFound')}</BodyText>
      </ScreenContainer>
    );
  }

  const screenOptions = (
    <Stack.Screen
      options={{ title: t('calibration.title', { instrument: t(instrument.nameKey, { ns: instrument.id }) }) }}
    />
  );
  const calibrationDefinition = instrument.calibration;

  if (!calibrationDefinition) {
    return (
      <ScreenContainer>
        {screenOptions}
        <BodyText>{t('calibration.notSupported')}</BodyText>
      </ScreenContainer>
    );
  }
  if (!calibrationProfiles) {
    return (
      <>
        {screenOptions}
        <LoadingState label={t('common.loading')} />
      </>
    );
  }

  const CalibrationScreen = calibrationDefinition.CalibrationScreen;
  const activeProfile = calibrationProfiles.find((profile) => profile.isActive) ?? null;

  function confirmDelete(profile: CalibrationProfile) {
    Alert.alert(t('calibration.deleteTitle'), profile.name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          await sqliteCalibrationRepository.remove(profile.id);
          await reloadProfiles();
        },
      },
    ]);
  }

  return (
    <ScreenContainer>
      {screenOptions}
      <BodyText tone="secondary">{t('calibration.deviceNote', { device: getDeviceFingerprint() })}</BodyText>
      {errorMessage ? <BodyText tone="danger">{t('common.error', { message: errorMessage })}</BodyText> : null}

      {isCreatingProfile ? (
        <CalibrationScreen
          instrumentId={instrument.id}
          activeProfile={activeProfile}
          saveProfile={async (profileName, parameters) => {
            try {
              await createActiveCalibrationProfile(instrument, profileName, parameters);
              setIsCreatingProfile(false);
              await reloadProfiles();
            } catch (saveError) {
              setErrorMessage(String(saveError));
            }
          }}
          cancel={() => setIsCreatingProfile(false)}
        />
      ) : (
        <AppButton label={t('calibration.newProfile')} onPress={() => setIsCreatingProfile(true)} />
      )}

      {calibrationProfiles.length === 0 ? <BodyText tone="secondary">{t('calibration.noProfiles')}</BodyText> : null}

      {calibrationProfiles.map((profile) => (
        <Card key={profile.id}>
          <BodyText style={styles.profileName}>
            {profile.name}
            {profile.isActive ? ` · ${t('calibration.active')}` : ''}
          </BodyText>
          <BodyText tone="secondary">{new Date(profile.createdAt).toLocaleString(i18n.language)}</BodyText>
          <View style={styles.profileActions}>
            {!profile.isActive ? (
              <AppButton
                label={t('calibration.activate')}
                variant="secondary"
                onPress={async () => {
                  await sqliteCalibrationRepository.setActive(profile.id);
                  await reloadProfiles();
                }}
              />
            ) : null}
            <AppButton label={t('common.delete')} variant="danger" onPress={() => confirmDelete(profile)} />
          </View>
        </Card>
      ))}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  profileName: { fontWeight: '600' },
  profileActions: { flexDirection: 'row', gap: 8 },
});
