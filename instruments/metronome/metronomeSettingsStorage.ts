import Storage from 'expo-sqlite/kv-store';

import { clampBeatsPerMinute } from './metronomeTiming';

/** Tempo y compás elegidos, para empezar la próxima vez donde se dejó. */
export interface MetronomeSettings {
  beatsPerMinute: number;
  beatsPerBar: number;
}

export const beatsPerBarOptions: readonly number[] = [1, 2, 3, 4, 6];
export const defaultMetronomeSettings: MetronomeSettings = { beatsPerMinute: 100, beatsPerBar: 4 };

const metronomeSettingsStorageKey = 'metronome.settings';

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredMetronomeSettings(storedText: string | null): MetronomeSettings {
  if (!storedText) return defaultMetronomeSettings;
  try {
    const candidate = JSON.parse(storedText) as Partial<Record<keyof MetronomeSettings, unknown>> | null;
    if (!candidate || typeof candidate !== 'object') return defaultMetronomeSettings;
    const storedBeatsPerMinute = candidate.beatsPerMinute;
    const storedBeatsPerBar = candidate.beatsPerBar;
    return {
      beatsPerMinute:
        typeof storedBeatsPerMinute === 'number' && Number.isFinite(storedBeatsPerMinute)
          ? clampBeatsPerMinute(storedBeatsPerMinute)
          : defaultMetronomeSettings.beatsPerMinute,
      beatsPerBar:
        typeof storedBeatsPerBar === 'number' && beatsPerBarOptions.includes(storedBeatsPerBar)
          ? storedBeatsPerBar
          : defaultMetronomeSettings.beatsPerBar,
    };
  } catch {
    return defaultMetronomeSettings;
  }
}

export function loadMetronomeSettings(): MetronomeSettings {
  try {
    return parseStoredMetronomeSettings(Storage.getItemSync(metronomeSettingsStorageKey));
  } catch {
    return defaultMetronomeSettings;
  }
}

export function saveMetronomeSettings(metronomeSettings: MetronomeSettings): void {
  try {
    Storage.setItemSync(metronomeSettingsStorageKey, JSON.stringify(metronomeSettings));
  } catch {
    // Si no se puede guardar, el metrónomo funciona igual; solo no recordará el tempo.
  }
}
