import { deltaE2000 } from './colorDifference';
import type { Lab } from './colorSpaces';

/** Un color de la escala de referencia (p. ej. la carta de una tira reactiva) y su valor. */
export interface ColorScaleEntry {
  label: string;
  /** Valor numérico asociado (pH, ppm, mg/L…). */
  value: number;
  lab: Lab;
}

export interface ScaleMatch {
  /** Entrada más parecida y su ΔE00. */
  nearestEntry: ColorScaleEntry;
  nearestDeltaE: number;
  /**
   * Valor estimado interpolando entre las dos entradas consecutivas (por valor) cuyo segmento
   * en CIELAB pasa más cerca de la muestra. Coincide con el de la entrada si cae en un extremo.
   */
  interpolatedValue: number;
  /** ΔE00 entre la muestra y el punto interpolado: si es alto, la muestra no encaja en la escala. */
  interpolationDeltaE: number;
  /** Todas las entradas ordenadas de más a menos parecida. */
  rankedEntries: { entry: ColorScaleEntry; deltaE: number }[];
}

function interpolateLab(startColor: Lab, endColor: Lab, fraction: number): Lab {
  return {
    lightness: startColor.lightness + fraction * (endColor.lightness - startColor.lightness),
    greenRed: startColor.greenRed + fraction * (endColor.greenRed - startColor.greenRed),
    blueYellow: startColor.blueYellow + fraction * (endColor.blueYellow - startColor.blueYellow),
  };
}

/** Proyección del punto sobre el segmento AB en CIELAB, acotada a [0, 1]. */
function projectOntoSegment(sampleColor: Lab, startColor: Lab, endColor: Lab): number {
  const segmentVector = [
    endColor.lightness - startColor.lightness,
    endColor.greenRed - startColor.greenRed,
    endColor.blueYellow - startColor.blueYellow,
  ];
  const sampleVector = [
    sampleColor.lightness - startColor.lightness,
    sampleColor.greenRed - startColor.greenRed,
    sampleColor.blueYellow - startColor.blueYellow,
  ];
  const segmentLengthSquared = segmentVector.reduce((sum, component) => sum + component * component, 0);
  if (segmentLengthSquared === 0) return 0;
  const dotProduct = segmentVector.reduce((sum, component, componentIndex) => sum + component * sampleVector[componentIndex]!, 0);
  return Math.min(1, Math.max(0, dotProduct / segmentLengthSquared));
}

export function matchColorAgainstScale(sampleColor: Lab, scaleEntries: readonly ColorScaleEntry[]): ScaleMatch | null {
  if (scaleEntries.length === 0) return null;

  const rankedEntries = scaleEntries
    .map((entry) => ({ entry, deltaE: deltaE2000(sampleColor, entry.lab) }))
    .sort((leftMatch, rightMatch) => leftMatch.deltaE - rightMatch.deltaE);
  const nearestMatch = rankedEntries[0]!;

  let interpolatedValue = nearestMatch.entry.value;
  let interpolationDeltaE = nearestMatch.deltaE;
  const entriesByValue = [...scaleEntries].sort((leftEntry, rightEntry) => leftEntry.value - rightEntry.value);
  for (let segmentIndex = 0; segmentIndex < entriesByValue.length - 1; segmentIndex++) {
    const segmentStart = entriesByValue[segmentIndex]!;
    const segmentEnd = entriesByValue[segmentIndex + 1]!;
    const fraction = projectOntoSegment(sampleColor, segmentStart.lab, segmentEnd.lab);
    const projectedColor = interpolateLab(segmentStart.lab, segmentEnd.lab, fraction);
    const projectedDeltaE = deltaE2000(sampleColor, projectedColor);
    if (projectedDeltaE < interpolationDeltaE) {
      interpolationDeltaE = projectedDeltaE;
      interpolatedValue = segmentStart.value + fraction * (segmentEnd.value - segmentStart.value);
    }
  }

  return {
    nearestEntry: nearestMatch.entry,
    nearestDeltaE: nearestMatch.deltaE,
    interpolatedValue,
    interpolationDeltaE,
    rankedEntries,
  };
}
