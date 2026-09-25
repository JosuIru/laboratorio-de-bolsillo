import { supportedLocales } from '@/core/i18n/locales';

import type { AnyInstrumentDefinition, TranslationTree } from './types';

const kebabCasePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function collectTranslationKeyPaths(translationTree: TranslationTree, parentPath = ''): string[] {
  return Object.entries(translationTree).flatMap(([key, value]) => {
    const keyPath = parentPath ? `${parentPath}.${key}` : key;
    return typeof value === 'string' ? [keyPath] : collectTranslationKeyPaths(value, keyPath);
  });
}

/**
 * Comprueba que el registro de instrumentos es coherente. Devuelve la lista de problemas
 * (vacía si todo está bien); la usa un test para detectar errores al añadir instrumentos.
 */
export function findInstrumentRegistryProblems(registry: readonly AnyInstrumentDefinition[]): string[] {
  const registryProblems: string[] = [];
  const seenInstrumentIds = new Set<string>();

  for (const instrument of registry) {
    const problemPrefix = `[${instrument.id}]`;

    if (!kebabCasePattern.test(instrument.id)) registryProblems.push(`${problemPrefix} el id debe ir en kebab-case`);
    if (seenInstrumentIds.has(instrument.id)) registryProblems.push(`${problemPrefix} id duplicado`);
    seenInstrumentIds.add(instrument.id);

    if (instrument.requiredSensors.length === 0) {
      registryProblems.push(`${problemPrefix} debe requerir al menos un sensor`);
    }

    const requiredTranslationKeys = [
      instrument.nameKey,
      instrument.descriptionKey,
      ...instrument.dataSchema.fields.map((field) => field.labelKey),
    ];
    const referenceKeyPaths = new Set(collectTranslationKeyPaths(instrument.translations[supportedLocales[0]] ?? {}));

    for (const locale of supportedLocales) {
      const localeTranslations = instrument.translations[locale];
      if (!localeTranslations) {
        registryProblems.push(`${problemPrefix} faltan las traducciones "${locale}"`);
        continue;
      }
      const localeKeyPaths = new Set(collectTranslationKeyPaths(localeTranslations));
      for (const requiredKey of requiredTranslationKeys) {
        if (!localeKeyPaths.has(requiredKey)) {
          registryProblems.push(`${problemPrefix} falta la clave "${requiredKey}" en "${locale}"`);
        }
      }
      for (const referenceKey of referenceKeyPaths) {
        if (!localeKeyPaths.has(referenceKey)) {
          registryProblems.push(`${problemPrefix} "${locale}" no traduce "${referenceKey}"`);
        }
      }
      for (const localeKey of localeKeyPaths) {
        if (!referenceKeyPaths.has(localeKey)) {
          registryProblems.push(`${problemPrefix} "${locale}" tiene la clave sobrante "${localeKey}"`);
        }
      }
    }
  }

  return registryProblems;
}
