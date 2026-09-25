import { hexToRgb8, srgbToLab } from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';

import { defaultReferenceCard, type ReferenceCard, type ReferencePatch } from '@instruments/colorimeter/referenceCards';

/**
 * El parche más claro de la tarjeta del colorímetro: el que se usa para el balance de blancos
 * del juego (una sola referencia, apuntada con la mira antes de empezar). Sin calibración del
 * colorímetro, el folio blanco por defecto.
 */
export function pickWhiteReferencePatch(card: ReferenceCard | null | undefined): ReferencePatch {
  const candidatePatches = card?.patches.length ? card.patches : defaultReferenceCard.patches;
  let brightestPatch = candidatePatches[0]!;
  let brightestLightness = Number.NEGATIVE_INFINITY;
  for (const patch of candidatePatches) {
    const patchColor = hexToRgb8(patch.hexColor);
    const patchLightness = patchColor ? srgbToLab(patchColor).lightness : Number.NEGATIVE_INFINITY;
    if (patchLightness > brightestLightness) {
      brightestPatch = patch;
      brightestLightness = patchLightness;
    }
  }
  return brightestPatch;
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
