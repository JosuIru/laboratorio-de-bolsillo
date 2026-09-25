import { create } from 'zustand';

import { detectDeviceLocale, i18n, readPreferredLocale, type SupportedLocale } from '@/core/i18n';

import { readStoredSetting, settingsStorageKeys, writeStoredSetting } from './settingsStorage';

interface AppSettingsState {
  /** `null` = seguir el idioma del sistema. */
  preferredLocale: SupportedLocale | null;
  /** Desactivado por defecto: la ubicación es un dato personal. */
  attachLocationToMeasurements: boolean;
  setPreferredLocale(locale: SupportedLocale | null): void;
  setAttachLocationToMeasurements(isEnabled: boolean): void;
}

export const useAppSettingsStore = create<AppSettingsState>()((setState) => ({
  preferredLocale: readPreferredLocale(),
  attachLocationToMeasurements: readStoredSetting(settingsStorageKeys.attachLocationToMeasurements) === 'true',

  setPreferredLocale(locale) {
    writeStoredSetting(settingsStorageKeys.locale, locale);
    void i18n.changeLanguage(locale ?? detectDeviceLocale());
    setState({ preferredLocale: locale });
  },

  setAttachLocationToMeasurements(isEnabled) {
    writeStoredSetting(settingsStorageKeys.attachLocationToMeasurements, String(isEnabled));
    setState({ attachLocationToMeasurements: isEnabled });
  },
}));
