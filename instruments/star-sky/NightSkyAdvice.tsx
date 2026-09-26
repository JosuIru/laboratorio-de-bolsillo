import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { getLocationForMeasurement } from '@/core/sensors/adapters/location';
import { useSensorAvailabilityStore } from '@/core/sensors/availabilityStore';
import type { SensorAvailability } from '@/core/sensors/types';
import type { ObserverLocation } from '@/processing/astronomy/moonEphemeris';
import { assessNightSky } from '@/processing/astronomy/nightSkyConditions';
import { AppButton, BodyText, Card } from '@/ui/components';

import { starSkyInstrumentId } from './instrumentId';

const tipKeys = ['tripod', 'noMoon', 'darkPlace', 'darkAdaptation', 'exposureLimit', 'batteryAndDew'] as const;

async function readObserverLocation(): Promise<ObserverLocation | null> {
  const geoLocation = await getLocationForMeasurement({ maxAgeMilliseconds: 30 * 60_000, timeoutMilliseconds: 10_000 });
  return geoLocation ? { latitudeDegrees: geoLocation.latitude, longitudeDegrees: geoLocation.longitude } : null;
}

/** Se lee sola si ya hay permiso de ubicación; `requestLocation` lo pide. */
function useSkyObserverLocation(locationAvailability: SensorAvailability | undefined) {
  const requestSensorPermission = useSensorAvailabilityStore((storeState) => storeState.requestSensorPermission);
  const [observerLocation, setObserverLocation] = useState<ObserverLocation | null>(null);
  const [isRequestingLocation, setIsRequestingLocation] = useState(false);
  const hasLocationPermission = locationAvailability?.status === 'available';

  useEffect(() => {
    if (!hasLocationPermission) return;
    let isCancelled = false;
    void readObserverLocation().then((geoLocation) => {
      if (!isCancelled && geoLocation) setObserverLocation(geoLocation);
    });
    return () => {
      isCancelled = true;
    };
  }, [hasLocationPermission]);

  async function requestLocation() {
    setIsRequestingLocation(true);
    try {
      const updatedAvailability = await requestSensorPermission('location');
      if (updatedAvailability.status !== 'available') return;
      const geoLocation = await readObserverLocation();
      if (geoLocation) setObserverLocation(geoLocation);
    } finally {
      setIsRequestingLocation(false);
    }
  }

  return { observerLocation, isRequestingLocation, requestLocation };
}

/** Cómo está el cielo ahora (Sol y Luna) y consejos para fotografiar estrellas. */
export function NightSkyAdvice({ locationAvailability }: { locationAvailability: SensorAvailability | undefined }) {
  const { t } = useTranslation(starSkyInstrumentId);
  const { observerLocation, isRequestingLocation, requestLocation } = useSkyObserverLocation(locationAvailability);
  // Se calcula al abrir y cuando llega la ubicación (unos minutos de diferencia no cambian el consejo).
  const [assessmentDate] = useState(() => new Date());
  const conditions = useMemo(() => assessNightSky(assessmentDate, observerLocation), [assessmentDate, observerLocation]);

  const illuminatedPercent = Math.round(conditions.moonIlluminatedFraction * 100);
  let moonText: string;
  if (conditions.moonAltitudeDegrees === null) {
    moonText = t('conditions.moonPhaseOnly', { percent: illuminatedPercent });
  } else if (conditions.moonAltitudeDegrees < 0) {
    moonText = t('conditions.moonBelowHorizon', { percent: illuminatedPercent });
  } else {
    moonText = t('conditions.moonAboveHorizon', {
      percent: illuminatedPercent,
      altitude: Math.round(conditions.moonAltitudeDegrees),
    });
  }

  return (
    <Card style={styles.card}>
      <BodyText style={styles.title}>{t('conditions.title')}</BodyText>
      {conditions.darkness ? (
        <BodyText tone={conditions.darkness === 'night' ? 'secondary' : 'danger'}>{t(`conditions.darkness.${conditions.darkness}`)}</BodyText>
      ) : null}
      <BodyText tone="secondary">{moonText}</BodyText>
      <BodyText tone={conditions.moonInterference === 'strong' ? 'danger' : 'secondary'}>
        {t(`conditions.moonInterference.${conditions.moonInterference}`)}
      </BodyText>
      {!observerLocation ? (
        <View style={styles.locationRow}>
          <BodyText tone="secondary" style={styles.flexText}>
            {t('conditions.locationHint')}
          </BodyText>
          <View style={styles.locationButton}>
            <AppButton label={t('conditions.useLocation')} onPress={() => void requestLocation()} isBusy={isRequestingLocation} variant="secondary" />
          </View>
        </View>
      ) : null}
      <BodyText style={styles.title}>{t('tips.title')}</BodyText>
      {tipKeys.map((tipKey) => (
        <BodyText key={tipKey} tone="secondary" style={styles.smallText}>
          {`• ${t(`tips.${tipKey}`)}`}
        </BodyText>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6 },
  title: { fontWeight: '600' },
  smallText: { fontSize: 13 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flexText: { flex: 1 },
  locationButton: { width: 130 },
});
