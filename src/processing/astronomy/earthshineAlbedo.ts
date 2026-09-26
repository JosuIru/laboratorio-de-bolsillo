/**
 * Albedo de la Tierra a partir de la luz cenicienta.
 *
 * La parte «apagada» de la Luna creciente se ve porque la ilumina la Tierra. Comparando su
 * brillo con el de la parte iluminada por el Sol se mide cuánta luz refleja la Tierra: es el
 * método del proyecto Earthshine de Big Bear (Goode et al., 2001, GRL 28, 1671; Qiu et al.,
 * 2003, JGR 108(D22), 4709). Su fórmula del albedo aparente (Qiu et al. 2003; los números de
 * ecuación no se citan porque no se han podido cotejar aquí), deducida de nuevo más abajo:
 *
 *   p*(β) = (3/2) · [f_b(θ) / f_a(θ₀)] · (p_b / p_a) · (I_a / I_b) · (R_em² / R⊕²) · (R_es² / R_ms²) / f_L(β)
 *
 *   I_a / I_b  razón de brillos (por unidad de tiempo de exposición): zona a en luz cenicienta,
 *              zona b iluminada por el Sol. Es lo que se mide en la foto.
 *   p_a / p_b  albedo normal relativo de las dos zonas (1 si son del mismo tipo: mar con mar,
 *              tierras altas con tierras altas; si no, ~0,6 de un mar frente a tierras altas).
 *   f(θ)       función de fase de la superficie lunar: cómo varía el brillo de una zona con el
 *              ángulo de fase. La zona a se ve con θ₀ ≈ 0 (la luz de la Tierra vuelve a la
 *              Tierra, casi en retrorreflexión) y la b con el ángulo de fase lunar θ.
 *   β          ángulo de fase de la Tierra vista desde la Luna (≈ 180° − θ).
 *   f_L(β)     función de fase de una esfera lambertiana: [sen β + (π − β)·cos β] / π.
 *   R_em, R⊕   distancia Tierra–Luna y radio terrestre; R_es, R_ms distancias al Sol de la
 *              Tierra y de la Luna (su razón al cuadrado difiere de 1 en <0,6 %).
 *   p*         «albedo aparente»: el albedo de Bond de una Tierra lambertiana que daría esa luz
 *              cenicienta en esa fase. El 3/2 es la razón entre albedo de Bond y geométrico de
 *              una esfera lambertiana (p = 2A/3).
 *
 * De dónde sale: la irradiancia de la Tierra en la Luna es E_⊕ = F☉·p·(R⊕/R_em)²·f_L(β) (p el
 * albedo geométrico) y la del Sol E☉ = F☉·(R_es/R_ms)²; el brillo de cada zona es su
 * irradiancia por su albedo y su función de fase, y se despeja p.
 *
 * SUPUESTOS Y LIMITACIONES (el resultado es una estimación didáctica, no una medida de clima):
 *  - La Tierra se trata como esfera lambertiana; en realidad las nubes y los océanos no lo
 *    son y p* cambia con la fase y la hora (qué continente mira a la Luna). El valor anual del
 *    proyecto Earthshine es ~0,30, igual que el de los satélites (CERES ~0,29).
 *  - f(θ) de una zona lunar: por defecto, la ley de magnitudes del disco integrado de Allen
 *    (m(θ) = 0,026·θ + 4·10⁻⁹·θ⁴, θ en grados; «Allen's Astrophysical Quantities») dividida por
 *    la fracción iluminada (1 + cos θ)/2 para quitar el efecto de la parte en sombra. Es una
 *    aproximación: Qiu et al. usan una f(θ) medida zona a zona. Se puede pasar la razón real.
 *  - El pico de oposición de la zona en luz cenicienta (θ₀ ≈ 1°) queda casi fuera de la ley
 *    lineal de Allen; eso tiende a subestimar p* unas décimas.
 *  - La razón I_a/I_b debe medirse sobre la imagen lineal (RAW o HDR con fondo de cielo
 *    restado); en un JPEG con gamma la razón no vale.
 *
 * Módulo puro: sin React ni React Native.
 */

import { moonEclipticPosition, moonIlluminatedFraction, sunEclipticPosition } from './moonEphemeris';

const degreesToRadians = Math.PI / 180;
/** Radio medio terrestre. */
const earthMeanRadiusKilometers = 6371;
/** Distancia media Tierra–Luna. */
const meanEarthMoonDistanceKilometers = 384_400;
/** Ángulo de fase de la zona en luz cenicienta vista desde la Tierra (retrorreflexión casi exacta). */
const earthshineReturnPhaseAngleDegrees = 1;
/** Albedo normal relativo típico de un mar frente a unas tierras altas (~0,07 / ~0,12). */
export const typicalMareToHighlandAlbedoRatio = 0.6;

