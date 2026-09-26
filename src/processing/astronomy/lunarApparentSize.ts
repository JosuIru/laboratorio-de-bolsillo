/**
 * Tamaño aparente de la Luna: predicción, conversión a píxeles y análisis de una serie de fotos.
 *
 * Dos ideas que se pueden comprobar con el móvil:
 *  - «Ilusión lunar»: la Luna junto al horizonte PARECE enorme, pero en la foto es un ~1,5 %
 *    MÁS PEQUEÑA que alta en el cielo. Desde la superficie estamos un radio terrestre (6378 km)
 *    más cerca de la Luna cuando la tenemos en el cenit que cuando está en el horizonte:
 *        d_topocéntrica ≈ Δ − R⊕·sen(h),   diámetro ∝ 1/d  ⇒  crece ≈ (R⊕/Δ)·sen(h) ≈ 1,66 %·sen(h).
 *  - Superluna: entre el perigeo (~356 500 km) y el apogeo (~406 700 km) el diámetro cambia
 *    ~14 % (33,5′ frente a 29,4′).
 *
 * Con el moto g57 (f = 4,81 mm, píxel 1,6 µm: 68,6″/px) la Luna mide ~27–30 px; un 1,5 % son
 * ~0,4 px, medible con el ajuste de disco subpíxel si se promedian varias fotos.
 *
 * La distancia topocéntrica se calcula con vectores: posición geocéntrica de la Luna
 * (`moonEphemeris`) menos la del observador sobre el elipsoide terrestre (Meeus, cap. 11).
 * Módulo puro: sin React ni React Native.
 */

import {
  eclipticToEquatorial,
  equatorialToHorizontal,
  greenwichMeanSiderealTimeDegrees,
  julianDayFromDate,
  moonApparentDiameterArcminutes,
  moonEclipticPosition,
  type ObserverLocation,
} from './moonEphemeris';

const degreesToRadians = Math.PI / 180;
const radiansToDegrees = 180 / Math.PI;
const arcsecondsPerRadian = (180 / Math.PI) * 3600;
/** Radio ecuatorial terrestre (Meeus) y razón polar/ecuatorial del elipsoide (1 − 1/298,257). */
const earthEquatorialRadiusKilometers = 6378.14;
const earthPolarToEquatorialRatio = 0.99664719;
/** Distancias típicas de un perigeo y un apogeo cercanos a la luna llena. */
export const typicalPerigeeDistanceKilometers = 356_500;
export const typicalApogeeDistanceKilometers = 406_700;

// ---------------------------------------------------------------------------------------------
// Predicción
// ---------------------------------------------------------------------------------------------

export interface ObserverWithHeight extends ObserverLocation {
  /** Altura sobre el nivel del mar, en metros (0 por defecto). */
  heightMeters?: number;
}

export interface LunarApparentSizePrediction {
  geocentricDistanceKilometers: number;
  topocentricDistanceKilometers: number;
  /** Diámetro visto desde el centro de la Tierra. */
  geocentricDiameterArcminutes: number;
  /** Diámetro visto por el observador (el que sale en la foto). */
  topocentricDiameterArcminutes: number;
  /** Altura topocéntrica del centro de la Luna, sin refracción. */
  altitudeDegrees: number;
  azimuthDegrees: number;
}

/** Posición del observador respecto al centro de la Tierra, en km, en el sistema ecuatorial de la fecha. */
function observerGeocentricVector(observer: ObserverWithHeight, julianDay: number): [number, number, number] {
  const latitude = observer.latitudeDegrees * degreesToRadians;
  const heightRatio = (observer.heightMeters ?? 0) / (earthEquatorialRadiusKilometers * 1000);
  // Meeus, cap. 11: latitud geocéntrica por la forma achatada de la Tierra.
  const reducedLatitude = Math.atan(earthPolarToEquatorialRatio * Math.tan(latitude));
  const rhoSinGeocentricLatitude = earthPolarToEquatorialRatio * Math.sin(reducedLatitude) + heightRatio * Math.sin(latitude);
  const rhoCosGeocentricLatitude = Math.cos(reducedLatitude) + heightRatio * Math.cos(latitude);
  const localSiderealTime = (greenwichMeanSiderealTimeDegrees(julianDay) + observer.longitudeDegrees) * degreesToRadians;
  return [
    earthEquatorialRadiusKilometers * rhoCosGeocentricLatitude * Math.cos(localSiderealTime),
    earthEquatorialRadiusKilometers * rhoCosGeocentricLatitude * Math.sin(localSiderealTime),
    earthEquatorialRadiusKilometers * rhoSinGeocentricLatitude,
  ];
}

