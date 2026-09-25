import { deltaE2000, deltaE76 } from './colorDifference';
import { hexToRgb8, labToSrgb, type Lab, rgb8ToHex, srgbToLab, srgbToLinear } from './colorSpaces';

function expectLabCloseTo(actualColor: Lab, expectedColor: Lab, fractionDigits = 2) {
  expect(actualColor.lightness).toBeCloseTo(expectedColor.lightness, fractionDigits);
  expect(actualColor.greenRed).toBeCloseTo(expectedColor.greenRed, fractionDigits);
  expect(actualColor.blueYellow).toBeCloseTo(expectedColor.blueYellow, fractionDigits);
}

describe('sRGB → CIELAB (D65)', () => {
  it.each([
    ['blanco', { red: 255, green: 255, blue: 255 }, { lightness: 100, greenRed: 0, blueYellow: 0 }],
    ['negro', { red: 0, green: 0, blue: 0 }, { lightness: 0, greenRed: 0, blueYellow: 0 }],
    ['rojo', { red: 255, green: 0, blue: 0 }, { lightness: 53.2408, greenRed: 80.0925, blueYellow: 67.2032 }],
    ['verde', { red: 0, green: 255, blue: 0 }, { lightness: 87.7347, greenRed: -86.1827, blueYellow: 83.1793 }],
    ['azul', { red: 0, green: 0, blue: 255 }, { lightness: 32.297, greenRed: 79.1875, blueYellow: -107.8602 }],
    ['gris medio', { red: 128, green: 128, blue: 128 }, { lightness: 53.5850, greenRed: 0, blueYellow: 0 }],
  ])('%s', (_colorName, srgbColor, expectedLab) => {
    expectLabCloseTo(srgbToLab(srgbColor), expectedLab, 1);
  });

  it('la conversión de ida y vuelta conserva el color', () => {
    for (const srgbColor of [
      { red: 12, green: 200, blue: 90 },
      { red: 250, green: 3, blue: 128 },
      { red: 77, green: 77, blue: 77 },
    ]) {
      const recoveredColor = labToSrgb(srgbToLab(srgbColor));
      expect(recoveredColor.red).toBeCloseTo(srgbColor.red, 3);
      expect(recoveredColor.green).toBeCloseTo(srgbColor.green, 3);
      expect(recoveredColor.blue).toBeCloseTo(srgbColor.blue, 3);
    }
  });

  it('la linealización sRGB tiene el tramo lineal y el de potencia', () => {
    expect(srgbToLinear({ red: 10, green: 128, blue: 255 }).red).toBeCloseTo(10 / 255 / 12.92, 8);
    expect(srgbToLinear({ red: 10, green: 128, blue: 255 }).green).toBeCloseTo(0.2158605, 6);
  });
});

describe('hex', () => {
  it('ida y vuelta, en mayúsculas y acotado', () => {
    expect(rgb8ToHex({ red: 255, green: 128.4, blue: 0 })).toBe('#FF8000');
    expect(rgb8ToHex({ red: 300, green: -4, blue: 15 })).toBe('#FF000F');
    expect(hexToRgb8('#ff8000')).toEqual({ red: 255, green: 128, blue: 0 });
    expect(hexToRgb8('rojo')).toBeNull();
  });
});

describe('deltaE76', () => {
  it('es la distancia euclídea', () => {
    expect(
      deltaE76({ lightness: 50, greenRed: 0, blueYellow: 0 }, { lightness: 53, greenRed: 4, blueYellow: 0 }),
    ).toBeCloseTo(5);
  });
});

describe('deltaE2000', () => {
  // Pares de prueba de Sharma, Wu y Dalal (2005), "The CIEDE2000 Color-Difference Formula".
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ])('%j vs %j → %f', (firstLabValues, secondLabValues, expectedDifference) => {
    const toLab = ([lightness, greenRed, blueYellow]: number[]): Lab => ({
      lightness: lightness!,
      greenRed: greenRed!,
      blueYellow: blueYellow!,
    });
    expect(deltaE2000(toLab(firstLabValues), toLab(secondLabValues))).toBeCloseTo(expectedDifference, 4);
    // Es simétrica.
    expect(deltaE2000(toLab(secondLabValues), toLab(firstLabValues))).toBeCloseTo(expectedDifference, 4);
  });

  it('es 0 para colores idénticos', () => {
    const labColor = { lightness: 40, greenRed: 20, blueYellow: -10 };
    expect(deltaE2000(labColor, labColor)).toBe(0);
  });
});
