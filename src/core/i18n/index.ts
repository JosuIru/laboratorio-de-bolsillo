import { getLocales } from 'expo-localization';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import type { AnyInstrumentDefinition } from '@/core/instruments/types';
import { readStoredSetting, settingsStorageKeys } from '@/core/settings/settingsStorage';

import es from './locales/es.json';
import eu from './locales/eu.json';
import { defaultLocale, isSupportedLocale, type SupportedLocale, supportedLocales } from './locales';

export { defaultLocale, isSupportedLocale, type SupportedLocale, supportedLocales };

/** Primer idioma del sistema que la app soporta; si no hay ninguno, castellano. */
export function detectDeviceLocale(): SupportedLocale {
  const matchingDeviceLocale = getLocales()
    .map((deviceLocale) => deviceLocale.languageCode ?? '')
    .find(isSupportedLocale);
  return matchingDeviceLocale ?? defaultLocale;
}

/** Idioma elegido por el usuario en ajustes, o `null` para seguir al sistema. */
export function readPreferredLocale(): SupportedLocale | null {
  const storedLocale = readStoredSetting(settingsStorageKeys.locale);
  return storedLocale && isSupportedLocale(storedLocale) ? storedLocale : null;
}

/** Espacio de nombres de las traducciones del núcleo; cada instrumento usa su id como el suyo. */
export const coreNamespace = 'core';

export const coreResources = {
  es: { [coreNamespace]: es },
  eu: { [coreNamespace]: eu },
} as const;

export const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: coreResources,
  lng: readPreferredLocale() ?? detectDeviceLocale(),
  fallbackLng: defaultLocale,
  ns: [coreNamespace],
  defaultNS: coreNamespace,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export function registerInstrumentTranslations(instruments: readonly AnyInstrumentDefinition[]): void {
  for (const instrument of instruments) {
    for (const locale of supportedLocales) {
      i18n.addResourceBundle(locale, instrument.id, instrument.translations[locale], true, true);
    }
  }
}
