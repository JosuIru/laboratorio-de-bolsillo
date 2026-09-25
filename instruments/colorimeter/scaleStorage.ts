import Storage from 'expo-sqlite/kv-store';

import { hexToRgb8 } from '@/processing/color/colorSpaces';

import type { UserColorScale } from './colorimeterEngine';

const scalesStorageKey = 'colorimeter.scales';

/** Descarta entradas corruptas en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredScales(storedText: string | null): UserColorScale[] {
  if (!storedText) return [];
  try {
    const parsedValue: unknown = JSON.parse(storedText);
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue.flatMap((candidateScale): UserColorScale[] => {
      if (typeof candidateScale?.id !== 'string' || typeof candidateScale?.name !== 'string') return [];
      const entries = Array.isArray(candidateScale.entries)
        ? candidateScale.entries.filter(
            (entry: { label?: unknown; value?: unknown; hexColor?: unknown }) =>
              typeof entry?.label === 'string' &&
              typeof entry?.value === 'number' &&
              Number.isFinite(entry.value) &&
              typeof entry?.hexColor === 'string' &&
              hexToRgb8(entry.hexColor) !== null,
          )
        : [];
      return [
        {
          id: candidateScale.id,
          name: candidateScale.name,
          unit: typeof candidateScale.unit === 'string' ? candidateScale.unit : '',
          entries,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function loadColorScales(): UserColorScale[] {
  try {
    return parseStoredScales(Storage.getItemSync(scalesStorageKey));
  } catch {
    return [];
  }
}

export function saveColorScales(scales: readonly UserColorScale[]): void {
  Storage.setItemSync(scalesStorageKey, JSON.stringify(scales));
}
