import { hexToRgb8 } from '@/processing/color/colorSpaces';

/** Un parche de color conocido de la tarjeta de referencia. */
export interface ReferencePatch {
  id: string;
  /**
   * Nombre escrito por el usuario. Los parches de los preajustes no lo llevan: se muestran con la
   * traducción de su id (ver `referencePatchLabel`).
   */
  name?: string;
  /** Color real del parche en sRGB (el que publica el fabricante de la tarjeta). */
  hexColor: string;
}

export const presetPatchIds = ['white', 'neutral', 'black', 'red', 'green', 'blue'] as const;
export type PresetPatchId = (typeof presetPatchIds)[number];

function isPresetPatchId(patchId: string): patchId is PresetPatchId {
  return (presetPatchIds as readonly string[]).includes(patchId);
}

/** Nombres fijos en castellano que guardaban los perfiles anteriores a la traducción de los parches. */
const legacyPresetPatchNames: Record<PresetPatchId, readonly string[]> = {
  white: ['Blanco', 'Blanco 9.5'],
  neutral: ['Gris 5'],
  black: ['Negro 2'],
  red: ['Rojo'],
  green: ['Verde'],
  blue: ['Azul'],
};

/** Clave i18n (espacio de nombres del colorímetro) del nombre de un parche de preajuste. */
export function presetPatchNameKey(patchId: PresetPatchId): string {
  return `colorimeter:card.patchNames.${patchId}`;
}

/** Si el parche es de un preajuste y no tiene nombre propio (o tiene el antiguo en castellano fijo). */
function translatablePresetPatchId(patch: Pick<ReferencePatch, 'id' | 'name'>): PresetPatchId | null {
  if (!isPresetPatchId(patch.id)) return null;
  const ownName = patch.name?.trim() ?? '';
  return ownName === '' || legacyPresetPatchNames[patch.id].includes(ownName) ? patch.id : null;
}

/**
 * Nombre visible de un parche: el traducido si es de un preajuste; si no, el que escribió el
 * usuario. `translate` resuelve claves con espacio de nombres (vale el `t` de cualquier instrumento).
 */
export function referencePatchLabel(
  patch: Pick<ReferencePatch, 'id' | 'name'>,
  translate: (translationKey: string) => string,
): string {
  const presetPatchId = translatablePresetPatchId(patch);
  return presetPatchId ? translate(presetPatchNameKey(presetPatchId)) : (patch.name ?? '');
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
  'white-paper': [{ id: 'white', hexColor: '#F2F2F2' }],
  'colorchecker-six': [
    { id: 'white', hexColor: '#F3F3F2' },
    { id: 'neutral', hexColor: '#7A7A79' },
    { id: 'black', hexColor: '#343434' },
    { id: 'red', hexColor: '#AF363C' },
    { id: 'green', hexColor: '#469449' },
    { id: 'blue', hexColor: '#383D96' },
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
    const patchId = typeof patch.id === 'string' && patch.id ? patch.id : `patch-${patchIndex + 1}`;
    const trimmedName = typeof patch.name === 'string' ? patch.name.trim() : '';
    const hexColor = patch.hexColor.toUpperCase().startsWith('#') ? patch.hexColor.toUpperCase() : `#${patch.hexColor.toUpperCase()}`;
    // Los parches de preajuste sin nombre propio (o con el antiguo en castellano) se traducen por id.
    if (translatablePresetPatchId({ id: patchId, name: trimmedName })) return { id: patchId, hexColor };
    return { id: patchId, name: trimmedName || `${patchIndex + 1}`, hexColor };
  });
  const presetId =
    card.presetId === 'white-paper' || card.presetId === 'colorchecker-six' ? card.presetId : 'custom';
  return { card: { presetId, patches: validatedPatches } };
}
