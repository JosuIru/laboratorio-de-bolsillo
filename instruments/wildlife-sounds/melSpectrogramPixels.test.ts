import { percentileRange, renderMelSpectrogramPixels } from './melSpectrogramPixels';

// Paleta de grises: el nivel es el propio color.
const grayLookupTable = Uint8Array.from({ length: 256 * 3 }, (_, entryIndex) => Math.floor(entryIndex / 3));

describe('percentileRange', () => {
  it('ignora los extremos y los valores no finitos', () => {
    const values = Float32Array.from({ length: 1000 }, (_, valueIndex) => valueIndex);
    values[0] = Number.NaN;
    const { minimum, maximum } = percentileRange(values);
    expect(minimum).toBeCloseTo(51, 0);
    expect(maximum).toBeCloseTo(994, 0);
  });

  it('no devuelve un rango vacío', () => {
    expect(percentileRange(new Float32Array(4).fill(2))).toEqual({ minimum: 2, maximum: 3 });
    expect(percentileRange(new Float32Array(0))).toEqual({ minimum: 0, maximum: 1 });
  });
});

describe('renderMelSpectrogramPixels', () => {
  it('pone el tiempo en horizontal y los graves abajo', () => {
    // 2 tramas × 3 bandas: solo la banda más grave de la segunda trama suena.
    const melSpectrogram = Float32Array.from([0, 0, 0, 10, 0, 0]);
    const pixels = new Uint8Array(2 * 3 * 4);
    renderMelSpectrogramPixels(melSpectrogram, 2, 3, pixels, grayLookupTable);
    const levelAt = (column: number, row: number) => pixels[(row * 2 + column) * 4]!;
    expect(levelAt(1, 2)).toBe(255);
    expect(levelAt(0, 2)).toBe(0);
    expect(levelAt(1, 0)).toBe(0);
    expect(pixels[3]).toBe(255);
  });
});