/** Función de fase de una esfera lambertiana, normalizada a 1 en β = 0 (fase «llena»). */
export function lambertSpherePhaseFunction(phaseAngleDegrees: number): number {
  const phaseAngle = Math.min(Math.PI, Math.max(0, Math.abs(phaseAngleDegrees) * degreesToRadians));
  return (Math.sin(phaseAngle) + (Math.PI - phaseAngle) * Math.cos(phaseAngle)) / Math.PI;
}

/**
 * Ángulo de fase máximo en que se usa la aproximación de la función de fase lunar: más allá, al
 * dividir por una fracción iluminada diminuta deja de decrecer (y la Luna, a menos de 30° del
 * Sol, se hunde en el crepúsculo: no se mide la luz cenicienta ahí).
 */
export const maximumModeledLunarPhaseAngleDegrees = 150;

/**
 * Función de fase aproximada de una zona de la superficie lunar, normalizada a 1 en θ = 0 (ver
 * los supuestos en la cabecera). Se satura en `maximumModeledLunarPhaseAngleDegrees`.
 */
export function lunarSurfacePhaseFunction(phaseAngleDegrees: number): number {
  const phaseAngle = Math.min(maximumModeledLunarPhaseAngleDegrees, Math.abs(phaseAngleDegrees));
  const magnitudeIncrease = 0.026 * phaseAngle + 4e-9 * phaseAngle ** 4;
  const diskIntegratedFunction = 10 ** (-0.4 * magnitudeIncrease);
  const illuminatedFraction = (1 + Math.cos(phaseAngle * degreesToRadians)) / 2;
  return diskIntegratedFunction / illuminatedFraction;
}

export interface EarthshineGeometry {
  /** Ángulo de fase lunar θ (Sol–Luna–Tierra): 0 = llena, 180 = nueva. */
  lunarPhaseAngleDegrees: number;
  /** Ángulo de fase de la Tierra vista desde la Luna, β ≈ 180° − θ. */
  earthPhaseAngleDegrees: number;
  earthMoonDistanceKilometers: number;
  /** (R_es / R_ms)²: la Luna está algo más cerca o más lejos del Sol que la Tierra. */
  sunDistanceRatioSquared: number;
}

/** Geometría de la luz cenicienta en un instante, con las efemérides. */
export function earthshineGeometryAtJulianDay(julianDay: number): EarthshineGeometry {
  const moonPosition = moonEclipticPosition(julianDay);
  const sunPosition = sunEclipticPosition(julianDay);
  const illuminatedFraction = moonIlluminatedFraction(julianDay);
  const lunarPhaseAngleDegrees = Math.acos(Math.min(1, Math.max(-1, 2 * illuminatedFraction - 1))) / degreesToRadians;
  // Elongación geocéntrica Sol–Luna y distancia Sol–Luna por el teorema del coseno.
  const cosineOfElongation =
    Math.cos(moonPosition.latitudeDegrees * degreesToRadians) *
    Math.cos((moonPosition.longitudeDegrees - sunPosition.longitudeDegrees) * degreesToRadians);
  const sunMoonDistanceSquared =
    sunPosition.distanceKilometers ** 2 +
    moonPosition.distanceKilometers ** 2 -
    2 * sunPosition.distanceKilometers * moonPosition.distanceKilometers * cosineOfElongation;
  return {
    lunarPhaseAngleDegrees,
    earthPhaseAngleDegrees: 180 - lunarPhaseAngleDegrees,
    earthMoonDistanceKilometers: moonPosition.distanceKilometers,
    sunDistanceRatioSquared: sunPosition.distanceKilometers ** 2 / sunMoonDistanceSquared,
  };
}

export interface EarthshineObservation {
  /** Razón I_a / I_b medida (luz cenicienta / luz del Sol), por unidad de exposición. */
  earthshineToSunlitRatio: number;
  /** Incertidumbre relativa (1σ) de esa razón, p. ej. 0,1 = 10 %. */
  ratioRelativeUncertainty: number;
  /** Ángulo de fase lunar θ, en grados. */
  lunarPhaseAngleDegrees: number;
  /** Incertidumbre de θ, en grados (por defecto 0,5°). */
  phaseAngleUncertaintyDegrees?: number;
  /** p_a / p_b: albedo de la zona en luz cenicienta frente a la iluminada (1 si son del mismo tipo). */
  darkToSunlitAlbedoRatio?: number;
  /** Incertidumbre relativa de ese cociente (por defecto 0,1). */
  albedoRatioRelativeUncertainty?: number;
  earthMoonDistanceKilometers?: number;
  sunDistanceRatioSquared?: number;
  /** Si se conoce, f_b(θ)/f_a(θ₀) medida; si no, la aproximación por defecto. */
  lunarPhaseFunctionRatio?: number;
}

