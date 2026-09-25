import '@/core/i18n';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';

import { useThemePalette } from '@/ui/theme';

export default function RootLayout() {
  const { t } = useTranslation();
  const themePalette = useThemePalette();

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
      </Stack>
    </>
  );
}
