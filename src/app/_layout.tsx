import '@/core/i18n';
import '@/core/instruments/registryAccess';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState } from 'react-native';

import { useSensorAvailabilityStore } from '@/core/sensors/availabilityStore';
import { removeObsoleteDownloadedApks } from '@/core/updates/apkInstaller';
import { getInstalledVersion } from '@/core/updates/updateChecker';
import { useThemePalette } from '@/ui/theme';

/** Revisa los sensores al abrir la app y al volver a ella (el usuario puede haber cambiado permisos). */
function useSensorAvailabilityRefresh() {
  const refreshAvailability = useSensorAvailabilityStore((state) => state.refreshAvailability);
  useEffect(() => {
    void refreshAvailability();
    const appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') void refreshAvailability();
    });
    return () => appStateSubscription.remove();
  }, [refreshAvailability]);
}

export default function RootLayout() {
  const { t } = useTranslation();
  const themePalette = useThemePalette();
  useSensorAvailabilityRefresh();
  // Tras actualizar, el APK descargado ya no sirve: se borra de la caché al arrancar.
  useEffect(() => removeObsoleteDownloadedApks(getInstalledVersion()), []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: themePalette.surface },
          headerTintColor: themePalette.textPrimary,
          contentStyle: { backgroundColor: themePalette.background },
        }}>
        <Stack.Screen name="index" options={{ title: t('app.name') }} />
        <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
        <Stack.Screen name="my-data" options={{ title: t('myData.title') }} />
      </Stack>
    </>
  );
}
