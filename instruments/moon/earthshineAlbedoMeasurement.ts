/**
 * Medida de la razón de brillos luz cenicienta / luz del Sol en las dos ráfagas de la luz
 * cenicienta, para estimar el albedo de la Tierra (`estimateEarthAlbedoFromEarthshine`).
 * Lógica pura, sin React ni React Native.
 *
 * - La zona en luz cenicienta se mide en la ráfaga LARGA y la iluminada en la CORTA; la larga se
 *   divide por la relación de tiempos de exposición (la nominal: la medida en las fotos se hace
 *   con valores JPEG, que no son lineales).
 * - Los JPEG llevan la curva sRGB: se pasan a lineal antes de restar el cielo y dividir. La curva
 *   real del móvil no es exactamente sRGB: por eso se añade una incertidumbre fija (supuesto).
 * - Cada zona es un círculo (una fracción del radio) alrededor de un punto que marca el usuario
 *   o que se elige solo: en la dirección del limbo iluminado para el Sol y en la opuesta para la
 *   luz cenicienta.
 */
import type { GrayImage } from '@/processing/image/grayImage';
import type { Circle } from '@/processing/image/lunarDiskFit';

/** Radio de cada zona, como fracción del radio del disco. */
export const measurementRegionRadiusFraction = 0.12;
/** Incertidumbre relativa que se suma por la curva de tono desconocida del JPEG (supuesto). */
export const jpegToneCurveRelativeUncertainty = 0.25;
/** Por encima de este valor (0-255) un píxel se da por saturado. */
const saturatedLevel = 250;
/** Distancias al centro, en radios, de los puntos automáticos. */
const automaticSunlitDistanceFraction = 0.75;
const automaticDarkDistanceFraction = 0.55;
/** Radio a partir del cual se mide el cielo (en radios del disco). */
const skyInnerRadiusFactor = 1.2;

export interface ImagePoint {
  x: number;
  y: number;
}

export type EarthshineRatioProblem = 'noSunlitSignal' | 'noEarthshineSignal' | 'earthshineSaturated' | 'sunlitSaturated' | 'outsideDisk';

export interface EarthshineRatioMeasurement {
  /** I_a / I_b por unidad de tiempo de exposición. */
  earthshineToSunlitRatio: number;
  /** Incertidumbre relativa (1σ): ruido de las zonas y curva de tono del JPEG. */
  ratioRelativeUncertainty: number;
  /** Solo el ruido estadístico de las dos zonas. */
  statisticalRelativeUncertainty: number;
  darkPoint: ImagePoint;
  sunlitPoint: ImagePoint;
  /** Brillos lineales con el cielo restado (unidades de 0-255 lineal). */
  earthshineLinearLevel: number;
  sunlitLinearLevel: number;
}

/** sRGB 0-255 a lineal 0-255. */
export function srgbByteToLinear(encodedValue: number): number {
  const normalizedValue = Math.max(0, encodedValue) / 255;
  return 255 * (normalizedValue <= 0.04045 ? normalizedValue / 12.92 : ((normalizedValue + 0.055) / 1.055) ** 2.4);
}

interface RegionStatistics {
  mean: number;
  standardError: number;
  maximum: number;
  sampleCount: number;
}

/** Media (lineal) de un círculo y su error típico. */
function regionStatistics(image: GrayImage, center: ImagePoint, radiusPixels: number): RegionStatistics {
  const linearValues: number[] = [];
  let maximum = 0;
  for (let rowIndex = Math.max(0, Math.floor(center.y - radiusPixels)); rowIndex <= Math.min(image.height - 1, Math.ceil(center.y + radiusPixels)); rowIndex++) {
    for (let columnIndex = Math.max(0, Math.floor(center.x - radiusPixels)); columnIndex <= Math.min(image.width - 1, Math.ceil(center.x + radiusPixels)); columnIndex++) {
      if (Math.hypot(columnIndex - center.x, rowIndex - center.y) > radiusPixels) continue;
      const encodedValue = image.values[rowIndex * image.width + columnIndex]!;
      maximum = Math.max(maximum, encodedValue);
      linearValues.push(srgbByteToLinear(encodedValue));
    }
  }
  const sampleCount = linearValues.length;
  const mean = sampleCount > 0 ? linearValues.reduce((sum, value) => sum + value, 0) / sampleCount : 0;
  const variance = sampleCount > 1 ? linearValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sampleCount - 1) : 0;
  return { mean, standardError: Math.sqrt(variance / Math.max(1, sampleCount)), maximum, sampleCount };
}

/** Cielo (lineal): mediana fuera del disco. */
function skyLinearLevel(image: GrayImage, diskCircle: Circle): number {
  const skyValues: number[] = [];
  for (let rowIndex = 0; rowIndex < image.height; rowIndex += 2) {
    for (let columnIndex = 0; columnIndex < image.width; columnIndex += 2) {
      if (Math.hypot(columnIndex - diskCircle.centerX, rowIndex - diskCircle.centerY) > skyInnerRadiusFactor * diskCircle.radius) {
        skyValues.push(srgbByteToLinear(image.values[rowIndex * image.width + columnIndex]!));
      }
    }
  }
  if (skyValues.length === 0) return 0;
  skyValues.sort((first, second) => first - second);
  return skyValues[Math.floor(skyValues.length / 2)]!;
}

