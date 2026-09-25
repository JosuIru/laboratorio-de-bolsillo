/**
 * Efemérides de la Luna y del Sol con los algoritmos de Jean Meeus, «Astronomical Algorithms»
 * (2.ª ed., caps. 12, 13, 25, 47 y 48), con las series truncadas a los términos principales.
 *
 * Precisión: unas centésimas de grado en la posición de la Luna y ~1 minuto en las fases.
 * Se ignoran ΔT (≈ 70 s), la nutación y la aberración, que quedan por debajo de ese error.
 * Módulo puro: sin React ni React Native.
 */

const degreesToRadians = Math.PI / 180;
const radiansToDegrees = 180 / Math.PI;
const millisecondsPerDay = 86_400_000;
const julianDayOfUnixEpoch = 2_440_587.5;
const julianDayOfJ2000 = 2_451_545;
const kilometersPerAstronomicalUnit = 149_597_870.7;
const earthEquatorialRadiusKilometers = 6378.14;
const moonRadiusKilometers = 1737.4;

/** Mes sinódico medio (de luna nueva a luna nueva), en días. */
export const synodicMonthDays = 29.530588853;

function normalizeDegrees(angleDegrees: number): number {
  const wrappedAngle = angleDegrees % 360;
  return wrappedAngle < 0 ? wrappedAngle + 360 : wrappedAngle;
}

function sinDegrees(angleDegrees: number): number {
  return Math.sin(angleDegrees * degreesToRadians);
}

function cosDegrees(angleDegrees: number): number {
  return Math.cos(angleDegrees * degreesToRadians);
}

export function julianDayFromDate(date: Date): number {
  return date.getTime() / millisecondsPerDay + julianDayOfUnixEpoch;
}

export function dateFromJulianDay(julianDay: number): Date {
  return new Date((julianDay - julianDayOfUnixEpoch) * millisecondsPerDay);
}

function julianCenturiesSinceJ2000(julianDay: number): number {
  return (julianDay - julianDayOfJ2000) / 36_525;
}

export interface EclipticPosition {
  /** Longitud eclíptica geocéntrica, en grados [0, 360). */
  longitudeDegrees: number;
  /** Latitud eclíptica geocéntrica, en grados. */
  latitudeDegrees: number;
  distanceKilometers: number;
}

/**
 * Términos periódicos de la tabla 47.A: múltiplos de D, M, M', F; coeficiente de la longitud
 * (10⁻⁶ °) y de la distancia (10⁻³ km).
 */
const moonLongitudeAndDistanceTerms: readonly (readonly [number, number, number, number, number, number])[] = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
];

/** Términos de la tabla 47.B: múltiplos de D, M, M', F y coeficiente de la latitud (10⁻⁶ °). */
const moonLatitudeTerms: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
];

