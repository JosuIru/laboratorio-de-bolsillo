/**
 * Orientación del disco lunar tal como se ve, para superponer un atlas a una foto: libración
 * óptica, ángulo de posición del eje de rotación, del limbo iluminado y punto subsolar (Jean
 * Meeus, «Astronomical Algorithms», 2.ª ed., caps. 14, 47, 48 y 53).
 *
 * Simplificaciones (todas por debajo de ~0,1°, invisibles en una foto de móvil):
 *  - Libración óptica sin la física (esta no pasa de ~0,04°).
 *  - Sin nutación (se cancela en W = λ − ΔΨ − Ω) ni ΔT (~70 s).
 *  - Geocéntrica: la libración diurna (vista desde la superficie) llega a ~1°, pero solo
 *    desplaza los accidentes cerca del limbo una fracción de píxel en un disco de cientos.
 *
 * Convenios:
 *  - Longitud selenográfica positiva hacia el Mare Crisium (este IAU), que con el norte lunar
 *    arriba se ve a la DERECHA.
 *  - Ángulos de posición medidos desde el norte celeste hacia el este (antihorario en el cielo
 *    con el norte arriba, porque el este queda a la izquierda).
 *
 * Módulo puro: sin React ni React Native.
 */

import {
  eclipticToEquatorial,
  type EquatorialPosition,
  greenwichMeanSiderealTimeDegrees,
  moonEclipticPosition,
  moonIlluminatedFraction,
  type ObserverLocation,
  sunEclipticPosition,
} from './moonEphemeris';

const degreesToRadians = Math.PI / 180;
const radiansToDegrees = 180 / Math.PI;
const julianDayOfJ2000 = 2_451_545;
/** Inclinación del ecuador lunar sobre la eclíptica (Meeus, cap. 53). */
const lunarEquatorInclinationDegrees = 1.54242;

function sinDegrees(angleDegrees: number): number {
  return Math.sin(angleDegrees * degreesToRadians);
}

function cosDegrees(angleDegrees: number): number {
  return Math.cos(angleDegrees * degreesToRadians);
}

function normalizeDegrees(angleDegrees: number): number {
  const wrappedAngle = angleDegrees % 360;
  return wrappedAngle < 0 ? wrappedAngle + 360 : wrappedAngle;
}

/** Ángulo en (−180, 180]. */
export function signedDegrees(angleDegrees: number): number {
  const normalizedAngle = normalizeDegrees(angleDegrees);
  return normalizedAngle > 180 ? normalizedAngle - 360 : normalizedAngle;
}

/** Longitud media del nodo ascendente de la órbita lunar, Ω (Meeus, ec. 47.7). */
function moonAscendingNodeLongitudeDegrees(centuries: number): number {
  return normalizeDegrees(
    125.0445479 - 1934.1362891 * centuries + 0.0020754 * centuries ** 2 + centuries ** 3 / 467441 -
      centuries ** 4 / 60616000,
  );
}

/** Argumento de latitud medio de la Luna, F (Meeus, ec. 47.5). */
function moonArgumentOfLatitudeDegrees(centuries: number): number {
  return normalizeDegrees(
    93.272095 + 483202.0175233 * centuries - 0.0036539 * centuries ** 2 - centuries ** 3 / 3526000 +
      centuries ** 4 / 863310000,
  );
}

/** Oblicuidad media de la eclíptica (Meeus, ec. 22.2). */
function meanObliquityDegrees(centuries: number): number {
  return 23.439291111 - 0.0130041667 * centuries - 1.639e-7 * centuries ** 2;
}

export interface SelenographicPoint {
  /** Latitud selenográfica, en grados (positiva al norte). */
  latitudeDegrees: number;
  /** Longitud selenográfica en (−180, 180], positiva hacia el Mare Crisium. */
  longitudeDegrees: number;
}

/**
 * Punto de la superficie lunar que mira hacia una dirección eclíptica (λ, β) vista desde la
 * Luna: la libración óptica si es la dirección de la Tierra (Meeus, ecs. 53.1).
 */