/**
 * Puntos automáticos: la dirección del limbo iluminado es la del centroide de brillo de la
 * exposición corta respecto al centro del disco.
 */
export function chooseAutomaticRegions(shortExposure: GrayImage, diskCircle: Circle): { darkPoint: ImagePoint; sunlitPoint: ImagePoint } | null {
  let weightSum = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let rowIndex = 0; rowIndex < shortExposure.height; rowIndex++) {
    for (let columnIndex = 0; columnIndex < shortExposure.width; columnIndex++) {
      if (Math.hypot(columnIndex - diskCircle.centerX, rowIndex - diskCircle.centerY) > diskCircle.radius) continue;
      const weight = srgbByteToLinear(shortExposure.values[rowIndex * shortExposure.width + columnIndex]!);
      weightSum += weight;
      weightedX += weight * columnIndex;
      weightedY += weight * rowIndex;
    }
  }
  if (weightSum <= 0) return null;
  const offsetX = weightedX / weightSum - diskCircle.centerX;
  const offsetY = weightedY / weightSum - diskCircle.centerY;
  const offsetLength = Math.hypot(offsetX, offsetY);
  // Casi llena: no hay parte en sombra que medir.
  if (offsetLength < 0.05 * diskCircle.radius) return null;
  const directionX = offsetX / offsetLength;
  const directionY = offsetY / offsetLength;
  return {
    sunlitPoint: {
      x: diskCircle.centerX + automaticSunlitDistanceFraction * diskCircle.radius * directionX,
      y: diskCircle.centerY + automaticSunlitDistanceFraction * diskCircle.radius * directionY,
    },
    darkPoint: {
      x: diskCircle.centerX - automaticDarkDistanceFraction * diskCircle.radius * directionX,
      y: diskCircle.centerY - automaticDarkDistanceFraction * diskCircle.radius * directionY,
    },
  };
}

/**
 * Razón luz cenicienta / Sol a partir de las dos exposiciones apiladas (0-255, curva sRGB, mismo
 * encuadre y centradas en el disco) y la relación nominal de tiempos de exposición.
 */
export function measureEarthshineRatio(input: {
  shortExposure: GrayImage;
  longExposure: GrayImage;
  diskCircle: Circle;
  exposureRatio: number;
  darkPoint: ImagePoint;
  sunlitPoint: ImagePoint;
}): EarthshineRatioMeasurement | { problem: EarthshineRatioProblem } {
  const { shortExposure, longExposure, diskCircle, exposureRatio, darkPoint, sunlitPoint } = input;
  const isOnDisk = (point: ImagePoint) => Math.hypot(point.x - diskCircle.centerX, point.y - diskCircle.centerY) < 0.95 * diskCircle.radius;
  if (!isOnDisk(darkPoint) || !isOnDisk(sunlitPoint)) return { problem: 'outsideDisk' };
  const regionRadius = Math.max(2, measurementRegionRadiusFraction * diskCircle.radius);
  const earthshineRegion = regionStatistics(longExposure, darkPoint, regionRadius);
  const sunlitRegion = regionStatistics(shortExposure, sunlitPoint, regionRadius);
  if (earthshineRegion.maximum >= saturatedLevel) return { problem: 'earthshineSaturated' };
  if (sunlitRegion.maximum >= saturatedLevel) return { problem: 'sunlitSaturated' };
  const earthshineLinearLevel = earthshineRegion.mean - skyLinearLevel(longExposure, diskCircle);
  const sunlitLinearLevel = sunlitRegion.mean - skyLinearLevel(shortExposure, diskCircle);
  if (!(sunlitLinearLevel > 3 * sunlitRegion.standardError) || sunlitLinearLevel <= 0) return { problem: 'noSunlitSignal' };
  if (!(earthshineLinearLevel > 3 * earthshineRegion.standardError) || earthshineLinearLevel <= 0) return { problem: 'noEarthshineSignal' };
  const earthshineToSunlitRatio = earthshineLinearLevel / exposureRatio / sunlitLinearLevel;
  const statisticalRelativeUncertainty = Math.hypot(
    earthshineRegion.standardError / earthshineLinearLevel,
    sunlitRegion.standardError / sunlitLinearLevel,
  );
  return {
    earthshineToSunlitRatio,
    ratioRelativeUncertainty: Math.hypot(statisticalRelativeUncertainty, jpegToneCurveRelativeUncertainty),
    statisticalRelativeUncertainty,
    darkPoint,
    sunlitPoint,
    earthshineLinearLevel,
    sunlitLinearLevel,
  };
}

/** Qué tipo de terreno hay en cada zona: fija el cociente de albedos p_a / p_b. */
export type TerrainPairing = 'sameTerrain' | 'mareInShadow' | 'mareInSunlight';

/** p_a / p_b según las zonas (≈ 0,6 un mar frente a tierras altas). */
export function albedoRatioForPairing(terrainPairing: TerrainPairing, mareToHighlandRatio: number): number {
  if (terrainPairing === 'mareInShadow') return mareToHighlandRatio;
  if (terrainPairing === 'mareInSunlight') return 1 / mareToHighlandRatio;
  return 1;
}