/** Posición geocéntrica de la Luna (Meeus, cap. 47). */
export function moonEclipticPosition(julianDay: number): EclipticPosition {
  const centuries = julianCenturiesSinceJ2000(julianDay);
  const centuriesSquared = centuries * centuries;
  const centuriesCubed = centuriesSquared * centuries;
  const centuriesFourth = centuriesCubed * centuries;

  const meanLongitude = normalizeDegrees(
    218.3164477 + 481267.88123421 * centuries - 0.0015786 * centuriesSquared +
      centuriesCubed / 538841 - centuriesFourth / 65194000,
  );
  const meanElongation = normalizeDegrees(
    297.8501921 + 445267.1114034 * centuries - 0.0018819 * centuriesSquared +
      centuriesCubed / 545868 - centuriesFourth / 113065000,
  );
  const sunMeanAnomaly = normalizeDegrees(
    357.5291092 + 35999.0502909 * centuries - 0.0001536 * centuriesSquared + centuriesCubed / 24490000,
  );
  const moonMeanAnomaly = normalizeDegrees(
    134.9633964 + 477198.8675055 * centuries + 0.0087414 * centuriesSquared +
      centuriesCubed / 69699 - centuriesFourth / 14712000,
  );
  const argumentOfLatitude = normalizeDegrees(
    93.272095 + 483202.0175233 * centuries - 0.0036539 * centuriesSquared -
      centuriesCubed / 3526000 + centuriesFourth / 863310000,
  );
  const venusArgument = normalizeDegrees(119.75 + 131.849 * centuries);
  const jupiterArgument = normalizeDegrees(53.09 + 479264.29 * centuries);
  const flatteningArgument = normalizeDegrees(313.45 + 481266.484 * centuries);
  // Corrige los términos con M por la excentricidad decreciente de la órbita terrestre.
  const eccentricityFactor = 1 - 0.002516 * centuries - 0.0000074 * centuriesSquared;
  const eccentricityCorrection = (sunAnomalyMultiple: number) =>
    Math.abs(sunAnomalyMultiple) === 1
      ? eccentricityFactor
      : Math.abs(sunAnomalyMultiple) === 2
        ? eccentricityFactor * eccentricityFactor
        : 1;

  let longitudeSum = 0;
  let distanceSum = 0;
  for (const [elongationMultiple, sunAnomalyMultiple, moonAnomalyMultiple, latitudeMultiple, longitudeCoefficient, distanceCoefficient] of moonLongitudeAndDistanceTerms) {
    const termArgument =
      elongationMultiple * meanElongation +
      sunAnomalyMultiple * sunMeanAnomaly +
      moonAnomalyMultiple * moonMeanAnomaly +
      latitudeMultiple * argumentOfLatitude;
    const correction = eccentricityCorrection(sunAnomalyMultiple);
    longitudeSum += longitudeCoefficient * correction * sinDegrees(termArgument);
    distanceSum += distanceCoefficient * correction * cosDegrees(termArgument);
  }

  let latitudeSum = 0;
  for (const [elongationMultiple, sunAnomalyMultiple, moonAnomalyMultiple, latitudeMultiple, latitudeCoefficient] of moonLatitudeTerms) {
    const termArgument =
      elongationMultiple * meanElongation +
      sunAnomalyMultiple * sunMeanAnomaly +
      moonAnomalyMultiple * moonMeanAnomaly +
      latitudeMultiple * argumentOfLatitude;
    latitudeSum += latitudeCoefficient * eccentricityCorrection(sunAnomalyMultiple) * sinDegrees(termArgument);
  }

  longitudeSum +=
    3958 * sinDegrees(venusArgument) +
    1962 * sinDegrees(meanLongitude - argumentOfLatitude) +
    318 * sinDegrees(jupiterArgument);
  latitudeSum +=
    -2235 * sinDegrees(meanLongitude) +
    382 * sinDegrees(flatteningArgument) +
    175 * sinDegrees(venusArgument - argumentOfLatitude) +
    175 * sinDegrees(venusArgument + argumentOfLatitude) +
    127 * sinDegrees(meanLongitude - moonMeanAnomaly) -
    115 * sinDegrees(meanLongitude + moonMeanAnomaly);

  return {
    longitudeDegrees: normalizeDegrees(meanLongitude + longitudeSum / 1e6),
    latitudeDegrees: latitudeSum / 1e6,
    distanceKilometers: 385000.56 + distanceSum / 1000,
  };
}

