import { type BayerPattern, extractGreenChannel, isGreenSite } from './greenChannelMono';

const mosaicWidth = 8;
const mosaicHeight = 6;
const blackLevel = 64;
const whiteLevel = 1023;

/** Verde verdadero: una rampa (la interpolación lineal debe reproducirla exactamente). */
function trueGreenCounts(columnIndex: number, rowIndex: number): number {
  return 200 + 30 * columnIndex + 50 * rowIndex;
}

/** Mosaico de 10 bits: verde de la rampa y rojo/azul con valores muy distintos (no deben colarse). */
function buildMosaic(pattern: BayerPattern): Uint16Array {
  const mosaicValues = new Uint16Array(mosaicWidth * mosaicHeight);
  for (let rowIndex = 0; rowIndex < mosaicHeight; rowIndex++) {
    for (let columnIndex = 0; columnIndex < mosaicWidth; columnIndex++) {
      mosaicValues[rowIndex * mosaicWidth + columnIndex] = isGreenSite(pattern, columnIndex, rowIndex)
        ? trueGreenCounts(columnIndex, rowIndex)
        : 1000 - ((columnIndex * 7 + rowIndex * 13) % 90);
    }
  }
  return mosaicValues;
}

const normalize = (counts: number) => (counts - blackLevel) / (whiteLevel - blackLevel);

describe('canal verde de un RAW', () => {
  it('sitúa los verdes según el patrón', () => {
    expect(isGreenSite('RGGB', 0, 0)).toBe(false);
    expect(isGreenSite('RGGB', 1, 0)).toBe(true);
    expect(isGreenSite('BGGR', 0, 1)).toBe(true);
    expect(isGreenSite('GRBG', 0, 0)).toBe(true);
    expect(isGreenSite('GBRG', 1, 1)).toBe(true);
  });

  it.each(['RGGB', 'BGGR', 'GRBG', 'GBRG'] as const)('media resolución: media de los dos verdes de cada celda (%s)', (pattern) => {
    const greenImage = extractGreenChannel(buildMosaic(pattern), mosaicWidth, mosaicHeight, { pattern, blackLevel, whiteLevel });
    expect(greenImage.width).toBe(mosaicWidth / 2);
    expect(greenImage.height).toBe(mosaicHeight / 2);
    // En una rampa, la media de dos verdes en diagonal vale lo mismo que el centro de la celda.
    for (let cellRow = 0; cellRow < mosaicHeight / 2; cellRow++) {
      for (let cellColumn = 0; cellColumn < mosaicWidth / 2; cellColumn++) {
        const cellCenterCounts = trueGreenCounts(2 * cellColumn + 0.5, 2 * cellRow + 0.5);
        expect(greenImage.values[cellRow * (mosaicWidth / 2) + cellColumn]).toBeCloseTo(normalize(cellCenterCounts), 5);
      }
    }
  });

  it.each(['RGGB', 'BGGR'] as const)('resolución completa: conserva los verdes e interpola el resto (%s)', (pattern) => {
    const greenImage = extractGreenChannel(buildMosaic(pattern), mosaicWidth, mosaicHeight, {
      pattern,
      blackLevel,
      whiteLevel,
      mode: 'fullResolution',
    });
    expect(greenImage.width).toBe(mosaicWidth);
    // Lejos del borde la rampa se reproduce exactamente en todos los píxeles.
    for (let rowIndex = 1; rowIndex < mosaicHeight - 1; rowIndex++) {
      for (let columnIndex = 1; columnIndex < mosaicWidth - 1; columnIndex++) {
        expect(greenImage.values[rowIndex * mosaicWidth + columnIndex]).toBeCloseTo(normalize(trueGreenCounts(columnIndex, rowIndex)), 5);
      }
    }
  });

  it('interpola a lo largo de un borde, no a través', () => {
    // Borde vertical: columnas 0-3 oscuras y 4-7 brillantes, solo verdes (el resto a 0).
    const pattern = 'RGGB';
    const mosaicValues = new Uint16Array(mosaicWidth * mosaicHeight);
    for (let rowIndex = 0; rowIndex < mosaicHeight; rowIndex++) {
      for (let columnIndex = 0; columnIndex < mosaicWidth; columnIndex++) {
        if (isGreenSite(pattern, columnIndex, rowIndex)) mosaicValues[rowIndex * mosaicWidth + columnIndex] = columnIndex < 4 ? 100 : 900;
      }
    }
    const greenImage = extractGreenChannel(mosaicValues, mosaicWidth, mosaicHeight, { pattern, blackLevel, whiteLevel, mode: 'fullResolution' });
    // (3, 3) es un sitio no verde junto al borde: debe valer lo oscuro (vecinos de arriba y abajo).
    expect(isGreenSite(pattern, 3, 3)).toBe(false);
    expect(greenImage.values[3 * mosaicWidth + 3]).toBeCloseTo(normalize(100), 5);
  });

  it('rechaza tamaños incoherentes', () => {
    expect(() => extractGreenChannel(new Uint16Array(10), 4, 4)).toThrow();
    expect(() => extractGreenChannel(new Uint16Array(9), 3, 3)).toThrow();
  });
});
