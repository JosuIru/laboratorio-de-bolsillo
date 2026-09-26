import Storage from 'expo-sqlite/kv-store';

import { type CycleDetectorSettings, defaultCycleDetectorSettings } from './cycleDetector';

/**
 * Sensibilidad: cuánto por encima del ruido de fondo tiene que vibrar la máquina. Un lavavajillas
 * vibra muy poco (sensibilidad alta); una lavadora mal nivelada, mucho (baja).
 * `fallbackThreshold` es el umbral si se pulsa «Ya está en marcha» sin haber medido el fondo.
 */
export const sensitivityPresets = {
  high: { backgroundMultiplier: 2, minimumThreshold: 0.006, fallbackThreshold: 0.03 },
  medium: { backgroundMultiplier: 3, minimumThreshold: 0.01, fallbackThreshold: 0.05 },
  low: { backgroundMultiplier: 5, minimumThreshold: 0.02, fallbackThreshold: 0.1 },
} as const;

export type SensitivityLevel = keyof typeof sensitivityPresets;
export const sensitivityLevels = Object.keys(sensitivityPresets) as SensitivityLevel[];

/** Minutos seguidos sin vibración para dar el ciclo por terminado. */
export const quietMinutesOptions: readonly number[] = [1, 2, 3, 5, 10];

export interface ApplianceCycleSettings {
  sensitivityLevel: SensitivityLevel;
  quietMinutesToFinish: number;
}

export const defaultApplianceCycleSettings: ApplianceCycleSettings = { sensitivityLevel: 'medium', quietMinutesToFinish: 3 };

export function buildDetectorSettings(applianceCycleSettings: ApplianceCycleSettings): CycleDetectorSettings {
  const sensitivityPreset = sensitivityPresets[applianceCycleSettings.sensitivityLevel];
  return {
    ...defaultCycleDetectorSettings,
    backgroundMultiplier: sensitivityPreset.backgroundMultiplier,
    minimumThreshold: sensitivityPreset.minimumThreshold,
    quietSecondsToFinish: applianceCycleSettings.quietMinutesToFinish * 60,
  };
}

const applianceCycleSettingsStorageKey = 'appliance-cycle.settings';

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredApplianceCycleSettings(storedText: string | null): ApplianceCycleSettings {
  if (!storedText) return defaultApplianceCycleSettings;
  try {
    const candidate = JSON.parse(storedText) as Partial<Record<keyof ApplianceCycleSettings, unknown>> | null;
    if (!candidate || typeof candidate !== 'object') return defaultApplianceCycleSettings;
    const storedSensitivity = candidate.sensitivityLevel;
    const storedQuietMinutes = candidate.quietMinutesToFinish;
    return {
      sensitivityLevel: sensitivityLevels.includes(storedSensitivity as SensitivityLevel)
        ? (storedSensitivity as SensitivityLevel)
        : defaultApplianceCycleSettings.sensitivityLevel,
      quietMinutesToFinish:
        typeof storedQuietMinutes === 'number' && quietMinutesOptions.includes(storedQuietMinutes)
          ? storedQuietMinutes
          : defaultApplianceCycleSettings.quietMinutesToFinish,
    };
  } catch {
    return defaultApplianceCycleSettings;
  }
}

export function loadApplianceCycleSettings(): ApplianceCycleSettings {
  try {
    return parseStoredApplianceCycleSettings(Storage.getItemSync(applianceCycleSettingsStorageKey));
  } catch {
    return defaultApplianceCycleSettings;
  }
}

export function saveApplianceCycleSettings(applianceCycleSettings: ApplianceCycleSettings): void {
  try {
    Storage.setItemSync(applianceCycleSettingsStorageKey, JSON.stringify(applianceCycleSettings));
  } catch {
    // Si no se puede guardar, el instrumento funciona igual; solo no recordará la elección.
  }
}
