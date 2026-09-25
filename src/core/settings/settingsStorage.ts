import Storage from 'expo-sqlite/kv-store';

/** Ajustes pequeños en el almacén clave-valor de expo-sqlite (lectura síncrona al arrancar). */
export const settingsStorageKeys = {
  locale: 'settings.locale',
  attachLocationToMeasurements: 'settings.attachLocationToMeasurements',
} as const;

type SettingsStorageKey = (typeof settingsStorageKeys)[keyof typeof settingsStorageKeys];

export function readStoredSetting(storageKey: SettingsStorageKey): string | null {
  try {
    return Storage.getItemSync(storageKey);
  } catch {
    return null;
  }
}

export function writeStoredSetting(storageKey: SettingsStorageKey, value: string | null): void {
  try {
    if (value === null) Storage.removeItemSync(storageKey);
    else Storage.setItemSync(storageKey, value);
  } catch {
    // Si falla el almacenamiento, el ajuste solo dura hasta cerrar la app.
  }
}
