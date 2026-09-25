/** Sin dependencias nativas, para poder importarlo desde código puro y tests. */
export const supportedLocales = ['es', 'eu'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

export const defaultLocale: SupportedLocale = 'es';

export function isSupportedLocale(candidateLocale: string): candidateLocale is SupportedLocale {
  return (supportedLocales as readonly string[]).includes(candidateLocale);
}
