import { hexToRgb8, srgbToLab } from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';

import { defaultReferenceCard, type ReferenceCard, type ReferencePatch } from '@instruments/colorimeter/referenceCards';

/** Un parche vale como blanco si es claro y casi neutro; si no, el balance dividiría por un canal casi nulo. */
const minimumWhiteLightness = 50;
const maximumWhiteChroma = 12;

/**
 * El parche claro y neutro de la tarjeta del colorímetro: el que se usa para el balance de blancos
 * del juego (una sola referencia, apuntada con la mira antes de empezar). Sin calibración, o si la
 * tarjeta no tiene ningún parche blanco o gris claro, el folio blanco por defecto.
 */
export function pickWhiteReferencePatch(card: ReferenceCard | null | undefined): ReferencePatch {
  return (
    findLightestNeutralPatch(card?.patches ?? []) ?? findLightestNeutralPatch(defaultReferenceCard.patches)!
  );
}

function findLightestNeutralPatch(candidatePatches: readonly ReferencePatch[]): ReferencePatch | null {
  let lightestNeutralPatch: ReferencePatch | null = null;
  let lightestNeutralLightness = Number.NEGATIVE_INFINITY;
  for (const patch of candidatePatches) {
    const patchColor = hexToRgb8(patch.hexColor);
    if (!patchColor) continue;
    const patchLab = srgbToLab(patchColor);
    const patchChroma = Math.hypot(patchLab.greenRed, patchLab.blueYellow);
    const isNeutralAndLight = patchLab.lightness >= minimumWhiteLightness && patchChroma <= maximumWhiteChroma;
    if (isNeutralAndLight && patchLab.lightness > lightestNeutralLightness) {
      lightestNeutralPatch = patch;
      lightestNeutralLightness = patchLab.lightness;
    }
  }
  return lightestNeutralPatch;
}

/** Por debajo de esto (lineal) la referencia está en sombra y el balance amplificaría ruido. */
export const minimumWhiteReferenceLinear = 0.08;

export function isUsableWhiteReference(measuredRegion: RegionColorStatistics): boolean {
  const { red, green, blue } = measuredRegion.meanLinear;
  return Math.min(red, green, blue) >= minimumWhiteReferenceLinear;
}

/** Tarjeta de un solo parche para `evaluateColorimeterFrame` (corrección diagonal). */
export function whiteBalanceCard(whitePatch: ReferencePatch): ReferenceCard {
  return { presetId: 'custom', patches: [whitePatch] };
}

export const cardWithoutPatches: ReferenceCard = { presetId: 'custom', patches: [] };
