import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { getLocationForMeasurement } from '@/core/sensors/adapters/location';
import { useSensorAvailabilityStore } from '@/core/sensors/availabilityStore';
import type { SensorAvailability } from '@/core/sensors/types';
import {
  compassPointIndex,
  computeMoonReport,
  type MoonPhaseName,
  type MoonReport,
  type ObserverLocation,
} from '@/processing/astronomy/moonEphemeris';
import { AppButton, BodyText, Card } from '@/ui/components';

import { moonInstrumentId } from './instrumentId';

/** Cada cuánto se recalcula la posición de la Luna (se mueve ~0,25° por minuto en el cielo). */
const reportRefreshIntervalMilliseconds = 60_000;

const phaseGlyphs: Record<MoonPhaseName, string> = {
  newMoon: '🌑',
  waxingCrescent: '🌒',
  firstQuarter: '🌓',
  waxingGibbous: '🌔',
  fullMoon: '🌕',
  waningGibbous: '🌖',
  lastQuarter: '🌗',
  waningCrescent: '🌘',
};

/**
 * Ubicación del observador: se lee sola si ya hay permiso; si no, `requestLocation` lo pide.
 */
export function useObserverLocation(locationAvailability: SensorAvailability | undefined) {
  const requestSensorPermission = useSensorAvailabilityStore((storeState) => storeState.requestSensorPermission);
  const [observerLocation, setObserverLocation] = useState<ObserverLocation | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const hasLocationPermission = locationAvailability?.status === 'available';

  async function readLocation() {
    setIsLocating(true);
    const geoLocation = await getLocationForMeasurement({ maxAgeMilliseconds: 10 * 60_000, timeoutMilliseconds: 10_000 });
    setIsLocating(false);
    if (geoLocation) {
      setObserverLocation({ latitudeDegrees: geoLocation.latitude, longitudeDegrees: geoLocation.longitude });
    }
  }

  useEffect(() => {
    if (hasLocationPermission) void readLocation();
  }, [hasLocationPermission]);

  async function requestLocation() {
    const updatedAvailability = await requestSensorPermission('location');
    if (updatedAvailability.status === 'available') await readLocation();
  }

  return { observerLocation, isLocating, requestLocation, canAskForLocation: locationAvailability?.canAskAgain !== false };
}

/** Informe de la Luna recalculado cada minuto. */
export function useMoonReport(observerLocation: ObserverLocation | null): MoonReport {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    const refreshTimer = setInterval(() => setCurrentTime(Date.now()), reportRefreshIntervalMilliseconds);
    return () => clearInterval(refreshTimer);
  }, []);
  return useMemo(
    () => computeMoonReport(new Date(currentTime), observerLocation ?? undefined),
    [currentTime, observerLocation],
  );
}

interface MoonInfoCardProps {
  moonReport: MoonReport;
  hasObserverLocation: boolean;
  isLocating: boolean;
  canAskForLocation: boolean;
  onRequestLocation(): void;
}

export function MoonInfoCard({
  moonReport,
  hasObserverLocation,
  isLocating,
  canAskForLocation,
  onRequestLocation,
}: MoonInfoCardProps) {
  const { t, i18n } = useTranslation(moonInstrumentId);
  const formatDateTime = (date: Date) =>
    date.toLocaleString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const formatTime = (date: Date | null | undefined) =>
    date ? date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) : t('noEventIn48Hours');
  const compassPointNames = t('compassPoints').split(',');
  const horizontalPosition = moonReport.horizontalPosition;
  const upcomingPhases = [
    { labelKey: 'phase.newMoon', date: moonReport.nextNewMoon },
    { labelKey: 'phase.firstQuarter', date: moonReport.nextFirstQuarter },
    { labelKey: 'phase.fullMoon', date: moonReport.nextFullMoon },
    { labelKey: 'phase.lastQuarter', date: moonReport.nextLastQuarter },
  ].sort((firstPhase, secondPhase) => firstPhase.date.getTime() - secondPhase.date.getTime());

  return (
    <Card>
      <View style={styles.headerRow}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <BodyText style={styles.phaseGlyph}>{phaseGlyphs[moonReport.phaseName]}</BodyText>
        </View>
        <View style={styles.headerText}>
          <BodyText style={styles.phaseName}>{t(`phase.${moonReport.phaseName}`)}</BodyText>
          <BodyText tone="secondary">
            {t('illuminationSummary', {
              percent: (moonReport.illuminatedFraction * 100).toFixed(0),
              trend: t(moonReport.isWaxing ? 'waxing' : 'waning'),
              age: moonReport.ageDays.toFixed(1),
            })}
          </BodyText>
        </View>
      </View>

      <BodyText>
        {t('distanceSummary', {
          distance: Math.round(moonReport.distanceKilometers).toLocaleString(i18n.language),
          diameter: moonReport.apparentDiameterArcminutes.toFixed(1),
        })}
      </BodyText>

      {horizontalPosition ? (
        <>
          <BodyText tone={horizontalPosition.altitudeDegrees < 0 ? 'danger' : 'primary'}>
            {horizontalPosition.altitudeDegrees < 0
              ? t('belowHorizon', { altitude: horizontalPosition.altitudeDegrees.toFixed(0) })
              : t('skyPosition', {
                  altitude: horizontalPosition.altitudeDegrees.toFixed(0),
                  azimuth: horizontalPosition.azimuthDegrees.toFixed(0),
                  compassPoint: compassPointNames[compassPointIndex(horizontalPosition.azimuthDegrees)],
                })}
          </BodyText>
          <BodyText tone="secondary">
            {t('riseAndSet', { rise: formatTime(moonReport.nextRise), set: formatTime(moonReport.nextSet) })}
          </BodyText>
        </>
      ) : hasObserverLocation ? null : (
        <View style={styles.locationPrompt}>
          <BodyText tone="secondary">{t('locationExplanation')}</BodyText>
          {canAskForLocation ? (
            <AppButton label={t('useMyLocation')} onPress={onRequestLocation} isBusy={isLocating} variant="secondary" />
          ) : null}
        </View>
      )}

      <View style={styles.upcomingPhases}>
        {upcomingPhases.map((upcomingPhase) => (
          <BodyText key={upcomingPhase.labelKey} tone="secondary">
            {`${t(upcomingPhase.labelKey)}: ${formatDateTime(upcomingPhase.date)}`}
          </BodyText>
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  phaseGlyph: { fontSize: 44, lineHeight: 52 },
  headerText: { flex: 1, gap: 2 },
  phaseName: { fontSize: 20, fontWeight: '700' },
  locationPrompt: { gap: 8 },
  upcomingPhases: { gap: 2, marginTop: 4 },
});
