import { Link, router, Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable } from 'react-native';

import { evaluateInstrumentReadiness } from '@/core/instruments/availability';
import { enabledInstruments } from '@/core/instruments/registryAccess';
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
      <SectionTitle>{t('home.title')}</SectionTitle>

      {enabledInstruments.length === 0 ? (
        <Card>
          <BodyText tone="secondary">{t('home.empty')}</BodyText>
        </Card>
      ) : null}

      {enabledInstruments.map((instrument) => {
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

      <Link href="/settings" asChild>
        <Pressable accessibilityRole="button" style={{ paddingVertical: 12, alignSelf: 'flex-start' }}>
          <BodyText tone="accent">{t('settings.title')}</BodyText>
        </Pressable>
      </Link>
    </ScreenContainer>
  );
}
