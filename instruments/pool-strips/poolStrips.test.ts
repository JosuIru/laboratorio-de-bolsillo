import { srgbToLinear, hexToRgb8 } from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';

import { createCardFromPreset, defaultReferenceCard } from '@instruments/colorimeter/referenceCards';

import es from './locales/es.json';
import { poolStripsSchema } from './schema';
import {
  addPadSlot,
  buildCalibratedScale,
  buildStripMeasurementValues,
  classifyAgainstIdealRange,
  classifyMatchConfidence,
  computeStripGuideLayout,
  correctChartCellColors,
  createViewToCameraMapping,
  evaluateStripPads,
  formatIdealRange,
  mapViewPointToCamera,
  mapViewRectToCameraRegion,
  movePadSlot,
  removePadSlot,
  resolveStripScale,
} from './stripEngine';
import {
  ignoredPadSlot,
  maximumPadCount,
  type StripPadSlot,
  stripParameters,
  stripPresetIds,
  stripPresets,
} from './stripPresets';

/** Región uniforme del color dado (como si la cámara lo viera perfecto). */
function uniformRegion(hexColor: string): RegionColorStatistics {
  return {
    meanLinear: srgbToLinear(hexToRgb8(hexColor)!),
    standardDeviationLinear: { red: 0, green: 0, blue: 0 },
    sampledPixelCount: 100,
  };
}

/** Mezcla en sRGB de dos colores de la escala (aproxima un color intermedio). */
function mixHexColors(firstHex: string, secondHex: string, fraction: number): string {
  const firstColor = hexToRgb8(firstHex)!;
  const secondColor = hexToRgb8(secondHex)!;
  const mixComponent = (firstComponent: number, secondComponent: number) =>
    Math.round(firstComponent + fraction * (secondComponent - firstComponent))
      .toString(16)
      .padStart(2, '0');
  return `#${mixComponent(firstColor.red, secondColor.red)}${mixComponent(firstColor.green, secondColor.green)}${mixComponent(firstColor.blue, secondColor.blue)}`;
}

describe('presets y escalas orientativas', () => {
  it.each(stripPresetIds)('el preset %s solo usa parámetros válidos y sin repetir', (presetId) => {
    const parameterIds = stripPresets[presetId].parameterIds;
    expect(new Set(parameterIds).size).toBe(parameterIds.length);
    expect(parameterIds.length).toBeLessThanOrEqual(maximumPadCount);
    for (const parameterId of parameterIds) expect(parameterId.startsWith(`${presetId}-`)).toBe(true);
  });

  it.each(Object.values(stripParameters))('$id: escala creciente con colores válidos y rango dentro de la escala', (parameter) => {
    const scaleValues = parameter.defaultScale.map((level) => level.value);
    expect(scaleValues.length).toBeGreaterThanOrEqual(2);
    expect([...scaleValues].sort((leftValue, rightValue) => leftValue - rightValue)).toEqual(scaleValues);
    expect(new Set(scaleValues).size).toBe(scaleValues.length);
    for (const level of parameter.defaultScale) expect(hexToRgb8(level.hexColor)).not.toBeNull();
    const { minimum, maximum } = parameter.idealRange;
    expect(minimum !== null || maximum !== null).toBe(true);
    if (minimum !== null) expect(minimum).toBeGreaterThanOrEqual(scaleValues[0]!);
    if (maximum !== null) expect(maximum).toBeLessThanOrEqual(scaleValues[scaleValues.length - 1]!);
    if (minimum !== null && maximum !== null) expect(minimum).toBeLessThan(maximum);
  });

  it('hay consejo para cada lado del rango que se puede incumplir (y no sobra ninguno)', () => {
    const adviceByParameter = es.advice as Record<string, Record<string, string>>;
    for (const parameter of Object.values(stripParameters)) {
      const expectedStatuses = [
        ...(parameter.idealRange.minimum !== null ? ['low'] : []),
        ...(parameter.idealRange.maximum !== null ? ['high'] : []),
      ];
      expect(Object.keys(adviceByParameter[parameter.id] ?? {}).sort()).toEqual(expectedStatuses.sort());
    }
  });

  it('cada magnitud tiene nombre y columna en el esquema', () => {
    const schemaKeys = poolStripsSchema.fields.map((field) => field.key);
    for (const parameter of Object.values(stripParameters)) {
      expect(schemaKeys).toContain(parameter.quantity);
      expect(es.quantities).toHaveProperty(parameter.quantity);
    }
  });
});

