import { type LinearRgb, srgbToLinear } from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';

import { createRegionAverager, evaluateColorimeterFrame, type UserColorScale } from './colorimeterEngine';
import { createCardFromPreset, validateColorimeterCalibration } from './referenceCards';

function uniformRegion(meanLinear: LinearRgb, relativeNoise = 0): RegionColorStatistics {
  return {
    meanLinear,
    standardDeviationLinear: {
      red: meanLinear.red * relativeNoise,
      green: meanLinear.green * relativeNoise,
      blue: meanLinear.blue * relativeNoise,
    },
    sampledPixelCount: 400,
  };
}

/** Cámara simulada con un tinte cálido y algo de luz parásita. */
function simulateCamera(trueColor: LinearRgb): LinearRgb {
  return {
    red: 0.95 * trueColor.red + 0.05 * trueColor.green + 0.02,
    green: 0.8 * trueColor.green + 0.03 * trueColor.blue + 0.02,
    blue: 0.6 * trueColor.blue + 0.02 * trueColor.red + 0.03,
  };
}

const sixPatchCard = createCardFromPreset('colorchecker-six');
const trueSampleColor = srgbToLinear({ red: 150, green: 190, blue: 60 });

describe('evaluateColorimeterFrame', () => {
  it('con la tarjeta de 6 parches corrige el tinte de la cámara', () => {
    const referenceRegions = sixPatchCard.patches.map((patch) => {
      const hexValue = parseInt(patch.hexColor.slice(1), 16);
      const trueColor = srgbToLinear({ red: (hexValue >> 16) & 255, green: (hexValue >> 8) & 255, blue: hexValue & 255 });
      return uniformRegion(simulateCamera(trueColor));
    });
    const colorimeterReading = evaluateColorimeterFrame(
      uniformRegion(simulateCamera(trueSampleColor)),
      referenceRegions,
      sixPatchCard,
      null,
    );
    expect(colorimeterReading.correction?.model).toBe('affine');
    expect(colorimeterReading.usedPatchCount).toBe(6);
    expect(colorimeterReading.correctedSampleHex).toBe('#96BE3C');
    expect(colorimeterReading.rawSampleHex).not.toBe('#96BE3C');
    expect(colorimeterReading.isSampleUniform).toBe(true);
  });

  it('sin parches colocados mide sin corregir', () => {
    const colorimeterReading = evaluateColorimeterFrame(
      uniformRegion(trueSampleColor),
      [null, null, null, null, null, null],
      sixPatchCard,
      null,
    );
    expect(colorimeterReading.correction).toBeNull();
    expect(colorimeterReading.correctedSampleHex).toBe(colorimeterReading.rawSampleHex);
  });

  it('avisa si la región de muestra no es uniforme', () => {
    const colorimeterReading = evaluateColorimeterFrame(uniformRegion(trueSampleColor, 0.4), [], sixPatchCard, null);
    expect(colorimeterReading.isSampleUniform).toBe(false);
  });

  it('compara con la escala del usuario', () => {
    const phScale: UserColorScale = {
      id: 'ph',
      name: 'pH',
      unit: 'pH',
      entries: [
        { label: '6', value: 6, hexColor: '#96BE3C' },
        { label: '8', value: 8, hexColor: '#288C78' },
        { label: 'roto', value: 99, hexColor: 'no-es-un-color' },
      ],
    };
    const colorimeterReading = evaluateColorimeterFrame(uniformRegion(trueSampleColor), [], sixPatchCard, phScale);
    expect(colorimeterReading.scaleMatch?.nearestEntry.label).toBe('6');
    expect(colorimeterReading.scaleMatch?.nearestDeltaE).toBeLessThan(0.5);
    expect(colorimeterReading.scaleMatch?.rankedEntries).toHaveLength(2);
  });
});

describe('createRegionAverager', () => {
  it('promedia cada región ignorando los fotogramas en que falta', () => {
    const regionAverager = createRegionAverager(3);
    regionAverager.push([uniformRegion({ red: 0.2, green: 0.2, blue: 0.2 }), null]);
    regionAverager.push([uniformRegion({ red: 0.4, green: 0.4, blue: 0.4 }), uniformRegion({ red: 1, green: 1, blue: 1 })]);
    const averagedRegions = regionAverager.push([uniformRegion({ red: 0.6, green: 0.6, blue: 0.6 }), null]);
    expect(averagedRegions[0]!.meanLinear.red).toBeCloseTo(0.4);
    expect(averagedRegions[1]!.meanLinear.red).toBeCloseTo(1);
  });

  it('solo recuerda los últimos fotogramas', () => {
    const regionAverager = createRegionAverager(2);
    regionAverager.push([uniformRegion({ red: 0, green: 0, blue: 0 })]);
    regionAverager.push([uniformRegion({ red: 0.5, green: 0.5, blue: 0.5 })]);
    const averagedRegions = regionAverager.push([uniformRegion({ red: 1, green: 1, blue: 1 })]);
    expect(averagedRegions[0]!.meanLinear.red).toBeCloseTo(0.75);
  });
});

describe('validateColorimeterCalibration', () => {
  it('normaliza los colores y detecta el preajuste', () => {
    expect(
      validateColorimeterCalibration({
        card: { presetId: 'white-paper', patches: [{ id: 'white', name: ' Blanco ', hexColor: 'f2f2f2' }] },
      }),
    ).toEqual({ card: { presetId: 'white-paper', patches: [{ id: 'white', name: 'Blanco', hexColor: '#F2F2F2' }] } });
  });

  it('rechaza tarjetas vacías, demasiado grandes o con colores no válidos', () => {
    expect(() => validateColorimeterCalibration({ card: { presetId: 'custom', patches: [] } })).toThrow();
    expect(() =>
      validateColorimeterCalibration({ card: { presetId: 'custom', patches: [{ id: 'a', name: 'a', hexColor: 'rojo' }] } }),
    ).toThrow();
    const tooManyPatches = Array.from({ length: 9 }, (_, patchIndex) => ({ id: `${patchIndex}`, name: '', hexColor: '#000000' }));
    expect(() => validateColorimeterCalibration({ card: { presetId: 'custom', patches: tooManyPatches } })).toThrow();
  });
});
