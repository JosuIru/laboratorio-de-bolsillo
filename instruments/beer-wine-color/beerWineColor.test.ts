import type { LinearRgb } from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';

import {
  deLangeAbsorbancePerSrm,
  describeBeerColor,
  describeWineColor,
  estimateBeerColor,
  estimateWineColor,
  isValidPathLengthMm,
  measureTransmittance,
  opticalPathLengthCm,
  predictBeerTransmittance,
  srmToEbc,
} from './beerWineColorEngine';

function uniformRegion(meanLinear: LinearRgb): RegionColorStatistics {
  return { meanLinear, standardDeviationLinear: { red: 0, green: 0, blue: 0 }, sampledPixelCount: 100 };
}

describe('modelo espectral de deLange', () => {
  it('a 430 nm, 1 cm de una cerveza de 12,7 SRM absorbe 1', () => {
    expect(deLangeAbsorbancePerSrm(430) * 12.7).toBeCloseTo(1, 6);
  });

  it('absorbe menos cuanto más rojo', () => {
    expect(deLangeAbsorbancePerSrm(610)).toBeLessThan(deLangeAbsorbancePerSrm(545));
    expect(deLangeAbsorbancePerSrm(545)).toBeLessThan(deLangeAbsorbancePerSrm(465));
  });

  it('la transmitancia prevista baja con el SRM y con la profundidad, y el azul se apaga antes', () => {
    const paleBeer = predictBeerTransmittance(4, 1);
    const darkBeer = predictBeerTransmittance(30, 1);
    const paleBeerDeeper = predictBeerTransmittance(4, 3);
    expect(darkBeer.red).toBeLessThan(paleBeer.red);
    expect(paleBeerDeeper.green).toBeLessThan(paleBeer.green);
    expect(paleBeer.blue).toBeLessThan(paleBeer.green);
    expect(paleBeer.green).toBeLessThan(paleBeer.red);
  });
});

describe('estimateBeerColor', () => {
  it.each([
    [2, 1],
    [6, 1],
    [15, 1],
    [35, 1],
    [10, 0.5],
    [60, 0.3],
  ])('recupera %s SRM a partir de su propia transmitancia (%s cm)', (trueSrm, pathLengthCm) => {
    const beerEstimate = estimateBeerColor(predictBeerTransmittance(trueSrm, pathLengthCm), pathLengthCm);
    expect(beerEstimate.srm).toBeCloseTo(trueSrm, 1);
    expect(beerEstimate.isFitPoor).toBe(false);
  });

  it('el agua sale a 0 SRM', () => {
    expect(estimateBeerColor({ red: 1, green: 1, blue: 1 }, 1).srm).toBeCloseTo(0, 1);
  });

  it('marca como mal ajuste un líquido que no se parece a una cerveza (azul)', () => {
    const blueLiquid = { red: 0.05, green: 0.3, blue: 0.9 };
    expect(estimateBeerColor(blueLiquid, 1).isFitPoor).toBe(true);
  });

  it('convierte a EBC y pone nombre al color', () => {
    expect(srmToEbc(10)).toBeCloseTo(19.7, 6);
    expect(describeBeerColor(2)).toBe('pale-straw');
    expect(describeBeerColor(7)).toBe('deep-gold');
    expect(describeBeerColor(22)).toBe('brown');
    expect(describeBeerColor(45)).toBe('black');
  });
});

describe('measureTransmittance', () => {
  it('divide la muestra entre el papel, canal a canal', () => {
    const { transmittance, problems } = measureTransmittance(
      uniformRegion({ red: 0.4, green: 0.2, blue: 0.05 }),
      uniformRegion({ red: 0.8, green: 0.8, blue: 0.5 }),
    );
    expect(transmittance.red).toBeCloseTo(0.5, 6);
    expect(transmittance.green).toBeCloseTo(0.25, 6);
    expect(transmittance.blue).toBeCloseTo(0.1, 6);
    expect(problems).toEqual([]);
  });

  it('avisa del papel quemado, del papel oscuro, de una muestra más clara que el papel y de un líquido opaco', () => {
    expect(
      measureTransmittance(uniformRegion({ red: 0.5, green: 0.5, blue: 0.5 }), uniformRegion({ red: 0.99, green: 0.9, blue: 0.9 }))
        .problems,
    ).toContain('paper-overexposed');
    expect(
      measureTransmittance(uniformRegion({ red: 0.02, green: 0.02, blue: 0.02 }), uniformRegion({ red: 0.05, green: 0.05, blue: 0.05 }))
        .problems,
    ).toContain('paper-underexposed');
    expect(
      measureTransmittance(uniformRegion({ red: 0.9, green: 0.9, blue: 0.9 }), uniformRegion({ red: 0.5, green: 0.5, blue: 0.5 }))
        .problems,
    ).toContain('sample-brighter-than-paper');
    expect(
      measureTransmittance(uniformRegion({ red: 0.01, green: 0.005, blue: 0.001 }), uniformRegion({ red: 0.8, green: 0.8, blue: 0.8 }))
        .problems,
    ).toContain('too-dark');
  });
});

describe('estimateWineColor', () => {
  it('calcula intensidad y tonalidad por centímetro', () => {
    // 2 mm de un tinto: absorbancias por cm azul 3, verde 5, rojo 1.
    const pathLengthCm = 0.2;
    const redWine = {
      blue: 10 ** (-3 * pathLengthCm),
      green: 10 ** (-5 * pathLengthCm),
      red: 10 ** (-1 * pathLengthCm),
    };
    const wineEstimate = estimateWineColor(redWine, pathLengthCm, 'red');
    expect(wineEstimate.colorIntensity).toBeCloseTo(9, 4);
    expect(wineEstimate.hue).toBeCloseTo(0.6, 4);
    expect(wineEstimate.descriptor).toBe('ruby');
  });

  it('no calcula la tonalidad de un blanco ni la de un vino cuyo verde apenas absorbe', () => {
    const paleWine = { red: 0.98, green: 0.97, blue: 0.8 };
    expect(estimateWineColor(paleWine, 2, 'white').hue).toBeNull();
    const roseWithNoisyGreen = { red: 1, green: 1.02, blue: 0.7 };
    const roseEstimate = estimateWineColor(roseWithNoisyGreen, 2, 'rose');
    expect(roseEstimate.hue).toBeNull();
    expect(roseEstimate.descriptor).toBe('onion-skin');
  });

  it('pone nombre según el tipo de vino', () => {
    expect(describeWineColor('white', 0.05, 2)).toBe('pale');
    expect(describeWineColor('white', 0.3, 2)).toBe('golden');
    expect(describeWineColor('rose', 0, 0.9)).toBe('salmon');
    expect(describeWineColor('red', 0, 0.5)).toBe('purple');
    expect(describeWineColor('red', 0, 1.2)).toBe('tawny');
  });
});

describe('opticalPathLengthCm', () => {
  it('la luz cruza el líquido dos veces: 10 mm de altura son 2 cm de camino', () => {
    expect(opticalPathLengthCm(10)).toBeCloseTo(2, 6);
  });
});

describe('isValidPathLengthMm', () => {
  it('acepta entre 0,5 y 100 mm', () => {
    expect(isValidPathLengthMm(10)).toBe(true);
    expect(isValidPathLengthMm(0.5)).toBe(true);
    expect(isValidPathLengthMm(0.4)).toBe(false);
    expect(isValidPathLengthMm(101)).toBe(false);
    expect(isValidPathLengthMm(null)).toBe(false);
    expect(isValidPathLengthMm(Number.NaN)).toBe(false);
  });
});