/** Posición geocéntrica del Sol, de baja precisión (Meeus, cap. 25): ~0,01°. */
export function sunEclipticPosition(julianDay: number): EclipticPosition {
  const centuries = julianCenturiesSinceJ2000(julianDay);
  const meanLongitude = 280.46646 + 36000.76983 * centuries + 0.0003032 * centuries * centuries;
  const meanAnomaly = 357.52911 + 35999.05029 * centuries - 0.0001537 * centuries * centuries;
  const equationOfCenter =
    (1.914602 - 0.004817 * centuries - 0.000014 * centuries * centuries) * sinDegrees(meanAnomaly) +
    (0.019993 - 0.000101 * centuries) * sinDegrees(2 * meanAnomaly) +
    0.000289 * sinDegrees(3 * meanAnomaly);
  const orbitEccentricity = 0.016708634 - 0.000042037 * centuries;
  const trueAnomaly = meanAnomaly + equationOfCenter;
  const distanceAstronomicalUnits =
    (1.000001018 * (1 - orbitEccentricity * orbitEccentricity)) / (1 + orbitEccentricity * cosDegrees(trueAnomaly));
  return {
    longitudeDegrees: normalizeDegrees(meanLongitude + equationOfCenter),
    latitudeDegrees: 0,
    distanceKilometers: distanceAstronomicalUnits * kilometersPerAstronomicalUnit,
  };
}

/** Oblicuidad media de la eclíptica (Meeus, ec. 22.2). */
function meanObliquityDegrees(julianDay: number): number {
  const centuries = julianCenturiesSinceJ2000(julianDay);
  return 23.439291111 - 0.0130041667 * centuries - 1.639e-7 * centuries * centuries;
}

export interface EquatorialPosition {
  rightAscensionDegrees: number;
  declinationDegrees: number;
}

export function eclipticToEquatorial(eclipticPosition: EclipticPosition, julianDay: number): EquatorialPosition {
  const obliquity = meanObliquityDegrees(julianDay);
  const longitude = eclipticPosition.longitudeDegrees;
  const latitude = eclipticPosition.latitudeDegrees;
  const rightAscension = Math.atan2(
    sinDegrees(longitude) * cosDegrees(obliquity) - Math.tan(latitude * degreesToRadians) * sinDegrees(obliquity),
    cosDegrees(longitude),
  );
  const declination = Math.asin(
    sinDegrees(latitude) * cosDegrees(obliquity) + cosDegrees(latitude) * sinDegrees(obliquity) * sinDegrees(longitude),
  );
  return {
    rightAscensionDegrees: normalizeDegrees(rightAscension * radiansToDegrees),
    declinationDegrees: declination * radiansToDegrees,
  };
}

/** Tiempo sidéreo medio de Greenwich, en grados (Meeus, ec. 12.4). */
export function greenwichMeanSiderealTimeDegrees(julianDay: number): number {
  const centuries = julianCenturiesSinceJ2000(julianDay);
  return normalizeDegrees(
    280.46061837 + 360.98564736629 * (julianDay - julianDayOfJ2000) +
      0.000387933 * centuries * centuries - (centuries * centuries * centuries) / 38710000,
  );
}

export interface ObserverLocation {
  latitudeDegrees: number;
  /** Positiva hacia el este. */
  longitudeDegrees: number;
}

export interface HorizontalPosition {
  /** Acimut desde el norte, hacia el este, en grados [0, 360). */
  azimuthDegrees: number;
  /** Altura sobre el horizonte astronómico, en grados (sin refracción). */
  altitudeDegrees: number;
}

/** Coordenadas horizontales de un astro (Meeus, cap. 13). */
export function equatorialToHorizontal(
  equatorialPosition: EquatorialPosition,
  observerLocation: ObserverLocation,
  julianDay: number,
): HorizontalPosition {
  const localSiderealTime = greenwichMeanSiderealTimeDegrees(julianDay) + observerLocation.longitudeDegrees;
  const hourAngle = localSiderealTime - equatorialPosition.rightAscensionDegrees;
  const observerLatitude = observerLocation.latitudeDegrees;
  const declination = equatorialPosition.declinationDegrees;
  const altitude = Math.asin(
    sinDegrees(observerLatitude) * sinDegrees(declination) +
      cosDegrees(observerLatitude) * cosDegrees(declination) * cosDegrees(hourAngle),
  );
  // Meeus mide el acimut desde el sur; se pasa al convenio habitual (desde el norte).
  const azimuthFromSouth = Math.atan2(
    sinDegrees(hourAngle),
    cosDegrees(hourAngle) * sinDegrees(observerLatitude) - Math.tan(declination * degreesToRadians) * cosDegrees(observerLatitude),
  );
  return {
    azimuthDegrees: normalizeDegrees(azimuthFromSouth * radiansToDegrees + 180),
    altitudeDegrees: altitude * radiansToDegrees,
  };
}

