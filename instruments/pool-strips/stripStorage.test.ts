import { ignoredPadSlot, stripPresets } from './stripPresets';
import { parseStoredCalibratedScales, parseStoredConfiguration } from './stripStorage';

describe('parseStoredCalibratedScales', () => {
  it('lee escalas válidas, ordena los niveles y descarta lo corrupto', () => {
    const storedText = JSON.stringify({
      'pool-ph': {
        levels: [
          { value: 7.8, hexColor: '#E4604A' },
          { value: 6.8, hexColor: '#F09A3A' },
          { value: 'siete', hexColor: '#EC7F3F' },
          { value: 7.2, hexColor: 'naranja' },
        ],
        calibratedAt: 1700000000000,
      },
      'pool-free-chlorine': { levels: [{ value: 0, hexColor: '#F6F2DC' }], calibratedAt: 1 },
      'parametro-inventado': { levels: [{ value: 0, hexColor: '#000000' }, { value: 1, hexColor: '#FFFFFF' }] },
      'aquarium-nitrate': { levels: [{ value: 0, hexColor: '#F8F3E9' }, { value: 50, hexColor: '#E3A0C2' }] },
    });
    expect(parseStoredCalibratedScales(storedText)).toEqual({
      'pool-ph': {
        levels: [
          { value: 6.8, hexColor: '#F09A3A' },
          { value: 7.8, hexColor: '#E4604A' },
        ],
        calibratedAt: 1700000000000,
      },
      'aquarium-nitrate': {
        levels: [
          { value: 0, hexColor: '#F8F3E9' },
          { value: 50, hexColor: '#E3A0C2' },
        ],
        calibratedAt: 0,
      },
    });
  });

  it('devuelve un objeto vacío si no hay nada o el JSON está roto', () => {
    expect(parseStoredCalibratedScales(null)).toEqual({});
    expect(parseStoredCalibratedScales('{roto')).toEqual({});
    expect(parseStoredCalibratedScales('[1, 2]')).toEqual({});
  });
});

describe('parseStoredConfiguration', () => {
  it('conserva el orden y los huecos, y quita parámetros ajenos o repetidos', () => {
    const storedText = JSON.stringify({
      presetId: 'aquarium',
      padSlots: ['aquarium-ph', ignoredPadSlot, 'pool-ph', 'aquarium-ph', 'aquarium-nitrite', 42],
    });
    expect(parseStoredConfiguration(storedText)).toEqual({
      presetId: 'aquarium',
      padSlots: ['aquarium-ph', ignoredPadSlot, 'aquarium-nitrite'],
    });
  });

  it('vuelve al preset por defecto si no hay nada útil', () => {
    const defaultPoolSlots = [...stripPresets.pool.parameterIds];
    expect(parseStoredConfiguration(null)).toEqual({ presetId: 'pool', padSlots: defaultPoolSlots });
    expect(parseStoredConfiguration('{roto')).toEqual({ presetId: 'pool', padSlots: defaultPoolSlots });
    expect(parseStoredConfiguration(JSON.stringify({ presetId: 'spa', padSlots: [] }))).toEqual({
      presetId: 'pool',
      padSlots: defaultPoolSlots,
    });
    expect(parseStoredConfiguration(JSON.stringify({ presetId: 'aquarium', padSlots: ['pool-ph'] }))).toEqual({
      presetId: 'aquarium',
      padSlots: [...stripPresets.aquarium.parameterIds],
    });
  });
});
