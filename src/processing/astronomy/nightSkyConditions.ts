/**
 * ¿Es buena noche para fotografiar estrellas? Oscuridad (altura del Sol) y estorbo de la Luna
 * (sobre el horizonte y cuánto iluminada), a partir de las efemérides de `moonEphemeris`.
 *
 * Módulo puro: sin React ni React Native.
 */
import {
  eclipticToEquatorial,
  equatorialToHorizontal,
  julianDayFromDate,
  moonHorizontalPosition,
  moonIlluminatedFraction,
  type ObserverLocation,
  sunEclipticPosition,
} from './moonEphemeris';

/**
 * Por la altura del Sol: día (> −0,833°, con refracción y semidiámetro), crepúsculo civil (> −6°),
 * náutico (> −12°), astronómico (> −18°) y noche cerrada.
 */
export type SkyDarkness = 'day' | 'civilTwilight' | 'nauticalTwilight' | 'astronomicalTwilight' | 'night';

/** Cuánto aclara la Luna el cielo: nada (bajo el horizonte) hasta mucho (casi llena y alta). */
export type MoonInterference = 'none' | 'low' | 'moderate' | 'strong';

export interface NightSkyConditions {
  /** Solo con la ubicación del observador. */
  sunAltitudeDegrees: number | null;
  darkness: SkyDarkness | null;
  moonIlluminatedFraction: number;
  /** Solo con la ubicación del observador. */
  moonAltitudeDegrees: number | null;
  moonInterference: MoonInterference;
}

export function skyDarknessForSunAltitude(sunAltitudeDegrees: number): SkyDarkness {
  if (sunAltitudeDegrees > -0.833) return 'day';
  if (sunAltitudeDegrees > -6) return 'civilTwilight';
  if (sunAltitudeDegrees > -12) return 'nauticalTwilight';
  if (sunAltitudeDegrees > -18) return 'astronomicalTwilight';
  return 'night';
}

/**
 * Estorbo de la Luna. Bajo el horizonte no molesta; encima, según la fracción iluminada (el
 * brillo de la Luna crece mucho más deprisa que la fase: la llena es ~10 veces el cuarto).
 * Sin altura (sin ubicación), se supone que está encima.
 */
export function moonInterferenceFor(illuminatedFraction: number, moonAltitudeDegrees: number | null): MoonInterference {
  if (moonAltitudeDegrees !== null && moonAltitudeDegrees < -1) return 'none';
  if (illuminatedFraction < 0.25) return 'low';
  if (illuminatedFraction < 0.6) return 'moderate';
  return 'strong';
}

export function sunAltitudeDegrees(observerLocation: ObserverLocation, julianDay: number): number {
  return equatorialToHorizontal(eclipticToEquatorial(sunEclipticPosition(julianDay), julianDay), observerLocation, julianDay)
    .altitudeDegrees;
}

export function assessNightSky(date: Date, observerLocation: ObserverLocation | null): NightSkyConditions {
  const julianDay = julianDayFromDate(date);
  const illuminatedFraction = moonIlluminatedFraction(julianDay);
  const sunAltitude = observerLocation ? sunAltitudeDegrees(observerLocation, julianDay) : null;
  const moonAltitude = observerLocation ? moonHorizontalPosition(observerLocation, julianDay).altitudeDegrees : null;
  return {
    sunAltitudeDegrees: sunAltitude,
    darkness: sunAltitude === null ? null : skyDarknessForSunAltitude(sunAltitude),
    moonIlluminatedFraction: illuminatedFraction,
    moonAltitudeDegrees: moonAltitude,
    moonInterference: moonInterferenceFor(illuminatedFraction, moonAltitude),
  };
}