/** Tamaño aparente, distancia y altura de la Luna para un observador en un día juliano. */
export function predictLunarApparentSizeAtJulianDay(observer: ObserverWithHeight, julianDay: number): LunarApparentSizePrediction {
  const eclipticPosition = moonEclipticPosition(julianDay);
  const equatorialPosition = eclipticToEquatorial(eclipticPosition, julianDay);
  const rightAscension = equatorialPosition.rightAscensionDegrees * degreesToRadians;
  const declination = equatorialPosition.declinationDegrees * degreesToRadians;
  const geocentricDistance = eclipticPosition.distanceKilometers;
  const moonVectorX = geocentricDistance * Math.cos(declination) * Math.cos(rightAscension);
  const moonVectorY = geocentricDistance * Math.cos(declination) * Math.sin(rightAscension);
  const moonVectorZ = geocentricDistance * Math.sin(declination);
  const [observerX, observerY, observerZ] = observerGeocentricVector(observer, julianDay);
  const topocentricX = moonVectorX - observerX;
  const topocentricY = moonVectorY - observerY;
  const topocentricZ = moonVectorZ - observerZ;
  const topocentricDistance = Math.hypot(topocentricX, topocentricY, topocentricZ);
  const horizontalPosition = equatorialToHorizontal(
    {
      rightAscensionDegrees: ((Math.atan2(topocentricY, topocentricX) * radiansToDegrees) % 360 + 360) % 360,
      declinationDegrees: Math.asin(topocentricZ / topocentricDistance) * radiansToDegrees,
    },
    observer,
    julianDay,
  );
  return {
    geocentricDistanceKilometers: geocentricDistance,
    topocentricDistanceKilometers: topocentricDistance,
    geocentricDiameterArcminutes: moonApparentDiameterArcminutes(geocentricDistance),
    topocentricDiameterArcminutes: moonApparentDiameterArcminutes(topocentricDistance),
    altitudeDegrees: horizontalPosition.altitudeDegrees,
    azimuthDegrees: horizontalPosition.azimuthDegrees,
  };
}

export function predictLunarApparentSize(observer: ObserverWithHeight, date: Date): LunarApparentSizePrediction {
  return predictLunarApparentSizeAtJulianDay(observer, julianDayFromDate(date));
}

/**
 * Distancia topocéntrica para una Tierra esférica, dada la altura topocéntrica h:
 * d² + 2·d·R·sen(h) + R² = Δ²  ⇒  d = √(Δ² − R²cos²h) − R·sen(h). Sirve para razonar (y para los
 * tests) sin efemérides: en el horizonte d ≈ Δ, en el cenit d = Δ − R.
 */
export function topocentricDistanceForAltitude(
  geocentricDistanceKilometers: number,
  altitudeDegrees: number,
  earthRadiusKilometers = earthEquatorialRadiusKilometers,
): number {
  const altitude = altitudeDegrees * degreesToRadians;
  return (
    Math.sqrt(geocentricDistanceKilometers ** 2 - (earthRadiusKilometers * Math.cos(altitude)) ** 2) -
    earthRadiusKilometers * Math.sin(altitude)
  );
}

/** Razón de diámetros entre la Luna en el perigeo y en el apogeo (~1,14: la «superluna»). */
export function superMoonDiameterRatio(
  perigeeDistanceKilometers = typicalPerigeeDistanceKilometers,
  apogeeDistanceKilometers = typicalApogeeDistanceKilometers,
): number {
  return moonApparentDiameterArcminutes(perigeeDistanceKilometers) / moonApparentDiameterArcminutes(apogeeDistanceKilometers);
}

// ---------------------------------------------------------------------------------------------
// Cámara: píxeles ↔ ángulos
// ---------------------------------------------------------------------------------------------

export interface CameraGeometry {
  focalLengthMillimeters: number;
  pixelSizeMicrometers: number;
}

/** Cámara principal del moto g57 power (datos del fabricante y de las fotos del usuario). */
export const motoG57MainCamera: CameraGeometry = { focalLengthMillimeters: 4.81, pixelSizeMicrometers: 1.6 };

/** Escala de la imagen en segundos de arco por píxel: 206 265″ · píxel / focal. */
export function pixelScaleArcsecondsPerPixel(camera: CameraGeometry): number {
  return (arcsecondsPerRadian * camera.pixelSizeMicrometers * 1e-3) / camera.focalLengthMillimeters;
}

export function arcminutesToPixels(angleArcminutes: number, camera: CameraGeometry): number {
  return (angleArcminutes * 60) / pixelScaleArcsecondsPerPixel(camera);
}

export function pixelsToArcminutes(lengthPixels: number, camera: CameraGeometry): number {
  return (lengthPixels * pixelScaleArcsecondsPerPixel(camera)) / 60;
}

// ---------------------------------------------------------------------------------------------
// Serie de medidas
// ---------------------------------------------------------------------------------------------

