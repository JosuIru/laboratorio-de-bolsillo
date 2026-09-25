import { hexToRgb8 } from '@/processing/color/colorSpaces';

/** Un parche de color conocido de la tarjeta de referencia. */
export interface ReferencePatch {
  id: string;
  name: string;
  /** Color real del parche en sRGB (el que publica el fabricante de la tarjeta). */
  hexColor: string;
}

export interface ReferenceCard {
  presetId: ReferenceCardPresetId | 'custom';
  patches: ReferencePatch[];
}

export type ReferenceCardPresetId = 'white-paper' | 'colorchecker-six';

/**
 * Preajustes. Los valores de ColorChecker Classic son los sRGB (D65) publicados por BabelColor
 * para las tarjetas fabricadas desde 2014; el folio blanco es aproximado (L* ≈ 95) y solo sirve
 * para balance de blancos.
 */
export const referenceCardPresets: Record<ReferenceCardPresetId, ReferencePatch[]> = {
  'white-paper': [{ id: 'white', name: 'Blanco', hexColor: '#F2F2F2' }],
  'colorchecker-six': [
    { id: 'white', name: 'Blanco 9.5', hexColor: '#F3F3F2' },
    { id: 'neutral', name: 'Gris 5', hexColor: '#7A7A79' },
    { id: 'black', name: 'Negro 2', hexColor: '#343434' },
    { id: 'red', name: 'Rojo', hexColor: '#AF363C' },
    { id: 'green', name: 'Verde', hexColor: '#469449' },
    { id: 'blue', name: 'Azul', hexColor: '#383D96' },
  ],
};

export function createCardFromPreset(presetId: ReferenceCardPresetId): ReferenceCard {
  return { presetId, patches: referenceCardPresets[presetId].map((patch) => ({ ...patch })) };
}

export const defaultReferenceCard: ReferenceCard = createCardFromPreset('white-paper');

export const maximumPatchCount = 8;

/** Parámetros de calibración del colorímetro: la tarjeta que el usuario usa. */
export interface ColorimeterCalibrationParameters {
  card: ReferenceCard;
}

export function validateColorimeterCalibration(rawParameters: unknown): ColorimeterCalibrationParameters {
  const card = (rawParameters as Partial<ColorimeterCalibrationParameters> | null)?.card;
  const patches = card?.patches;
  if (!card || !Array.isArray(patches) || patches.length === 0 || patches.length > maximumPatchCount) {
    throw new Error('Tarjeta de referencia no válida');
  }
  const validatedPatches = patches.map((patch, patchIndex) => {
    if (typeof patch?.hexColor !== 'string' || !hexToRgb8(patch.hexColor)) {
      throw new Error(`Color no válido en el parche ${patchIndex + 1}`);
    }
    return {
      id: typeof patch.id === 'string' && patch.id ? patch.id : `patch-${patchIndex + 1}`,
      name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : `${patchIndex + 1}`,
      hexColor: patch.hexColor.toUpperCase().startsWith('#') ? patch.hexColor.toUpperCase() : `#${patch.hexColor.toUpperCase()}`,
    };
  });
  const presetId =
    card.presetId === 'white-paper' || card.presetId === 'colorchecker-six' ? card.presetId : 'custom';
  return { card: { presetId, patches: validatedPatches } };
}