/**
 * Posición de la Luna vista por el observador. Corrige el paralaje (hasta ~1°: la Luna está tan
 * cerca que se ve más baja desde la superficie que desde el centro de la Tierra).
 */
export function moonHorizontalPosition(observerLocation: ObserverLocation, julianDay: number): HorizontalPosition {
  const moonPosition = moonEclipticPosition(julianDay);
  const geocentricPosition = equatorialToHorizontal(
    eclipticToEquatorial(moonPosition, julianDay),
    observerLocation,
    julianDay,
  );
  const horizontalParallaxDegrees =
    Math.asin(earthEquatorialRadiusKilometers / moonPosition.distanceKilometers) * radiansToDegrees;
  return {
    azimuthDegrees: geocentricPosition.azimuthDegrees,
    altitudeDegrees:
      geocentricPosition.altitudeDegrees - horizontalParallaxDegrees * cosDegrees(geocentricPosition.altitudeDegrees),
  };
}

/** Elongación del Sol a la Luna en longitud eclíptica [0, 360): 0 = luna nueva, 180 = llena. */
export function moonPhaseAngleDegrees(julianDay: number): number {
  return normalizeDegrees(
    moonEclipticPosition(julianDay).longitudeDegrees - sunEclipticPosition(julianDay).longitudeDegrees,
  );
}

/** Fracción iluminada del disco lunar, 0-1 (Meeus, cap. 48). */
export function moonIlluminatedFraction(julianDay: number): number {
  const moonPosition = moonEclipticPosition(julianDay);
  const sunPosition = sunEclipticPosition(julianDay);
  const cosineOfElongation =
    cosDegrees(moonPosition.latitudeDegrees) * cosDegrees(moonPosition.longitudeDegrees - sunPosition.longitudeDegrees);
  const geocentricElongation = Math.acos(cosineOfElongation);
  const phaseAngle = Math.atan2(
    sunPosition.distanceKilometers * Math.sin(geocentricElongation),
    moonPosition.distanceKilometers - sunPosition.distanceKilometers * cosineOfElongation,
  );
  return (1 + Math.cos(phaseAngle)) / 2;
}

export type MoonPhaseName =
  | 'newMoon'
  | 'waxingCrescent'
  | 'firstQuarter'
  | 'waxingGibbous'
  | 'fullMoon'
  | 'waningGibbous'
  | 'lastQuarter'
  | 'waningCrescent';

const phaseNamesInOrder: readonly MoonPhaseName[] = [
  'newMoon',
  'waxingCrescent',
  'firstQuarter',
  'waxingGibbous',
  'fullMoon',
  'waningGibbous',
  'lastQuarter',
  'waningCrescent',
];

/** Nombre de la fase: ocho sectores de 45° centrados en las fases principales. */
export function moonPhaseName(phaseAngleDegrees: number): MoonPhaseName {
  return phaseNamesInOrder[Math.floor(normalizeDegrees(phaseAngleDegrees + 22.5) / 45) % 8]!;
}

/** Diferencia angular con signo en (-180, 180]. */
function signedAngleDifference(angleDegrees: number, referenceDegrees: number): number {
  const difference = normalizeDegrees(angleDegrees - referenceDegrees);
  return difference > 180 ? difference - 360 : difference;
}

/**
 * Primer instante a partir de `startJulianDay` en que la elongación alcanza `targetPhaseAngleDegrees`
 * (0 = nueva, 90 = cuarto creciente, 180 = llena, 270 = cuarto menguante). Avanza en pasos de un
 * día (la elongación crece ~12°/día) y afina por bisección hasta ~1 s.
 */