export interface ApparentSizeMeasurement {
  date: Date;
  /** Diámetro medido en la foto (2 × radio del ajuste de disco). */
  diameterPixels: number;
  /** Incertidumbre (1σ) del diámetro, en píxeles. */
  diameterUncertaintyPixels: number;
}

export interface ApparentSizeMeasurementAnalysis extends ApparentSizeMeasurement {
  prediction: LunarApparentSizePrediction;
  /** Diámetro esperado con la escala ajustada. */
  fittedDiameterPixels: number;
  /** Medido − esperado, en píxeles. */
  residualPixels: number;
}

/** Veredicto sobre la ilusión lunar, como código para traducir en la interfaz. */
export type MoonIllusionVerdict =
  /** El tamaño crece con la altura como predice la geometría: la Luna baja es MÁS PEQUEÑA. */
  | 'consistentWithGeometry'
  /** Las medidas dicen que la Luna baja es más grande: algo falla (refracción, enfoque, ajuste). */
  | 'horizonLarger'
  /** La precisión no basta para distinguir el ~1,5 % (hacen falta más fotos o más altura). */
  | 'inconclusive';

export interface ApparentSizeSeriesAnalysis {
  measurements: ApparentSizeMeasurementAnalysis[];
  /** Escala ajustada de la cámara, en segundos de arco por píxel, y su incertidumbre. */
  fittedArcsecondsPerPixel: number;
  fittedArcsecondsPerPixelUncertainty: number;
  /** Focal que implica esa escala, si se da el tamaño de píxel. */
  impliedFocalLengthMillimeters?: number;
  /** χ² reducido del ajuste con el modelo topocéntrico (≈ 1 si las incertidumbres son realistas). */
  reducedChiSquared: number;
  /** Crecimiento relativo del diámetro por unidad de sen(altura): medido y predicho (≈ R⊕/Δ). */
  measuredGrowthPerSineAltitude: number;
  measuredGrowthPerSineAltitudeUncertainty: number;
  predictedGrowthPerSineAltitude: number;
  /** Diferencia de tamaño predicha entre la medida más baja y la más alta, en %. */
  predictedLowToHighPercent: number;
  moonIllusionVerdict: MoonIllusionVerdict;
}

/**
 * Ajusta la escala de la cámara y comprueba el efecto topocéntrico. Hacen falta al menos 3
 * medidas a alturas distintas (mejor desde cerca del horizonte hasta lo más alto posible).
 *
 * Crecimiento con la altura: y = medido / diámetro_geocéntrico_predicho se ajusta a
 * y = c₀ + c₁·sen(h) por mínimos cuadrados ponderados; el crecimiento relativo es c₁/c₀ (la
 * escala de la cámara se cancela). El predicho es la media de (d_geo/d_topo − 1)/sen(h).
 */
