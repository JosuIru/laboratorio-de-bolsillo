import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { type SupportedLocale, supportedLocales } from '@/core/i18n';
import { useSensorAvailabilityStore } from '@/core/sensors/availabilityStore';
import { allSensorKinds } from '@/core/sensors/types';
import { useAppSettingsStore } from '@/core/settings/settingsStore';
import { BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { describeSensorAvailability, sensorDisplayName } from '@/ui/sensorText';
import { useThemePalette } from '@/ui/theme';

export default function SettingsScreen() {
  const { t } = useTranslation();
  const themePalette = useThemePalette();
  const preferredLocale = useAppSettingsStore((state) => state.preferredLocale);
  const setPreferredLocale = useAppSettingsStore((state) => state.setPreferredLocale);
  const attachLocationToMeasurements = useAppSettingsStore((state) => state.attachLocationToMeasurements);
  const setAttachLocationToMeasurements = useAppSettingsStore((state) => state.setAttachLocationToMeasurements);
  const availabilityBySensor = useSensorAvailabilityStore((state) => state.availabilityBySensor);
  const requestSensorPermission = useSensorAvailabilityStore((state) => state.requestSensorPermission);
  const [locationMessage, setLocationMessage] = useState<string | null>(null);

  const localeOptions: { locale: SupportedLocale | null; label: string }[] = [
    { locale: null, label: t('settings.followSystem') },
    ...supportedLocales.map((locale) => ({ locale, label: t(`language.${locale}`) })),
  ];

  async function handleLocationToggle(isEnabled: boolean) {
    setLocationMessage(null);
    if (!isEnabled) {
      setAttachLocationToMeasurements(false);
      return;
    }
    const locationAvailability = await requestSensorPermission('location');
    if (locationAvailability.status === 'available') {
      setAttachLocationToMeasurements(true);
    } else {
      setLocationMessage(`${t('settings.locationDenied')} ${describeSensorAvailability(t, locationAvailability)}`);
    }
  }

  return (
    <ScreenContainer>
      <SectionTitle>{t('settings.language')}</SectionTitle>
      <View style={styles.localeOptions}>
        {localeOptions.map(({ locale, label }) => {
          const isSelectedLocale = preferredLocale === locale;
          return (
            <Pressable
              key={locale ?? 'system'}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedLocale }}
              onPress={() => setPreferredLocale(locale)}
              style={[
                styles.localeOption,
                {
                  borderColor: isSelectedLocale ? themePalette.accent : themePalette.border,
                  backgroundColor: themePalette.surface,
                },
              ]}>
              <BodyText tone={isSelectedLocale ? 'accent' : 'primary'}>{label}</BodyText>
            </Pressable>
          );
        })}
      </View>

      <SectionTitle>{t('settings.location')}</SectionTitle>
      <Card>
        <View style={styles.switchRow}>
          <BodyText style={styles.switchLabel}>{t('settings.attachLocation')}</BodyText>
          <Switch
            accessibilityLabel={t('settings.attachLocation')}
            value={attachLocationToMeasurements}
            onValueChange={(isEnabled) => void handleLocationToggle(isEnabled)}
          />
        </View>
        <BodyText tone="secondary">{t('settings.attachLocationHint')}</BodyText>
        {locationMessage ? <BodyText tone="danger">{locationMessage}</BodyText> : null}
      </Card>

      <SectionTitle>{t('settings.sensors')}</SectionTitle>
      <Card>
        {availabilityBySensor
          ? allSensorKinds.map((sensorKind) => {
              const availability = availabilityBySensor[sensorKind];
              const isAvailable = availability.status === 'available';
              return (
                <View key={sensorKind} style={styles.sensorRow}>
                  <BodyText style={styles.sensorName}>{sensorDisplayName(t, sensorKind)}</BodyText>
                  <BodyText tone={isAvailable ? 'secondary' : 'danger'} style={styles.sensorStatus}>
                    {isAvailable ? t('sensors.status.available') : describeSensorAvailability(t, availability)}
                  </BodyText>
                </View>
              );
            })
          : null}
      </Card>

      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('settings.privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  localeOptions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  localeOption: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1.5 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  switchLabel: { flex: 1 },
  sensorRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  sensorName: { flexShrink: 0 },
  sensorStatus: { flex: 1, textAlign: 'right' },
  privacyNote: { fontSize: 13, marginTop: 16 },
});
