/**
 * Experimento «Tamaño de la Luna (ilusión lunar y superluna)»: medir el diámetro del disco con
 * precisión subpíxel en fotos de varias sesiones y compararlo con el predicho.
 * Lógica pura, sin React ni React Native.
 *
 * Para poder comparar sesiones, los diámetros se pasan a una escala común:
 *  - JPEG: «píxeles de la foto a zoom ×1» = píxeles de la foto / zoom (el zoom digital amplía un
 *    recorte del sensor hasta el tamaño de la foto).
 *  - RAW: píxeles del sensor, que no dependen del zoom (el DNG es siempre el sensor entero).
 * JPEG y RAW no tienen la misma escala (4000 frente a 4096 px de ancho, p. ej.), así que no se
 * mezclan en un mismo análisis. Tampoco las fotos por un telescopio.
 */
import type { ApparentSizeMeasurement } from '@/processing/astronomy/lunarApparentSize';
import type { GrayImage } from '@/processing/image/grayImage';
import { fitLunarDiskTolerantOfBlur } from '@/processing/image/limbProfiles';

export type SizeScaleSource = 'jpeg' | 'raw';

/** Suelo de la incertidumbre del radio (px del resultado): el ajuste nunca es perfecto. */
const minimumRadiusUncertaintyPixels = 0.03;
/** Con menos limbo que esto (fracción de la circunferencia) el radio no es fiable. */
const minimumLimbCoverageFraction = 0.25;

export interface SizeExperimentMeasurement extends ApparentSizeMeasurement {
  source: SizeScaleSource;
}

export interface DiameterMeasurement {
  /** Diámetro en la escala común (ver arriba). */
  diameterPixels: number;
  diameterUncertaintyPixels: number;
  limbCoverageFraction: number;
}

/**
 * Diámetro del disco de un resultado (sin realzar) en la escala común. `resultPixelsPerCommonPixel`
 * = píxeles del resultado por píxel de la escala común (p. ej., 2 en la superresolución por deriva
 * a zoom ×1, o 0,25·… si el recorte se redujo). `null` si no hay disco o el limbo es muy corto.
 */
export function measureDiameterForSizeExperiment(resultImage: GrayImage, resultPixelsPerCommonPixel: number): DiameterMeasurement | null {
  const diskFit = fitLunarDiskTolerantOfBlur(resultImage);
  if (!diskFit || diskFit.limbCoverageFraction < minimumLimbCoverageFraction || resultPixelsPerCommonPixel <= 0) return null;
  const radiusUncertainty = Math.max(minimumRadiusUncertaintyPixels, diskFit.rmsResidualPixels / Math.sqrt(Math.max(1, diskFit.inlierCount)));
  return {
    diameterPixels: (2 * diskFit.radius) / resultPixelsPerCommonPixel,
    diameterUncertaintyPixels: (2 * radiusUncertainty) / resultPixelsPerCommonPixel,
    limbCoverageFraction: diskFit.limbCoverageFraction,
  };
}

/** Lo que se guarda de cada medida (campos de `MoonMeasurementValues`). */
export interface StoredSizeFields {
  experiment?: string;
  measuredDiameterPixels?: number;
  diameterUncertaintyPixels?: number;
  sizeScaleSource?: string;
}

/** Medidas del experimento guardadas en el historial del instrumento. */
export function sizeMeasurementsFromHistory(
  storedMeasurements: readonly { timestamp: number; values: StoredSizeFields }[],
): SizeExperimentMeasurement[] {
  return storedMeasurements.flatMap((storedMeasurement) => {
    const { experiment, measuredDiameterPixels, diameterUncertaintyPixels, sizeScaleSource } = storedMeasurement.values;
    if (experiment !== 'apparentSize' || measuredDiameterPixels === undefined || diameterUncertaintyPixels === undefined) return [];
    if (sizeScaleSource !== 'jpeg' && sizeScaleSource !== 'raw') return [];
    return [
      {
        date: new Date(storedMeasurement.timestamp),
        diameterPixels: measuredDiameterPixels,
        diameterUncertaintyPixels,
        source: sizeScaleSource,
      },
    ];
  });
}

/**
 * Une las medidas de la sesión y las del historial (sin repetir las ya guardadas: misma fecha al
 * segundo) y se queda con las de la fuente de la más reciente, de la más antigua a la más nueva.
 */
export function mergeSizeSeries(
  sessionMeasurements: readonly SizeExperimentMeasurement[],
  historyMeasurements: readonly SizeExperimentMeasurement[],
): SizeExperimentMeasurement[] {
  const secondKey = (measurement: SizeExperimentMeasurement) => Math.round(measurement.date.getTime() / 1000);
  const historyKeys = new Set(historyMeasurements.map(secondKey));
  const allMeasurements = [...historyMeasurements, ...sessionMeasurements.filter((measurement) => !historyKeys.has(secondKey(measurement)))];
  allMeasurements.sort((first, second) => first.date.getTime() - second.date.getTime());
  const latestSource = allMeasurements[allMeasurements.length - 1]?.source;
  return allMeasurements.filter((measurement) => measurement.source === latestSource);
}