describe('rango recomendado', () => {
  it('clasifica bajo, bien y alto, incluidos los límites', () => {
    const phRange = stripParameters['pool-ph'].idealRange;
    expect(classifyAgainstIdealRange(7.0, phRange)).toBe('low');
    expect(classifyAgainstIdealRange(7.2, phRange)).toBe('ideal');
    expect(classifyAgainstIdealRange(7.6, phRange)).toBe('ideal');
    expect(classifyAgainstIdealRange(7.8, phRange)).toBe('high');
  });

  it('sin límite inferior nunca es bajo', () => {
    const nitriteRange = stripParameters['aquarium-nitrite'].idealRange;
    expect(classifyAgainstIdealRange(0, nitriteRange)).toBe('ideal');
    expect(classifyAgainstIdealRange(0.5, nitriteRange)).toBe('high');
  });

  it('formatea el rango', () => {
    const formatNumber = (numericValue: number) => String(numericValue);
    expect(formatIdealRange({ minimum: 7.2, maximum: 7.6 }, formatNumber)).toBe('7.2–7.6');
    expect(formatIdealRange({ minimum: null, maximum: 25 }, formatNumber)).toBe('≤ 25');
    expect(formatIdealRange({ minimum: 3, maximum: null }, formatNumber)).toBe('≥ 3');
  });

  it('la confianza depende del ΔE', () => {
    expect(classifyMatchConfidence(2)).toBe('good');
    expect(classifyMatchConfidence(7)).toBe('fair');
    expect(classifyMatchConfidence(15)).toBe('poor');
  });
});

describe('orden de las almohadillas', () => {
  const padSlots: StripPadSlot[] = ['pool-ph', 'pool-free-chlorine', 'pool-total-alkalinity'];

  it('mueve, quita y añade', () => {
    expect(movePadSlot(padSlots, 0, 1)).toEqual(['pool-free-chlorine', 'pool-ph', 'pool-total-alkalinity']);
    expect(movePadSlot(padSlots, 0, -1)).toEqual(padSlots);
    expect(removePadSlot(padSlots, 1)).toEqual(['pool-ph', 'pool-total-alkalinity']);
    expect(removePadSlot(['pool-ph'], 0)).toEqual(['pool-ph']);
    expect(addPadSlot(padSlots, 'pool-cyanuric-acid')).toHaveLength(4);
  });

  it('no repite parámetros pero sí huecos, y respeta el máximo', () => {
    expect(addPadSlot(padSlots, 'pool-ph')).toEqual(padSlots);
    expect(addPadSlot(addPadSlot(padSlots, ignoredPadSlot), ignoredPadSlot)).toHaveLength(5);
    const fullSlots = new Array<StripPadSlot>(maximumPadCount).fill(ignoredPadSlot);
    expect(addPadSlot(fullSlots, 'pool-ph')).toHaveLength(maximumPadCount);
  });
});

