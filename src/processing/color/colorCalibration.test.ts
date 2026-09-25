import {
  applyColorCorrection,
  bestModelForPatchCount,
  ColorCorrectionError,
  fitColorCorrection,
  type ReferencePatchMeasurement,
} from './colorCorrection';
import { deltaE2000 } from './colorDifference';
import { type LinearRgb, linearRgbToLab, srgbToLab, srgbToLinear } from './colorSpaces';
import { solveLeastSquares, solveLinearSystem } from './linearAlgebra';
import { createSrgbToLinearTable, measureRegionColor } from './regionSampling';
import { type ColorScaleEntry, matchColorAgainstScale } from './scaleMatching';

describe('solveLinearSystem', () => {
  it('resuelve un sistema 3×3 que necesita pivotar', () => {
    const solution = solveLinearSystem(
      [
        [0, 2, 1],
        [1, 1, 1],
        [2, 1, 3],
      ],
      [7, 6, 13],
    );
    expect(solution![0]).toBeCloseTo(1);
    expect(solution![1]).toBeCloseTo(2);
    expect(solution![2]).toBeCloseTo(3);
  });

  it('devuelve null si es singular', () => {
    expect(
      solveLinearSystem(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
  });

  it('mínimos cuadrados ajusta una recta con ruido simétrico', () => {
    const solution = solveLeastSquares(
      [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      [1.1, 2.9, 5.1, 6.9],
    );
    expect(solution![0]).toBeCloseTo(1.96, 6);
    expect(solution![1]).toBeCloseTo(1.06, 6);
  });
});

/** Simula una cámara: matriz de mezcla de canales + luz parásita. */
function simulateCamera(trueColor: LinearRgb): LinearRgb {
  return {
    red: 0.8 * trueColor.red + 0.1 * trueColor.green + 0.02 * trueColor.blue + 0.03,
    green: 0.05 * trueColor.red + 0.9 * trueColor.green + 0.05 * trueColor.blue + 0.02,
    blue: 0.02 * trueColor.red + 0.08 * trueColor.green + 0.7 * trueColor.blue + 0.04,
  };
}

const referenceCardColors: LinearRgb[] = [
  { red: 0.9, green: 0.9, blue: 0.9 },
  { red: 0.05, green: 0.05, blue: 0.05 },
  { red: 0.6, green: 0.1, blue: 0.1 },
  { red: 0.1, green: 0.5, blue: 0.15 },
  { red: 0.1, green: 0.15, blue: 0.6 },
  { red: 0.7, green: 0.6, blue: 0.1 },
];

const cardMeasurements: ReferencePatchMeasurement[] = referenceCardColors.map((referenceColor) => ({
  reference: referenceColor,
  measured: simulateCamera(referenceColor),
}));

describe('fitColorCorrection', () => {
  it('el modelo afín recupera exactamente una cámara afín', () => {
    const correction = fitColorCorrection(cardMeasurements, 'affine');
    expect(correction.maximumResidualDeltaE).toBeLessThan(1e-6);
    const unknownSample = { red: 0.3, green: 0.4, blue: 0.2 };
    const correctedSample = applyColorCorrection(correction, simulateCamera(unknownSample));
    expect(correctedSample.red).toBeCloseTo(unknownSample.red, 8);
    expect(correctedSample.green).toBeCloseTo(unknownSample.green, 8);
    expect(correctedSample.blue).toBeCloseTo(unknownSample.blue, 8);
  });

  it('cuantos más parámetros, menos error: sin corregir > lineal > afín', () => {
    const uncorrectedMeanDeltaE =
      cardMeasurements.reduce(
        (differenceSum, patch) => differenceSum + deltaE2000(linearRgbToLab(patch.measured), linearRgbToLab(patch.reference)),
        0,
      ) / cardMeasurements.length;
    const linearCorrection = fitColorCorrection(cardMeasurements, 'linear');
    const affineCorrection = fitColorCorrection(cardMeasurements, 'affine');
    expect(linearCorrection.meanResidualDeltaE).toBeLessThan(uncorrectedMeanDeltaE);
    expect(affineCorrection.meanResidualDeltaE).toBeLessThan(linearCorrection.meanResidualDeltaE);
  });

  it('con un solo parche, el balance de blancos deja ese parche perfecto', () => {
    const diagonalCorrection = fitColorCorrection(cardMeasurements.slice(0, 1), 'diagonal');
    expect(diagonalCorrection.maximumResidualDeltaE).toBeLessThan(1e-6);
    expect(diagonalCorrection.matrixRows[0].slice(1)).toEqual([0, 0, 0]);
  });

  it('exige suficientes parches y parches distintos', () => {
    expect(() => fitColorCorrection(cardMeasurements.slice(0, 3), 'affine')).toThrow(ColorCorrectionError);
    const identicalPatches = Array.from({ length: 4 }, () => cardMeasurements[0]!);
    expect(() => fitColorCorrection(identicalPatches, 'linear')).toThrow(ColorCorrectionError);
  });

  it('elige el mejor modelo según el número de parches', () => {
    expect(bestModelForPatchCount(0)).toBeNull();
    expect(bestModelForPatchCount(1)).toBe('diagonal');
    expect(bestModelForPatchCount(3)).toBe('linear');
    expect(bestModelForPatchCount(24)).toBe('affine');
  });
});

describe('measureRegionColor', () => {
  const frameWidth = 4;
  const frameHeight = 2;
  // Mitad izquierda roja, mitad derecha azul; con relleno al final de cada fila (bytesPerRow = 20).
  const bytesPerRow = 20;
  const rgbaPixels = new Uint8Array(bytesPerRow * frameHeight);
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex++) {
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex++) {
      const pixelStart = rowIndex * bytesPerRow + columnIndex * 4;
      rgbaPixels.set(columnIndex < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], pixelStart);
    }
  }
  const lookupTable = createSrgbToLinearTable();

  it('promedia solo la región pedida', () => {
    const regionStatistics = measureRegionColor(
      rgbaPixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      'rgba',
      { left: 0, top: 0, width: 0.5, height: 1 },
      lookupTable,
    );
    expect(regionStatistics).toMatchObject({ sampledPixelCount: 4, meanLinear: { red: 1, green: 0, blue: 0 } });
    expect(regionStatistics!.standardDeviationLinear.red).toBeCloseTo(0);
  });

  it('promedia en lineal y detecta regiones no uniformes', () => {
    const regionStatistics = measureRegionColor(
      rgbaPixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      'rgba',
      { left: 0, top: 0, width: 1, height: 1 },
      lookupTable,
    );
    expect(regionStatistics!.meanLinear).toEqual({ red: 0.5, green: 0, blue: 0.5 });
    expect(regionStatistics!.standardDeviationLinear.red).toBeCloseTo(0.5);
  });

  it('interpreta BGRA intercambiando rojo y azul', () => {
    const regionStatistics = measureRegionColor(
      rgbaPixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      'bgra',
      { left: 0, top: 0, width: 0.5, height: 1 },
      lookupTable,
    );
    expect(regionStatistics!.meanLinear).toEqual({ red: 0, green: 0, blue: 1 });
  });

  it('devuelve null para una región vacía o fuera del fotograma', () => {
    expect(
      measureRegionColor(rgbaPixels, frameWidth, frameHeight, bytesPerRow, 'rgba', { left: 2, top: 2, width: 1, height: 1 }, lookupTable),
    ).toBeNull();
  });

  it('la tabla coincide con la fórmula sRGB', () => {
    expect(lookupTable[128]).toBeCloseTo(srgbToLinear({ red: 128, green: 0, blue: 0 }).red, 12);
  });
});

