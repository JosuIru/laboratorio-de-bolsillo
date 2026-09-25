import { parseStoredScales } from './scaleStorage';

describe('parseStoredScales', () => {
  it('lee escalas válidas y descarta entradas corruptas', () => {
    const storedText = JSON.stringify([
      {
        id: 'ph',
        name: 'pH',
        unit: 'pH',
        entries: [
          { label: '6', value: 6, hexColor: '#96BE3C' },
          { label: 'sin color', value: 7, hexColor: 'verde' },
          { label: 'sin valor', value: 'ocho', hexColor: '#288C78' },
        ],
      },
      { id: 42, name: 'id no válido' },
      { id: 'cloro', name: 'Cloro' },
    ]);
    expect(parseStoredScales(storedText)).toEqual([
      { id: 'ph', name: 'pH', unit: 'pH', entries: [{ label: '6', value: 6, hexColor: '#96BE3C' }] },
      { id: 'cloro', name: 'Cloro', unit: '', entries: [] },
    ]);
  });

  it('devuelve una lista vacía si no hay nada o el JSON está roto', () => {
    expect(parseStoredScales(null)).toEqual([]);
    expect(parseStoredScales('{roto')).toEqual([]);
    expect(parseStoredScales('{"no":"es una lista"}')).toEqual([]);
  });
});
