/**
 * Consejo según la altura de la Luna: cuánta atmósfera atraviesa su luz, si conviene esperar y
 * cuál es la mejor hora de la noche para fotografiarla (su culminación, si es de noche).
 *
 * Masa de aire (cuántas atmósferas atraviesa la luz; 1 en el cenit): fórmula de Kasten y Young
 * (1989, Applied Optics 28, 4735), válida hasta el horizonte:
 *     X = 1 / (sen h + 0,50572 · (h + 6,07995°)^−1,6364),  h en grados.
 * Con la masa de aire crecen:
 *  - la extinción (la Luna se oscurece: k·X magnitudes, con k ≈ 0,2 en verde a nivel del mar);
 *  - el enrojecimiento (el azul se extingue más que el rojo: la Luna baja sale anaranjada);
 *  - la turbulencia y la dispersión atmosférica (bordes de colores arriba y abajo).
 * Por debajo de ~20–25° el emborronamiento y el tinte ya se notan en una foto con teleobjetivo.
 *
 * Los mensajes van como códigos para que la interfaz los traduzca (es, eu).
 * Módulo puro: sin React ni React Native.
 */

import {
  dateFromJulianDay,
  eclipticToEquatorial,
  equatorialToHorizontal,
  julianDayFromDate,
  moonHorizontalPosition,
  type ObserverLocation,
  sunEclipticPosition,
} from './moonEphemeris';

const degreesToRadians = Math.PI / 180;

/** Coeficientes de extinción típicos (magnitudes por masa de aire) en un sitio a nivel del mar. */
const extinctionCoefficientBlue = 0.3;
const extinctionCoefficientGreen = 0.2;
const extinctionCoefficientRed = 0.12;

/** Umbrales de altura (grados) para el consejo. */
const altitudeThresholds = {
  /** Por debajo, la Luna está muy baja: extinción y turbulencia fuertes. */
  poor: 10,
  /** Por debajo, se nota el emborronamiento y el tinte (el aviso del instrumento). */
  fair: 25,
  /** Por encima, las condiciones son las mejores posibles. */
  excellent: 45,
} as const;

/** Altura del Sol por debajo de la cual se considera noche (fin del crepúsculo civil). */
const nightSunAltitudeDegrees = -6;
/** Paso de la búsqueda de la mejor hora. */
const searchStepMinutes = 5;

/** Masa de aire de Kasten y Young; `Infinity` bajo el horizonte (más de ~−6°). */
export function airMassKastenYoung(altitudeDegrees: number): number {
  if (altitudeDegrees + 6.07995 <= 0) return Number.POSITIVE_INFINITY;
  return 1 / (Math.sin(altitudeDegrees * degreesToRadians) + 0.50572 * (altitudeDegrees + 6.07995) ** -1.6364);
}

export type MoonAltitudeQuality = 'belowHorizon' | 'poor' | 'fair' | 'good' | 'excellent';
export type MoonAltitudeWarning = 'belowHorizon' | 'lowAltitudeBlurAndTint' | 'strongExtinction';

export interface MoonAltitudeAssessment {
  altitudeDegrees: number;
  airMass: number;
  quality: MoonAltitudeQuality;
  warnings: MoonAltitudeWarning[];
  /** Pérdida de brillo en verde, en magnitudes (k·X). */
  extinctionMagnitudes: number;
  /** Enrojecimiento: extinción del azul menos la del rojo, en magnitudes. */
  blueMinusRedExtinctionMagnitudes: number;
}

/** Valoración de la altura de la Luna para fotografiarla. */
export function assessMoonAltitude(altitudeDegrees: number): MoonAltitudeAssessment {
  const airMass = airMassKastenYoung(altitudeDegrees);
  const warnings: MoonAltitudeWarning[] = [];
  let quality: MoonAltitudeQuality;
  if (altitudeDegrees <= 0) {
    quality = 'belowHorizon';
    warnings.push('belowHorizon');
  } else if (altitudeDegrees < altitudeThresholds.poor) {
    quality = 'poor';
    warnings.push('lowAltitudeBlurAndTint', 'strongExtinction');
  } else if (altitudeDegrees < altitudeThresholds.fair) {
    quality = 'fair';
    warnings.push('lowAltitudeBlurAndTint');
  } else if (altitudeDegrees < altitudeThresholds.excellent) {
    quality = 'good';
  } else {
    quality = 'excellent';
  }
  const finiteAirMass = Number.isFinite(airMass) ? airMass : Number.NaN;
  return {
    altitudeDegrees,
    airMass,
    quality,
    warnings,
    extinctionMagnitudes: extinctionCoefficientGreen * finiteAirMass,
    blueMinusRedExtinctionMagnitudes: (extinctionCoefficientBlue - extinctionCoefficientRed) * finiteAirMass,
  };
}

function sunAltitudeDegrees(observer: ObserverLocation, julianDay: number): number {
  return equatorialToHorizontal(eclipticToEquatorial(sunEclipticPosition(julianDay), julianDay), observer, julianDay).altitudeDegrees;
}