export function findNextMoonPhaseJulianDay(startJulianDay: number, targetPhaseAngleDegrees: number): number {
  const stepDays = 1;
  let intervalStart = startJulianDay;
  let differenceAtStart = signedAngleDifference(moonPhaseAngleDegrees(intervalStart), targetPhaseAngleDegrees);
  for (let stepIndex = 0; stepIndex < 32; stepIndex++) {
    const intervalEnd = intervalStart + stepDays;
    const differenceAtEnd = signedAngleDifference(moonPhaseAngleDegrees(intervalEnd), targetPhaseAngleDegrees);
    // Cruce ascendente por cero (no el salto de +180 a -180 del lado opuesto).
    if (differenceAtStart < 0 && differenceAtEnd >= 0) {
      let lowerBound = intervalStart;
      let upperBound = intervalEnd;
      while (upperBound - lowerBound > 1 / 86_400) {
        const middle = (lowerBound + upperBound) / 2;
        if (signedAngleDifference(moonPhaseAngleDegrees(middle), targetPhaseAngleDegrees) < 0) lowerBound = middle;
        else upperBound = middle;
      }
      return (lowerBound + upperBound) / 2;
    }
    intervalStart = intervalEnd;
    differenceAtStart = differenceAtEnd;
  }
  throw new Error('No se encontró la fase lunar en 32 días');
}

/**
 * Altura del centro de la Luna (con paralaje, sin refracción) cuando su borde superior toca el
 * horizonte: refracción estándar (34′) más el semidiámetro medio (15,5′).
 */
const moonRiseSetAltitudeDegrees = -(34 + 15.5) / 60;

export interface MoonRiseSetTimes {
  /** Próxima salida en las siguientes 48 h, o `null` si no la hay. */
  nextRiseJulianDay: number | null;
  nextSetJulianDay: number | null;
}

/** Próximas salida y puesta de la Luna, buscando cruces del horizonte en pasos de 10 min. */
export function findNextMoonRiseAndSet(observerLocation: ObserverLocation, startJulianDay: number): MoonRiseSetTimes {
  const stepDays = 10 / 1440;
  const searchSpanDays = 2;
  const altitudeAboveThreshold = (julianDay: number) =>
    moonHorizontalPosition(observerLocation, julianDay).altitudeDegrees - moonRiseSetAltitudeDegrees;

  let nextRiseJulianDay: number | null = null;
  let nextSetJulianDay: number | null = null;
  let intervalStart = startJulianDay;
  let valueAtStart = altitudeAboveThreshold(intervalStart);
  while (intervalStart < startJulianDay + searchSpanDays && (nextRiseJulianDay === null || nextSetJulianDay === null)) {
    const intervalEnd = intervalStart + stepDays;
    const valueAtEnd = altitudeAboveThreshold(intervalEnd);
    if (valueAtStart < 0 !== valueAtEnd < 0) {
      let lowerBound = intervalStart;
      let upperBound = intervalEnd;
      let valueAtLowerBound = valueAtStart;
      while (upperBound - lowerBound > 1 / 1440 / 4) {
        const middle = (lowerBound + upperBound) / 2;
        const valueAtMiddle = altitudeAboveThreshold(middle);
        if (valueAtMiddle < 0 === valueAtLowerBound < 0) {
          lowerBound = middle;
          valueAtLowerBound = valueAtMiddle;
        } else {
          upperBound = middle;
        }
      }
      const crossingJulianDay = (lowerBound + upperBound) / 2;
      const isRising = valueAtStart < 0;
      if (isRising && nextRiseJulianDay === null) nextRiseJulianDay = crossingJulianDay;
      if (!isRising && nextSetJulianDay === null) nextSetJulianDay = crossingJulianDay;
    }
    intervalStart = intervalEnd;
    valueAtStart = valueAtEnd;
  }
  return { nextRiseJulianDay, nextSetJulianDay };
}

