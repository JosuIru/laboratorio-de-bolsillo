import { instrumentRegistry, instrumentSections } from '@instruments/registry';

import { registerInstrumentTranslations } from '@/core/i18n';

import type { AnyInstrumentDefinition, InstrumentSection } from './types';

/** Instrumentos visibles en esta build (los de desarrollo solo con `__DEV__`). */
export const enabledInstruments: readonly AnyInstrumentDefinition[] = instrumentRegistry.filter(
  (instrument) => __DEV__ || !instrument.isDevelopmentOnly,
);

/** Secciones de la pantalla de inicio con sus instrumentos visibles; las vacías no se muestran. */
export const enabledInstrumentSections: readonly InstrumentSection[] = instrumentSections
  .map((section) => ({
    ...section,
    instruments: section.instruments.filter((instrument) => __DEV__ || !instrument.isDevelopmentOnly),
  }))
  .filter((section) => section.instruments.length > 0);

registerInstrumentTranslations(enabledInstruments);

const instrumentsById = new Map(enabledInstruments.map((instrument) => [instrument.id, instrument]));

export function findInstrument(instrumentId: string): AnyInstrumentDefinition | undefined {
  return instrumentsById.get(instrumentId);
}