describe('guía en pantalla', () => {
  it('reparte casillas iguales, centradas, y muestrea su centro', () => {
    const guideLayout = computeStripGuideLayout(400, 300, 4)!;
    expect(guideLayout.cellRects).toHaveLength(4);
    expect(guideLayout.guideRect.left + guideLayout.guideRect.width / 2).toBeCloseTo(200);
    expect(guideLayout.guideRect.top + guideLayout.guideRect.height / 2).toBeCloseTo(150);
    const [firstCell, secondCell] = guideLayout.cellRects;
    expect(secondCell!.left - firstCell!.left).toBeCloseTo(firstCell!.width);
    const firstSample = guideLayout.sampleRects[0]!;
    expect(firstSample.left + firstSample.width / 2).toBeCloseTo(firstCell!.left + firstCell!.width / 2);
    expect(firstSample.width).toBeLessThan(firstCell!.width);
  });

  it('no calcula nada sin tamaño o sin casillas', () => {
    expect(computeStripGuideLayout(0, 300, 4)).toBeNull();
    expect(computeStripGuideLayout(400, 300, 0)).toBeNull();
  });

  it('la transformación a cámara reproduce un giro de 90° con escala', () => {
    // Vista 200×100 que en la cámara aparece girada: x de la vista → y de la cámara.
    const convertViewPoint = (viewPoint: { x: number; y: number }) => ({ x: 1000 - viewPoint.y * 4, y: viewPoint.x * 4 });
    const mapping = createViewToCameraMapping(
      200,
      100,
      convertViewPoint({ x: 0, y: 0 }),
      convertViewPoint({ x: 200, y: 0 }),
      convertViewPoint({ x: 0, y: 100 }),
    )!;
    expect(mapViewPointToCamera(mapping, { x: 50, y: 30 })).toEqual(convertViewPoint({ x: 50, y: 30 }));
    const cameraRegion = mapViewRectToCameraRegion(mapping, { left: 10, top: 20, width: 30, height: 40 });
    expect(cameraRegion.secondCorner).toEqual(convertViewPoint({ x: 40, y: 60 }));
    expect(createViewToCameraMapping(0, 100, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
  });
});

describe('lectura de la tira', () => {
  const phScale = stripParameters['pool-ph'].defaultScale;
  const chlorineScale = stripParameters['pool-free-chlorine'].defaultScale;

  it('lee cada almohadilla con su escala, interpola y salta los huecos', () => {
    const padSlots: StripPadSlot[] = ['pool-ph', ignoredPadSlot, 'pool-free-chlorine'];
    const stripReading = evaluateStripPads(
      padSlots,
      [uniformRegion(phScale[3]!.hexColor), uniformRegion('#000000'), uniformRegion(chlorineScale[2]!.hexColor)],
      [],
      defaultReferenceCard,
      {},
    )!;
    expect(stripReading.padReadings.map((padReading) => padReading.slotIndex)).toEqual([0, 2]);
    const [phReading, chlorineReading] = stripReading.padReadings;
    expect(phReading!.estimatedValue).toBeCloseTo(7.8, 5);
    expect(phReading!.rangeStatus).toBe('high');
    expect(phReading!.confidence).toBe('good');
    expect(phReading!.isScaleCalibrated).toBe(false);
    expect(chlorineReading!.estimatedValue).toBeCloseTo(1, 5);
    expect(chlorineReading!.rangeStatus).toBe('ideal');
    expect(stripReading.correction).toBeNull();
  });

  it('un color intermedio da un valor intermedio', () => {
    const intermediateHex = mixHexColors(phScale[2]!.hexColor, phScale[3]!.hexColor, 0.5);
    const stripReading = evaluateStripPads(['pool-ph'], [uniformRegion(intermediateHex)], [], defaultReferenceCard, {})!;
    const estimatedPh = stripReading.padReadings[0]!.estimatedValue;
    expect(estimatedPh).toBeGreaterThan(7.3);
    expect(estimatedPh).toBeLessThan(7.7);
  });

  it('un color que no se parece a la escala tiene confianza baja', () => {
    const stripReading = evaluateStripPads(['pool-ph'], [uniformRegion('#1040FF')], [], defaultReferenceCard, {})!;
    expect(stripReading.padReadings[0]!.confidence).toBe('poor');
  });

  it('usa la escala calibrada si existe', () => {
    const calibratedScales = {
      'pool-ph': {
        levels: [
          { value: 6.8, hexColor: '#FFFF00' },
          { value: 8.2, hexColor: '#FF0000' },
        ],
        calibratedAt: 1,
      },
    };
    expect(resolveStripScale('pool-ph', calibratedScales).isCalibrated).toBe(true);
    const stripReading = evaluateStripPads(['pool-ph'], [uniformRegion('#FF0000')], [], defaultReferenceCard, calibratedScales)!;
    expect(stripReading.padReadings[0]!.estimatedValue).toBeCloseTo(8.2, 5);
    expect(stripReading.padReadings[0]!.isScaleCalibrated).toBe(true);
  });

  it('corrige con la tarjeta: una luz amarillenta no cambia el resultado', () => {
    const yellowishLight = { red: 1.1, green: 1.0, blue: 0.7 };
    const underYellowishLight = (hexColor: string): RegionColorStatistics => {
      const trueColor = uniformRegion(hexColor);
      return {
        ...trueColor,
        meanLinear: {
          red: trueColor.meanLinear.red * yellowishLight.red,
          green: trueColor.meanLinear.green * yellowishLight.green,
          blue: trueColor.meanLinear.blue * yellowishLight.blue,
        },
      };
    };
    const whitePaperCard = createCardFromPreset('white-paper');
    const measuredPaper = underYellowishLight(whitePaperCard.patches[0]!.hexColor);
    const stripReading = evaluateStripPads(
      ['pool-free-chlorine'],
      [underYellowishLight(chlorineScale[3]!.hexColor)],
      [measuredPaper],
      whitePaperCard,
      {},
    )!;
    expect(stripReading.correction?.model).toBe('diagonal');
    expect(stripReading.padReadings[0]!.estimatedValue).toBeCloseTo(3, 1);
  });

  it('devuelve null si no hay ninguna almohadilla medida', () => {
    expect(evaluateStripPads(['pool-ph'], [null], [], defaultReferenceCard, {})).toBeNull();
    expect(evaluateStripPads([ignoredPadSlot], [uniformRegion('#FFFFFF')], [], defaultReferenceCard, {})).toBeNull();
  });

  it('prepara una medición que cumple el esquema', () => {
    const stripReading = evaluateStripPads(
      ['pool-ph', 'pool-free-chlorine'],
      [uniformRegion(phScale[1]!.hexColor), uniformRegion(chlorineScale[3]!.hexColor)],
      [],
      defaultReferenceCard,
      {},
    )!;
    const measurementValues = buildStripMeasurementValues('pool', stripReading, 31.6);
    expect(measurementValues).toMatchObject({
      stripType: 'pool',
      ph: 6.8,
      freeChlorine: 3,
      padOrder: 'pool-ph,pool-free-chlorine',
      outOfRangeParameters: 'ph:low',
      padScaleSources: 'default,default',
      secondsAfterDip: 32,
      correctionModel: 'none',
      referencePatchCount: 0,
    });
    expect(measurementValues.padColors.split(',')).toHaveLength(2);
    expect(() => poolStripsSchema.validate(measurementValues)).not.toThrow();
    expect(buildStripMeasurementValues('pool', stripReading, null)).not.toHaveProperty('secondsAfterDip');
  });
});

describe('calibrar escalas con la carta', () => {
  it('ordena por valor los colores medidos', () => {
    expect(buildCalibratedScale([7.6, 6.8, 7.2], ['#AA0000', '#FFFF00', '#FF8800'], 5)).toEqual({
      levels: [
        { value: 6.8, hexColor: '#FFFF00' },
        { value: 7.2, hexColor: '#FF8800' },
        { value: 7.6, hexColor: '#AA0000' },
      ],
      calibratedAt: 5,
    });
  });

  it('explica por qué no se puede guardar', () => {
    expect(buildCalibratedScale([7], ['#FFFF00'], 0)).toBe('too-few-levels');
    expect(buildCalibratedScale([7, null], ['#FFFF00', '#FF0000'], 0)).toBe('invalid-value');
    expect(buildCalibratedScale([7, 7], ['#FFFF00', '#FF0000'], 0)).toBe('repeated-value');
    expect(buildCalibratedScale([7, 8], ['#FFFF00', null], 0)).toBe('missing-color');
    expect(buildCalibratedScale([7, 8], ['#FFFF00'], 0)).toBe('missing-color');
  });

  it('corrige el color de cada casilla de la carta', () => {
    expect(correctChartCellColors([uniformRegion('#336699'), null], [], defaultReferenceCard)).toEqual(['#336699', null]);
  });
});