export interface EarthAlbedoEstimate {
  /** Albedo de Bond aparente p* (lambertiano equivalente). */
  apparentBondAlbedo: number;
  /** Intervalo de ±1σ combinando las incertidumbres en cuadratura. */
  lowerBound: number;
  upperBound: number;
  relativeUncertainty: number;
  earthPhaseAngleDegrees: number;
  /** Fracción iluminada de la Tierra vista desde la Luna, (1 + cos β)/2. */
  earthIlluminatedFraction: number;
}

/** p* sin incertidumbres, a partir de todos los factores. */
function apparentAlbedoFromFactors(
  ratio: number,
  lunarPhaseAngleDegrees: number,
  albedoRatio: number,
  earthMoonDistanceKilometers: number,
  sunDistanceRatioSquared: number,
  phaseFunctionRatio?: number,
): number {
  const earthPhaseAngleDegrees = 180 - lunarPhaseAngleDegrees;
  const lunarPhaseFactor =
    phaseFunctionRatio ?? lunarSurfacePhaseFunction(lunarPhaseAngleDegrees) / lunarSurfacePhaseFunction(earthshineReturnPhaseAngleDegrees);
  const lambertFactor = lambertSpherePhaseFunction(earthPhaseAngleDegrees);
  if (lambertFactor <= 0) return Number.NaN;
  return (
    1.5 *
    lunarPhaseFactor *
    (1 / albedoRatio) *
    ratio *
    (earthMoonDistanceKilometers / earthMeanRadiusKilometers) ** 2 *
    sunDistanceRatioSquared /
    lambertFactor
  );
}

/** Albedo de Bond aparente de la Tierra, con su intervalo, a partir de una medida de luz cenicienta. */
export function estimateEarthAlbedoFromEarthshine(observation: EarthshineObservation): EarthAlbedoEstimate {
  const albedoRatio = observation.darkToSunlitAlbedoRatio ?? 1;
  const earthMoonDistance = observation.earthMoonDistanceKilometers ?? meanEarthMoonDistanceKilometers;
  const sunDistanceRatioSquared = observation.sunDistanceRatioSquared ?? 1;
  const phaseUncertainty = observation.phaseAngleUncertaintyDegrees ?? 0.5;
  const albedoRatioUncertainty = observation.albedoRatioRelativeUncertainty ?? 0.1;
  const evaluate = (lunarPhaseAngleDegrees: number) =>
    apparentAlbedoFromFactors(
      observation.earthshineToSunlitRatio,
      lunarPhaseAngleDegrees,
      albedoRatio,
      earthMoonDistance,
      sunDistanceRatioSquared,
      observation.lunarPhaseFunctionRatio,
    );
  const apparentBondAlbedo = evaluate(observation.lunarPhaseAngleDegrees);
  // p* es proporcional a la razón y a 1/(p_a/p_b): sus errores relativos pasan tal cual. El de
  // la fase se propaga numéricamente (la dependencia es fuertemente no lineal).
  const phaseRelativeUncertainty =
    Math.abs(evaluate(observation.lunarPhaseAngleDegrees + phaseUncertainty) - evaluate(observation.lunarPhaseAngleDegrees - phaseUncertainty)) /
    (2 * apparentBondAlbedo);
  const relativeUncertainty = Math.hypot(observation.ratioRelativeUncertainty, albedoRatioUncertainty, phaseRelativeUncertainty);
  const earthPhaseAngleDegrees = 180 - observation.lunarPhaseAngleDegrees;
  return {
    apparentBondAlbedo,
    lowerBound: apparentBondAlbedo * (1 - relativeUncertainty),
    upperBound: apparentBondAlbedo * (1 + relativeUncertainty),
    relativeUncertainty,
    earthPhaseAngleDegrees,
    earthIlluminatedFraction: (1 + Math.cos(earthPhaseAngleDegrees * degreesToRadians)) / 2,
  };
}

/**
 * Razón I_a/I_b que se espera ver con un albedo dado (la fórmula al revés): para planificar la
 * exposición y para comprobar una medida.
 */
export function predictEarthshineToSunlitRatio(
  apparentBondAlbedo: number,
  lunarPhaseAngleDegrees: number,
  darkToSunlitAlbedoRatio = 1,
  earthMoonDistanceKilometers = meanEarthMoonDistanceKilometers,
  sunDistanceRatioSquared = 1,
): number {
  const albedoForUnitRatio = apparentAlbedoFromFactors(
    1,
    lunarPhaseAngleDegrees,
    darkToSunlitAlbedoRatio,
    earthMoonDistanceKilometers,
    sunDistanceRatioSquared,
  );
  return apparentBondAlbedo / albedoForUnitRatio;
}