export function analyzeApparentSizeSeries(
  measurements: readonly ApparentSizeMeasurement[],
  observer: ObserverWithHeight,
  camera?: Pick<CameraGeometry, 'pixelSizeMicrometers'>,
): ApparentSizeSeriesAnalysis | null {
  if (measurements.length < 3) return null;
  const predictions = measurements.map((measurement) => predictLunarApparentSize(observer, measurement.date));
  const weights = measurements.map((measurement) => 1 / Math.max(1e-9, measurement.diameterUncertaintyPixels) ** 2);

  // Escala de un parámetro: medido_px = k · predicho_arcmin (k en px por minuto de arco).
  let weightedProductSum = 0;
  let weightedSquaredPredictionSum = 0;
  measurements.forEach((measurement, measurementIndex) => {
    const predictedArcminutes = predictions[measurementIndex]!.topocentricDiameterArcminutes;
    weightedProductSum += weights[measurementIndex]! * measurement.diameterPixels * predictedArcminutes;
    weightedSquaredPredictionSum += weights[measurementIndex]! * predictedArcminutes ** 2;
  });
  const pixelsPerArcminute = weightedProductSum / weightedSquaredPredictionSum;
  let chiSquared = 0;
  const analyzedMeasurements = measurements.map((measurement, measurementIndex) => {
    const prediction = predictions[measurementIndex]!;
    const fittedDiameterPixels = pixelsPerArcminute * prediction.topocentricDiameterArcminutes;
    const residualPixels = measurement.diameterPixels - fittedDiameterPixels;
    chiSquared += weights[measurementIndex]! * residualPixels ** 2;
    return { ...measurement, prediction, fittedDiameterPixels, residualPixels };
  });
  const reducedChiSquared = chiSquared / Math.max(1, measurements.length - 1);
  const pixelsPerArcminuteUncertainty = Math.sqrt(Math.max(1, reducedChiSquared) / weightedSquaredPredictionSum);
  const fittedArcsecondsPerPixel = 60 / pixelsPerArcminute;
  const fittedArcsecondsPerPixelUncertainty = (fittedArcsecondsPerPixel * pixelsPerArcminuteUncertainty) / pixelsPerArcminute;

  // Crecimiento con sen(altura), independiente de la escala.
  let sumWeights = 0;
  let sumSine = 0;
  let sumSineSquared = 0;
  let sumRatio = 0;
  let sumSineRatio = 0;
  let predictedGrowthSum = 0;
  let predictedGrowthCount = 0;
  analyzedMeasurements.forEach((measurement, measurementIndex) => {
    const geocentricDiameter = measurement.prediction.geocentricDiameterArcminutes;
    const sineAltitude = Math.sin(measurement.prediction.altitudeDegrees * degreesToRadians);
    const sizeRatio = measurement.diameterPixels / geocentricDiameter;
    const ratioWeight = weights[measurementIndex]! * geocentricDiameter ** 2;
    sumWeights += ratioWeight;
    sumSine += ratioWeight * sineAltitude;
    sumSineSquared += ratioWeight * sineAltitude ** 2;
    sumRatio += ratioWeight * sizeRatio;
    sumSineRatio += ratioWeight * sineAltitude * sizeRatio;
    if (Math.abs(sineAltitude) > 0.05) {
      predictedGrowthSum += (measurement.prediction.topocentricDiameterArcminutes / geocentricDiameter - 1) / sineAltitude;
      predictedGrowthCount++;
    }
  });
  const determinant = sumWeights * sumSineSquared - sumSine ** 2;
  const slope = determinant > 0 ? (sumWeights * sumSineRatio - sumSine * sumRatio) / determinant : 0;
  const intercept = determinant > 0 ? (sumRatio - slope * sumSine) / sumWeights : sumRatio / sumWeights;
  let linearChiSquared = 0;
  analyzedMeasurements.forEach((measurement, measurementIndex) => {
    const geocentricDiameter = measurement.prediction.geocentricDiameterArcminutes;
    const sineAltitude = Math.sin(measurement.prediction.altitudeDegrees * degreesToRadians);
    const residualRatio = measurement.diameterPixels / geocentricDiameter - (intercept + slope * sineAltitude);
    linearChiSquared += weights[measurementIndex]! * geocentricDiameter ** 2 * residualRatio ** 2;
  });
  const linearReducedChiSquared = linearChiSquared / Math.max(1, measurements.length - 2);
  const slopeUncertainty = determinant > 0 ? Math.sqrt((Math.max(1, linearReducedChiSquared) * sumWeights) / determinant) : Number.POSITIVE_INFINITY;
  const measuredGrowthPerSineAltitude = slope / intercept;
  const measuredGrowthPerSineAltitudeUncertainty = slopeUncertainty / Math.abs(intercept);
  const predictedGrowthPerSineAltitude =
    predictedGrowthCount > 0 ? predictedGrowthSum / predictedGrowthCount : earthEquatorialRadiusKilometers / 384_400;

  const topocentricDiameters = analyzedMeasurements.map((measurement) => measurement.prediction.topocentricDiameterArcminutes);
  const altitudes = analyzedMeasurements.map((measurement) => measurement.prediction.altitudeDegrees);
  const lowestIndex = altitudes.indexOf(Math.min(...altitudes));
  const highestIndex = altitudes.indexOf(Math.max(...altitudes));
  const predictedLowToHighPercent = 100 * (topocentricDiameters[highestIndex]! / topocentricDiameters[lowestIndex]! - 1);

  let moonIllusionVerdict: MoonIllusionVerdict = 'inconclusive';
  if (measuredGrowthPerSineAltitudeUncertainty < predictedGrowthPerSineAltitude / 2) {
    if (measuredGrowthPerSineAltitude < -2 * measuredGrowthPerSineAltitudeUncertainty) moonIllusionVerdict = 'horizonLarger';
    else if (Math.abs(measuredGrowthPerSineAltitude - predictedGrowthPerSineAltitude) < 3 * measuredGrowthPerSineAltitudeUncertainty) {
      moonIllusionVerdict = 'consistentWithGeometry';
    }
  }

  return {
    measurements: analyzedMeasurements,
    fittedArcsecondsPerPixel,
    fittedArcsecondsPerPixelUncertainty,
    impliedFocalLengthMillimeters: camera
      ? (arcsecondsPerRadian * camera.pixelSizeMicrometers * 1e-3) / fittedArcsecondsPerPixel
      : undefined,
    reducedChiSquared,
    measuredGrowthPerSineAltitude,
    measuredGrowthPerSineAltitudeUncertainty,
    predictedGrowthPerSineAltitude,
    predictedLowToHighPercent,
    moonIllusionVerdict,
  };
}