describe('matchColorAgainstScale', () => {
  // Escala de pH de una tira ficticia: amarillo → verde → azul.
  const phScale: ColorScaleEntry[] = [
    { label: 'pH 4', value: 4, lab: srgbToLab({ red: 230, green: 200, blue: 40 }) },
    { label: 'pH 6', value: 6, lab: srgbToLab({ red: 150, green: 190, blue: 60 }) },
    { label: 'pH 8', value: 8, lab: srgbToLab({ red: 40, green: 140, blue: 120 }) },
    { label: 'pH 10', value: 10, lab: srgbToLab({ red: 30, green: 70, blue: 160 }) },
  ];

  it('una muestra idéntica a una entrada da ese valor con ΔE 0', () => {
    const scaleMatch = matchColorAgainstScale(phScale[2]!.lab, phScale);
    expect(scaleMatch!.nearestEntry.label).toBe('pH 8');
    expect(scaleMatch!.nearestDeltaE).toBeCloseTo(0);
    expect(scaleMatch!.interpolatedValue).toBeCloseTo(8);
  });

  it('interpola entre dos entradas consecutivas', () => {
    const midpointLab = {
      lightness: (phScale[1]!.lab.lightness + phScale[2]!.lab.lightness) / 2,
      greenRed: (phScale[1]!.lab.greenRed + phScale[2]!.lab.greenRed) / 2,
      blueYellow: (phScale[1]!.lab.blueYellow + phScale[2]!.lab.blueYellow) / 2,
    };
    const scaleMatch = matchColorAgainstScale(midpointLab, phScale);
    expect(scaleMatch!.interpolatedValue).toBeCloseTo(7, 5);
    expect(scaleMatch!.interpolationDeltaE).toBeCloseTo(0, 5);
    expect(scaleMatch!.rankedEntries).toHaveLength(4);
  });

  it('avisa con un ΔE alto si la muestra no se parece a la escala', () => {
    const scaleMatch = matchColorAgainstScale(srgbToLab({ red: 200, green: 30, blue: 180 }), phScale);
    expect(scaleMatch!.interpolationDeltaE).toBeGreaterThan(20);
  });

  it('devuelve null sin escala', () => {
    expect(matchColorAgainstScale(phScale[0]!.lab, [])).toBeNull();
  });
});
