import { findInstrumentRegistryProblems } from '@/core/instruments/registryValidation';

import basqueCoreTexts from '@/core/i18n/locales/eu.json';
import spanishCoreTexts from '@/core/i18n/locales/es.json';

import { instrumentRegistry, instrumentSections } from './registry';

describe('registro de instrumentos', () => {
  it('es coherente: ids únicos, traducciones completas en todos los idiomas', () => {
    expect(findInstrumentRegistryProblems(instrumentRegistry)).toEqual([]);
  });
});

describe('findInstrumentRegistryProblems', () => {
  const [validInstrument] = instrumentRegistry;

  it('detecta ids duplicados, mal formados y traducciones incompletas', () => {
    if (!validInstrument) return;
    const brokenInstrument = {
      ...validInstrument,
      id: 'Nivel_Roto',
      translations: { es: validInstrument.translations.es, eu: { name: 'Izena' } },
    };
    const registryProblems = findInstrumentRegistryProblems([validInstrument, validInstrument, brokenInstrument]);
    expect(registryProblems).toEqual(
      expect.arrayContaining([
        `[${validInstrument.id}] id duplicado`,
        '[Nivel_Roto] el id debe ir en kebab-case',
        '[Nivel_Roto] falta la clave "description" en "eu"',
      ]),
    );
  });
});

describe('secciones de la pantalla de inicio', () => {
  it('cada sección tiene título y descripción en todos los idiomas', () => {
    for (const locale of ['es', 'eu'] as const) {
      const homeTexts = locale === 'es' ? spanishCoreTexts.home : basqueCoreTexts.home;
      for (const section of instrumentSections) {
        expect(homeTexts.sections[section.id]).toEqual({
          title: expect.any(String),
          description: expect.any(String),
        });
      }
    }
  });
});
