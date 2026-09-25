import { getLocales } from 'expo-localization';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import es from './locales/es.json';
import eu from './locales/eu.json';

export const supportedLocales = ['es', 'eu'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export const defaultLocale: SupportedLocale = 'es';

export function isSupportedLocale(candidateLocale: string): candidateLocale is SupportedLocale {
  return (supportedLocales as readonly string[]).includes(candidateLocale);
}

/** Primer idioma del sistema que la app soporta; si no hay ninguno, castellano. */
export function detectDeviceLocale(): SupportedLocale {
  const matchingDeviceLocale = getLocales()
    .map((deviceLocale) => deviceLocale.languageCode ?? '')
    .find(isSupportedLocale);
  return matchingDeviceLocale ?? defaultLocale;
}

/** Espacio de nombres de las traducciones del núcleo; cada instrumento añade el suyo. */
export const coreNamespace = 'core';

export const coreResources = {
  es: { [coreNamespace]: es },
  eu: { [coreNamespace]: eu },
} as const;

export const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: coreResources,
  lng: detectDeviceLocale(),
  fallbackLng: defaultLocale,
  ns: [coreNamespace],
  defaultNS: coreNamespace,
  interpolation: { escapeValue: false },
  returnNull: false,
});
