import { formatGrams, funEquivalences } from './formatting';

describe('formatGrams', () => {
  it('usa un decimal solo para masas pequeñas y no escribe «-0»', () => {
    expect(formatGrams(7.54)).toBe((7.5).toLocaleString());
    expect(formatGrams(23.6)).toBe('24');
    expect(formatGrams(-0.01)).toBe('0');
  });
});

describe('funEquivalences', () => {
  it('compara con monedas de 1 € y folios', () => {
    expect(funEquivalences(15)).toEqual({ oneEuroCoins: 2, a4Sheets: 3 });
    expect(funEquivalences(0)).toBeNull();
    expect(funEquivalences(-4)).toBeNull();
  });
});