function selenographicPointFacing(
  eclipticLongitudeDegrees: number,
  eclipticLatitudeDegrees: number,
  ascendingNodeDegrees: number,
  argumentOfLatitudeDegrees: number,
): SelenographicPoint {
  const nodeDistance = eclipticLongitudeDegrees - ascendingNodeDegrees;
  const inclination = lunarEquatorInclinationDegrees;
  const angleA =
    Math.atan2(
      sinDegrees(nodeDistance) * cosDegrees(eclipticLatitudeDegrees) * cosDegrees(inclination) -
        sinDegrees(eclipticLatitudeDegrees) * sinDegrees(inclination),
      cosDegrees(nodeDistance) * cosDegrees(eclipticLatitudeDegrees),
    ) * radiansToDegrees;
  const latitude =
    Math.asin(
      -sinDegrees(nodeDistance) * cosDegrees(eclipticLatitudeDegrees) * sinDegrees(inclination) -
        sinDegrees(eclipticLatitudeDegrees) * cosDegrees(inclination),
    ) * radiansToDegrees;
  return { latitudeDegrees: latitude, longitudeDegrees: signedDegrees(angleA - argumentOfLatitudeDegrees) };
}

export interface LunarOrientation {
  /** Libración óptica en longitud, l: positiva = se ve más del lado del Mare Crisium. */
  librationLongitudeDegrees: number;
  /** Libración óptica en latitud, b: positiva = se ve más del polo norte lunar. */
  librationLatitudeDegrees: number;
  /** Ángulo de posición del eje de rotación (del polo norte lunar), P, desde el norte celeste hacia el este. */
  axisPositionAngleDegrees: number;
  /** Ángulo de posición del punto medio del limbo iluminado, χ [0, 360) (Meeus, ec. 48.5). */
  brightLimbPositionAngleDegrees: number;
  /** Fracción iluminada del disco, 0-1. */
  illuminatedFraction: number;
  /** Punto de la Luna con el Sol en el cenit: fija el terminador. */
  subsolarPoint: SelenographicPoint;
  moonEquatorialPosition: EquatorialPosition;
  sunEquatorialPosition: EquatorialPosition;
}

/** Orientación de la Luna vista desde el centro de la Tierra en un día juliano (TD ≈ UT). */
export function computeLunarOrientation(julianDay: number): LunarOrientation {
  const centuries = (julianDay - julianDayOfJ2000) / 36_525;
  const ascendingNode = moonAscendingNodeLongitudeDegrees(centuries);
  const argumentOfLatitude = moonArgumentOfLatitudeDegrees(centuries);
  const obliquity = meanObliquityDegrees(centuries);
  const moonPosition = moonEclipticPosition(julianDay);
  const sunPosition = sunEclipticPosition(julianDay);
  const moonEquatorialPosition = eclipticToEquatorial(moonPosition, julianDay);
  const sunEquatorialPosition = eclipticToEquatorial(sunPosition, julianDay);

  const subEarthPoint = selenographicPointFacing(
    moonPosition.longitudeDegrees,
    moonPosition.latitudeDegrees,
    ascendingNode,
    argumentOfLatitude,
  );

  // Punto subsolar: la misma fórmula con la dirección heliocéntrica de la Luna (Meeus, cap. 53).
  const distanceRatio = moonPosition.distanceKilometers / sunPosition.distanceKilometers;
  const heliocentricLongitude =
    sunPosition.longitudeDegrees +
    180 +
    distanceRatio * radiansToDegrees * cosDegrees(moonPosition.latitudeDegrees) *
      sinDegrees(sunPosition.longitudeDegrees - moonPosition.longitudeDegrees);
  const heliocentricLatitude = distanceRatio * moonPosition.latitudeDegrees;
  const subsolarPoint = selenographicPointFacing(
    heliocentricLongitude,
    heliocentricLatitude,
    ascendingNode,
    argumentOfLatitude,
  );

  // Ángulo de posición del eje (Meeus, ecs. 53.3, sin la libración física).
  const inclination = lunarEquatorInclinationDegrees;
  const axisComponentX = sinDegrees(inclination) * sinDegrees(ascendingNode);
  const axisComponentY =
    sinDegrees(inclination) * cosDegrees(ascendingNode) * cosDegrees(obliquity) -
    cosDegrees(inclination) * sinDegrees(obliquity);
  const axisRightAscension = Math.atan2(axisComponentX, axisComponentY) * radiansToDegrees;
  const sineOfAxisAngle =
    (Math.hypot(axisComponentX, axisComponentY) *
      cosDegrees(moonEquatorialPosition.rightAscensionDegrees - axisRightAscension)) /
    cosDegrees(subEarthPoint.latitudeDegrees);
  const axisPositionAngleDegrees = Math.asin(Math.max(-1, Math.min(1, sineOfAxisAngle))) * radiansToDegrees;

  // Ángulo de posición del limbo iluminado (Meeus, ec. 48.5).
  const rightAscensionDifference =
    sunEquatorialPosition.rightAscensionDegrees - moonEquatorialPosition.rightAscensionDegrees;
  const brightLimbPositionAngleDegrees = normalizeDegrees(
    Math.atan2(
      cosDegrees(sunEquatorialPosition.declinationDegrees) * sinDegrees(rightAscensionDifference),
      sinDegrees(sunEquatorialPosition.declinationDegrees) * cosDegrees(moonEquatorialPosition.declinationDegrees) -
        cosDegrees(sunEquatorialPosition.declinationDegrees) *
          sinDegrees(moonEquatorialPosition.declinationDegrees) *
          cosDegrees(rightAscensionDifference),
    ) * radiansToDegrees,
  );

  return {
    librationLongitudeDegrees: subEarthPoint.longitudeDegrees,
    librationLatitudeDegrees: subEarthPoint.latitudeDegrees,
    axisPositionAngleDegrees,
    brightLimbPositionAngleDegrees,
    illuminatedFraction: moonIlluminatedFraction(julianDay),
    subsolarPoint,
    moonEquatorialPosition,
    sunEquatorialPosition,
  };
}