/** Diámetro aparente de la Luna, en minutos de arco (~29,4′ en el apogeo, ~33,5′ en el perigeo). */
export function moonApparentDiameterArcminutes(distanceKilometers: number): number {
  return 2 * Math.asin(moonRadiusKilometers / distanceKilometers) * radiansToDegrees * 60;
}

export interface MoonReport {
  phaseAngleDegrees: number;
  phaseName: MoonPhaseName;
  illuminatedFraction: number;
  isWaxing: boolean;
  /** Días desde la última luna nueva. */
  ageDays: number;
  distanceKilometers: number;
  apparentDiameterArcminutes: number;
  nextNewMoon: Date;
  nextFirstQuarter: Date;
  nextFullMoon: Date;
  nextLastQuarter: Date;
  /** Solo si se conoce la ubicación del observador. */
  horizontalPosition?: HorizontalPosition;
  nextRise?: Date | null;
  nextSet?: Date | null;
}

/** Resumen de la Luna para un instante (y, opcionalmente, un lugar). */
export function computeMoonReport(date: Date, observerLocation?: ObserverLocation): MoonReport {
  const julianDay = julianDayFromDate(date);
  const phaseAngleDegrees = moonPhaseAngleDegrees(julianDay);
  const moonPosition = moonEclipticPosition(julianDay);
  // Empieza algo más de un mes sinódico atrás y avanza hasta la última luna nueva pasada.
  let lastNewMoonJulianDay = findNextMoonPhaseJulianDay(julianDay - synodicMonthDays - 1, 0);
  let followingNewMoonJulianDay = findNextMoonPhaseJulianDay(lastNewMoonJulianDay + 1, 0);
  while (followingNewMoonJulianDay <= julianDay) {
    lastNewMoonJulianDay = followingNewMoonJulianDay;
    followingNewMoonJulianDay = findNextMoonPhaseJulianDay(lastNewMoonJulianDay + 1, 0);
  }

  const moonReport: MoonReport = {
    phaseAngleDegrees,
    phaseName: moonPhaseName(phaseAngleDegrees),
    illuminatedFraction: moonIlluminatedFraction(julianDay),
    isWaxing: phaseAngleDegrees < 180,
    ageDays: julianDay - lastNewMoonJulianDay,
    distanceKilometers: moonPosition.distanceKilometers,
    apparentDiameterArcminutes: moonApparentDiameterArcminutes(moonPosition.distanceKilometers),
    nextNewMoon: dateFromJulianDay(followingNewMoonJulianDay),
    nextFirstQuarter: dateFromJulianDay(findNextMoonPhaseJulianDay(julianDay, 90)),
    nextFullMoon: dateFromJulianDay(findNextMoonPhaseJulianDay(julianDay, 180)),
    nextLastQuarter: dateFromJulianDay(findNextMoonPhaseJulianDay(julianDay, 270)),
  };
  if (observerLocation) {
    const riseSetTimes = findNextMoonRiseAndSet(observerLocation, julianDay);
    moonReport.horizontalPosition = moonHorizontalPosition(observerLocation, julianDay);
    moonReport.nextRise = riseSetTimes.nextRiseJulianDay === null ? null : dateFromJulianDay(riseSetTimes.nextRiseJulianDay);
    moonReport.nextSet = riseSetTimes.nextSetJulianDay === null ? null : dateFromJulianDay(riseSetTimes.nextSetJulianDay);
  }
  return moonReport;
}

/** Punto cardinal (de 16) para un acimut: índice 0 = N, 4 = E, 8 = S, 12 = O. */
export function compassPointIndex(azimuthDegrees: number): number {
  return Math.floor(normalizeDegrees(azimuthDegrees + 11.25) / 22.5) % 16;
}