export interface BestMoonTime {
  /** Mejor instante: la Luna más alta mientras es de noche. */
  bestDate: Date;
  altitudeDegrees: number;
  azimuthDegrees: number;
  assessment: MoonAltitudeAssessment;
  /** El mejor instante es la culminación (y no el principio o el final de la noche). */
  isCulmination: boolean;
  /** Culminación de la Luna en la ventana, sea de noche o no. */
  culminationDate: Date;
  culminationAltitudeDegrees: number;
}

/** Afina un máximo de la altura de la Luna por sección dorada en [inicio, fin] (días julianos). */
function refineMoonAltitudeMaximum(observer: ObserverLocation, startJulianDay: number, endJulianDay: number): number {
  const inverseGoldenRatio = (Math.sqrt(5) - 1) / 2;
  const negativeAltitude = (julianDay: number) => -moonHorizontalPosition(observer, julianDay).altitudeDegrees;
  let lowerBound = startJulianDay;
  let upperBound = endJulianDay;
  while (upperBound - lowerBound > 10 / 86_400) {
    const innerLower = upperBound - inverseGoldenRatio * (upperBound - lowerBound);
    const innerUpper = lowerBound + inverseGoldenRatio * (upperBound - lowerBound);
    if (negativeAltitude(innerLower) < negativeAltitude(innerUpper)) upperBound = innerUpper;
    else lowerBound = innerLower;
  }
  return (lowerBound + upperBound) / 2;
}

/**
 * Mejor hora para fotografiar la Luna en las 24 h que siguen a `startDate` (p. ej. el
 * mediodía del día de la observación, para cubrir la noche entera): la Luna más alta con el Sol
 * por debajo de −6°. `null` si en esa ventana no coinciden la noche y la Luna sobre el horizonte.
 */
export function findBestMoonTimeTonight(observer: ObserverLocation, startDate: Date, windowHours = 24): BestMoonTime | null {
  const startJulianDay = julianDayFromDate(startDate);
  const stepDays = searchStepMinutes / 1440;
  const stepCount = Math.round((windowHours * 60) / searchStepMinutes);
  const moonAltitudes: number[] = [];
  const isNight: boolean[] = [];
  for (let stepIndex = 0; stepIndex <= stepCount; stepIndex++) {
    const julianDay = startJulianDay + stepIndex * stepDays;
    moonAltitudes.push(moonHorizontalPosition(observer, julianDay).altitudeDegrees);
    isNight.push(sunAltitudeDegrees(observer, julianDay) < nightSunAltitudeDegrees);
  }

  // Culminación en la ventana (máximo interior de la altura), de noche o de día.
  let culminationIndex = 0;
  moonAltitudes.forEach((altitude, stepIndex) => {
    if (altitude > moonAltitudes[culminationIndex]!) culminationIndex = stepIndex;
  });
  const culminationJulianDay =
    culminationIndex > 0 && culminationIndex < stepCount
      ? refineMoonAltitudeMaximum(observer, startJulianDay + (culminationIndex - 1) * stepDays, startJulianDay + (culminationIndex + 1) * stepDays)
      : startJulianDay + culminationIndex * stepDays;

  let bestNightIndex = -1;
  moonAltitudes.forEach((altitude, stepIndex) => {
    if (!isNight[stepIndex] || altitude <= 0) return;
    if (bestNightIndex < 0 || altitude > moonAltitudes[bestNightIndex]!) bestNightIndex = stepIndex;
  });
  if (bestNightIndex < 0) return null;

  // Es culminación si las dos muestras vecinas son de noche y más bajas.
  const isCulmination =
    bestNightIndex > 0 &&
    bestNightIndex < stepCount &&
    isNight[bestNightIndex - 1] === true &&
    isNight[bestNightIndex + 1] === true &&
    moonAltitudes[bestNightIndex - 1]! < moonAltitudes[bestNightIndex]! &&
    moonAltitudes[bestNightIndex + 1]! < moonAltitudes[bestNightIndex]!;
  const bestJulianDay = isCulmination
    ? refineMoonAltitudeMaximum(observer, startJulianDay + (bestNightIndex - 1) * stepDays, startJulianDay + (bestNightIndex + 1) * stepDays)
    : startJulianDay + bestNightIndex * stepDays;
  const bestPosition = moonHorizontalPosition(observer, bestJulianDay);
  return {
    bestDate: dateFromJulianDay(bestJulianDay),
    altitudeDegrees: bestPosition.altitudeDegrees,
    azimuthDegrees: bestPosition.azimuthDegrees,
    assessment: assessMoonAltitude(bestPosition.altitudeDegrees),
    isCulmination,
    culminationDate: dateFromJulianDay(culminationJulianDay),
    culminationAltitudeDegrees: moonHorizontalPosition(observer, culminationJulianDay).altitudeDegrees,
  };
}