/**
 * Ángulo paraláctico q (Meeus, ec. 14.1): ángulo de posición del cenit visto desde el astro,
 * es decir, cuánto está girado el «arriba» del observador respecto al norte celeste. Negativo
 * antes de que el astro cruce el meridiano (al este), positivo después.
 */
export function computeParallacticAngleDegrees(
  equatorialPosition: EquatorialPosition,
  observerLocation: ObserverLocation,
  julianDay: number,
): number {
  const hourAngle =
    greenwichMeanSiderealTimeDegrees(julianDay) + observerLocation.longitudeDegrees - equatorialPosition.rightAscensionDegrees;
  return (
    Math.atan2(
      sinDegrees(hourAngle),
      Math.tan(observerLocation.latitudeDegrees * degreesToRadians) * cosDegrees(equatorialPosition.declinationDegrees) -
        sinDegrees(equatorialPosition.declinationDegrees) * cosDegrees(hourAngle),
    ) * radiansToDegrees
  );
}

export interface ImageRotationInputs {
  /** P, de `computeLunarOrientation`. */
  axisPositionAngleDegrees: number;
  /** q, de `computeParallacticAngleDegrees`; 0 si la imagen ya tiene el norte celeste arriba. */
  parallacticAngleDegrees: number;
  /**
   * Giro del móvil respecto a la vertical (0 = vertical, el borde de arriba hacia el cenit),
   * positivo si el usuario lo gira en sentido antihorario tal como lo mira.
   */
  deviceRollDegrees?: number;
  /** Giro que añade la óptica: 180 para un telescopio astronómico o una lente sola, 0 para prismáticos. */
  opticsRotationDegrees?: number;
}

/**
 * Ángulo (antihorario en la imagen, desde su «arriba») al que apunta el polo norte lunar en la
 * foto: θ = P − q − giro del móvil + giro de la óptica, en (−180, 180].
 */
export function computeLunarNorthAngleInImageDegrees({
  axisPositionAngleDegrees,
  parallacticAngleDegrees,
  deviceRollDegrees = 0,
  opticsRotationDegrees = 0,
}: ImageRotationInputs): number {
  return signedDegrees(axisPositionAngleDegrees - parallacticAngleDegrees - deviceRollDegrees + opticsRotationDegrees);
}
