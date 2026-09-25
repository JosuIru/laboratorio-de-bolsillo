import { applyColorCorrection, chooseColorCorrection, type ColorCorrection } from '@/processing/color/colorCorrection';
import {
  hexToRgb8,
  type Lab,
  type LinearRgb,
  linearRgbToLab,
  linearToSrgb,
  rgb8ToHex,
  srgbToLab,
  srgbToLinear,
} from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';
import { type ColorScaleEntry, matchColorAgainstScale, type ScaleMatch } from '@/processing/color/scaleMatching';

import type { ReferenceCard } from './referenceCards';

/** Escala definida por el usuario (p. ej. la carta de colores de unas tiras de pH). */
export interface UserColorScale {
  id: string;
  name: string;
  unit: string;
  entries: { label: string; value: number; hexColor: string }[];
}

/** Por encima de esta variación relativa, la región de muestra no es uniforme. */
export const nonUniformRelativeDeviation = 0.12;

export interface ColorimeterReading {
  rawSampleHex: string;
  correctedSampleHex: string;
  correctedSampleLinear: LinearRgb;
  sampleLab: Lab;
  /** Corrección aplicada con los parches visibles, o null si no hay ninguno colocado. */
  correction: Pick<
    ColorCorrection,
    'model' | 'meanValidationDeltaE' | 'maximumValidationDeltaE' | 'isReducedToWhiteBalance'
  > | null;
  /** Parches usados en el ajuste (en el balance de blancos, solo los neutros si los hay). */
  usedPatchCount: number;
  /** Variación relativa máxima entre canales dentro de la región de muestra. */
  sampleRelativeDeviation: number;
  isSampleUniform: boolean;
  scaleMatch: ScaleMatch | null;
}

function relativeDeviation(statistics: RegionColorStatistics): number {
  const { meanLinear, standardDeviationLinear } = statistics;
  return Math.max(
    standardDeviationLinear.red / Math.max(meanLinear.red, 0.01),
    standardDeviationLinear.green / Math.max(meanLinear.green, 0.01),
    standardDeviationLinear.blue / Math.max(meanLinear.blue, 0.01),
  );
}

function clampLinear(color: LinearRgb): LinearRgb {
  const clampComponent = (component: number) => Math.min(1, Math.max(0, component));
  return { red: clampComponent(color.red), green: clampComponent(color.green), blue: clampComponent(color.blue) };
}

export function scaleEntriesToLab(scale: UserColorScale): ColorScaleEntry[] {
  return scale.entries.flatMap((entry) => {
    const entryColor = hexToRgb8(entry.hexColor);
    return entryColor ? [{ label: entry.label, value: entry.value, lab: srgbToLab(entryColor) }] : [];
  });
}

/**
 * Convierte lo medido en un fotograma en una lectura: corrige el color de la muestra con los
 * parches de la tarjeta visibles (los `null` son parches no colocados), pasa a CIELAB y, si hay
 * escala, busca el valor más parecido.
 */
export function evaluateColorimeterFrame(
  sampleStatistics: RegionColorStatistics,
  referenceStatistics: readonly (RegionColorStatistics | null)[],
  card: ReferenceCard,
  scale: UserColorScale | null,
): ColorimeterReading {
  const patchMeasurements = card.patches.flatMap((patch, patchIndex) => {
    const measuredPatch = referenceStatistics[patchIndex];
    const referenceColor = hexToRgb8(patch.hexColor);
    return measuredPatch && referenceColor
      ? [{ measured: measuredPatch.meanLinear, reference: srgbToLinear(referenceColor) }]
      : [];
  });

  // El modelo depende de lo distintos que sean los parches medidos, no solo de cuántos hay; si
  // son degenerados (p. ej. todos del mismo color), se mide sin corregir.
  const correction = chooseColorCorrection(patchMeasurements);

  const rawSampleLinear = sampleStatistics.meanLinear;
  const correctedSampleLinear = clampLinear(correction ? applyColorCorrection(correction, rawSampleLinear) : rawSampleLinear);
  const sampleLab = linearRgbToLab(correctedSampleLinear);
  const sampleRelativeDeviation = relativeDeviation(sampleStatistics);
  const scaleEntries = scale ? scaleEntriesToLab(scale) : [];

  return {
    rawSampleHex: rgb8ToHex(linearToSrgb(clampLinear(rawSampleLinear))),
    correctedSampleHex: rgb8ToHex(linearToSrgb(correctedSampleLinear)),
    correctedSampleLinear,
    sampleLab,
    correction: correction
      ? {
          model: correction.model,
          meanValidationDeltaE: correction.meanValidationDeltaE,
          maximumValidationDeltaE: correction.maximumValidationDeltaE,
          isReducedToWhiteBalance: correction.isReducedToWhiteBalance,
        }
      : null,
    usedPatchCount: correction ? correction.fittedPatchCount : 0,
    sampleRelativeDeviation,
    isSampleUniform: sampleRelativeDeviation <= nonUniformRelativeDeviation,
    scaleMatch: scaleEntries.length > 0 ? matchColorAgainstScale(sampleLab, scaleEntries) : null,
  };
}

/**
 * Promedia las últimas `windowSize` lecturas de cada región (en lineal) para que el valor en
 * pantalla sea estable frente al ruido del sensor.
 */
export function createRegionAverager(windowSize: number) {
  const recentFrames: (RegionColorStatistics | null)[][] = [];

  function averageRegion(regionIndex: number): RegionColorStatistics | null {
    const regionFrames = recentFrames
      .map((frameRegions) => frameRegions[regionIndex])
      .filter((regionStatistics): regionStatistics is RegionColorStatistics => !!regionStatistics);
    if (regionFrames.length === 0) return null;
    const averageComponent = (readComponent: (regionStatistics: RegionColorStatistics) => number) =>
      regionFrames.reduce((componentSum, regionStatistics) => componentSum + readComponent(regionStatistics), 0) /
      regionFrames.length;
    return {
      meanLinear: {
        red: averageComponent((regionStatistics) => regionStatistics.meanLinear.red),
        green: averageComponent((regionStatistics) => regionStatistics.meanLinear.green),
        blue: averageComponent((regionStatistics) => regionStatistics.meanLinear.blue),
      },
      standardDeviationLinear: {
        red: averageComponent((regionStatistics) => regionStatistics.standardDeviationLinear.red),
        green: averageComponent((regionStatistics) => regionStatistics.standardDeviationLinear.green),
        blue: averageComponent((regionStatistics) => regionStatistics.standardDeviationLinear.blue),
      },
      sampledPixelCount: regionFrames.reduce((pixelSum, regionStatistics) => pixelSum + regionStatistics.sampledPixelCount, 0),
    };
  }

  return {
    /** Añade las regiones de un fotograma (la primera es la muestra) y devuelve la media. */
    push(frameRegions: (RegionColorStatistics | null)[]): (RegionColorStatistics | null)[] {
      recentFrames.push(frameRegions);
      if (recentFrames.length > windowSize) recentFrames.shift();
      return frameRegions.map((_, regionIndex) => averageRegion(regionIndex));
    },
    reset(): void {
      recentFrames.length = 0;
    },
  };
}
