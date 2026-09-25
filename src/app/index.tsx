import { Link, router, Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { evaluateInstrumentReadiness } from '@/core/instruments/availability';
import { enabledInstrumentSections } from '@/core/instruments/registryAccess';
import { useSensorAvailabilityStore } from '@/core/sensors/availabilityStore';
import { BodyText, Card, LoadingState, ScreenContainer, SectionTitle } from '@/ui/components';
import { InstrumentCard } from '@/ui/InstrumentCard';

export default function HomeScreen() {
  const { t } = useTranslation();
  const availabilityBySensor = useSensorAvailabilityStore((state) => state.availabilityBySensor);
  const requestSensorPermission = useSensorAvailabilityStore((state) => state.requestSensorPermission);

  if (!availabilityBySensor) return <LoadingState label={t('common.loading')} />;

  return (
    <ScreenContainer>
      {/* Con muchos instrumentos, el enlace del final queda lejos: también va en la cabecera. */}
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" asChild>
              <Pressable accessibilityRole="button" hitSlop={12}>
                <BodyText tone="accent">{t('settings.title')}</BodyText>
              </Pressable>
            </Link>
          ),
        }}
      />
      <BodyText tone="secondary">{t('app.tagline')}</BodyText>
      {enabledInstrumentSections.length === 0 ? (
        <Card>
          <BodyText tone="secondary">{t('home.empty')}</BodyText>
        </Card>
      ) : null}

      {enabledInstrumentSections.map((section) => (
        <View key={section.id} style={{ gap: 12, marginTop: 12 }}>
          <SectionTitle>{t(`home.sections.${section.id}.title`)}</SectionTitle>
          <BodyText tone="secondary">{t(`home.sections.${section.id}.description`)}</BodyText>
          {section.instruments.map((instrument) => {
            const readiness = evaluateInstrumentReadiness(instrument, availabilityBySensor);
            return (
              <InstrumentCard
                key={instrument.id}
                instrument={instrument}
                readiness={readiness}
                onOpen={() => router.push({ pathname: '/instrument/[id]', params: { id: instrument.id } })}
                onRequestPermissions={async () => {
                  if (readiness.status !== 'needs-permission') return;
                  for (const sensorKind of readiness.sensorsNeedingPermission) {
                    await requestSensorPermission(sensorKind);
                  }
                }}
              />
            );
          })}
        </View>
      ))}

      <Link href="/settings" asChild>
        <Pressable accessibilityRole="button" style={{ paddingVertical: 12, alignSelf: 'flex-start' }}>
          <BodyText tone="accent">{t('settings.title')}</BodyText>
        </Pressable>
      </Link>
    </ScreenContainer>
  );
}
