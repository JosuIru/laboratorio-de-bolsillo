/**
 * «Antes de fotografiar»: altura de la Luna y mejor hora de esta noche, balance de blancos,
 * horquilla de enfoque («Afinar el enfoque») y ráfaga RAW experimental.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { assessMoonAltitude, findBestMoonTimeTonight } from '@/processing/astronomy/moonAltitudeAdvice';
import type { MoonReport, ObserverLocation } from '@/processing/astronomy/moonEphemeris';
import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';

import { moonInstrumentId } from './instrumentId';
import { ToggleChip } from './MoonScreenParts';
import type { useFocusBracketing } from './useFocusBracketing';
import type { WhiteBalanceStatus } from './useDaylightWhiteBalance';

/** Inicio de la ventana de «esta noche»: el mediodía de hoy, o el de ayer si aún es de madrugada. */
function startOfTonightWindow(now: Date): Date {
  const noonToday = new Date(now);
  noonToday.setHours(12, 0, 0, 0);
  if (now.getTime() >= noonToday.getTime()) return noonToday;
  return new Date(noonToday.getTime() - 24 * 3600 * 1000);
}

/** Hora actual, al minuto (para no leer el reloj durante el render). */
function useMinuteClock(): number {
  const [currentTimeMilliseconds, setCurrentTimeMilliseconds] = useState(() => Date.now());
  useEffect(() => {
    const clockTimer = setInterval(() => setCurrentTimeMilliseconds(Date.now()), 60_000);
    return () => clearInterval(clockTimer);
  }, []);
  return currentTimeMilliseconds;
}

interface MoonCaptureAssistantProps {
  moonReport: MoonReport;
  observerLocation: ObserverLocation | null;
  focusBracketing: ReturnType<typeof useFocusBracketing>;
  whiteBalanceStatus: WhiteBalanceStatus;
  isRawAvailable: boolean;
  isRawEnabled: boolean;
  onToggleRaw(): void;
  canRunFocusBracketing: boolean;
  onRunFocusBracketing(): void;
}

export function MoonCaptureAssistant({
  moonReport,
  observerLocation,
  focusBracketing,
  whiteBalanceStatus,
  isRawAvailable,
  isRawEnabled,
  onToggleRaw,
  canRunFocusBracketing,
  onRunFocusBracketing,
}: MoonCaptureAssistantProps) {
  const { t, i18n } = useTranslation(moonInstrumentId);
  const altitudeDegrees = moonReport.horizontalPosition?.altitudeDegrees;
  const altitudeAssessment = altitudeDegrees === undefined ? null : assessMoonAltitude(altitudeDegrees);
  const currentTimeMilliseconds = useMinuteClock();
  // La mejor hora cambia poco: se recalcula cuando cambia la ubicación o la hora (en punto).
  const currentHourKey = Math.floor(currentTimeMilliseconds / 3_600_000);
  const bestMoonTime = useMemo(() => {
    if (!observerLocation) return undefined;
    const now = new Date(currentHourKey * 3_600_000);
    return findBestMoonTimeTonight(observerLocation, startOfTonightWindow(now));
  }, [observerLocation, currentHourKey]);
  const formatTime = (date: Date) => date.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  const focusProgress = focusBracketing.progress;

  return (
    <Card>
      <SectionTitle>{t('assistant.title')}</SectionTitle>
      {altitudeAssessment ? (
        <>
          <BodyText tone={altitudeAssessment.quality === 'poor' || altitudeAssessment.quality === 'belowHorizon' ? 'danger' : 'secondary'}>
            {t(`assistant.altitudeQuality.${altitudeAssessment.quality}`, { altitude: Math.round(altitudeAssessment.altitudeDegrees) })}
          </BodyText>
          {altitudeAssessment.warnings.map((warning) => (
            <BodyText key={warning} tone="secondary">
              {t(`assistant.altitudeWarnings.${warning}`, {
                extinction: Number.isFinite(altitudeAssessment.extinctionMagnitudes) ? altitudeAssessment.extinctionMagnitudes.toFixed(1) : '—',
              })}
            </BodyText>
          ))}
        </>
      ) : (
        <BodyText tone="secondary">{t('assistant.altitudeNeedsLocation')}</BodyText>
      )}
      {bestMoonTime === null ? <BodyText tone="secondary">{t('assistant.noDarkMoonTonight')}</BodyText> : null}
      {bestMoonTime ? (
        <BodyText tone="secondary">
          {t(bestMoonTime.bestDate.getTime() < currentTimeMilliseconds ? 'assistant.bestTimePassed' : 'assistant.bestTime', {
            time: formatTime(bestMoonTime.bestDate),
            altitude: Math.round(bestMoonTime.altitudeDegrees),
          })}
        </BodyText>
      ) : null}

      <BodyText tone="secondary">{t(`assistant.whiteBalance.${whiteBalanceStatus}`)}</BodyText>

      {focusBracketing.isSupported ? (
        <>
          {focusProgress ? (
            <View style={styles.row}>
              <View style={styles.cell}>
                <BodyText>
                  {t('assistant.focusProgress', {
                    series: focusProgress.seriesNumber,
                    measured: focusProgress.measuredCount,
                    position: focusProgress.lensPosition.toFixed(3),
                  })}
                </BodyText>
              </View>
              <View style={styles.cell}>
                <AppButton label={t('stopCapture')} onPress={focusBracketing.stopFocusBracketing} variant="secondary" />
              </View>
            </View>
          ) : (
            <AppButton label={t('assistant.focusButton')} onPress={onRunFocusBracketing} isDisabled={!canRunFocusBracketing} variant="secondary" />
          )}
          {focusBracketing.bestLensPosition !== null && !focusProgress ? (
            <View style={styles.row}>
              <View style={styles.cell}>
                <BodyText tone="secondary">
                  {t(focusBracketing.lastOutcome?.hasConverged === false ? 'assistant.focusResultRough' : 'assistant.focusResult', {
                    position: focusBracketing.bestLensPosition.toFixed(3),
                    count: focusBracketing.lastOutcome?.measurements.length ?? 0,
                  })}
                </BodyText>
              </View>
              <View style={styles.cell}>
                <AppButton label={t('assistant.focusForget')} onPress={focusBracketing.forgetBestFocus} variant="secondary" />
              </View>
            </View>
          ) : null}
          <BodyText tone="secondary">{t('assistant.focusExplanation')}</BodyText>
        </>
      ) : (
        <BodyText tone="secondary">{t('assistant.focusUnsupported')}</BodyText>
      )}

      {isRawAvailable ? (
        <>
          <ToggleChip label={t('assistant.rawToggle')} isOn={isRawEnabled} onToggle={onToggleRaw} />
          {isRawEnabled ? <BodyText tone="secondary">{t('assistant.rawExplanation')}</BodyText> : null}
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cell: { flex: 1 },
});
