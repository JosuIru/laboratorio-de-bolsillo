import { createMagnificationEngine, type GridFrame } from './magnificationEngine';
import {
  centeredMeasurementRegion,
  containFrameInView,
  placeMeasurementRegion,
  regionCellBounds,
  regionToViewRectangle,
  viewPointToFrameFractions,
} from './measurementRegion';
import { extractRegion } from './dominantFrequency';
import {
  createMotionMapState,
  exponentialSmoothingWeight,
  infernoColor,
  lockInAmplitudeAndPhase,
  phaseHueColor,
  renderHeatMapRgba,
  renderPhaseMapRgba,
  robustAmplitudeStatistics,
  setLockInFrequency,
  smoothDisplayMaximum,
  updateMotionMaps,
} from './motionMaps';

/** Generador pseudoaleatorio reproducible (LCG) con salida gaussiana aproximada. */
function createNoiseGenerator(seed: number) {
  let generatorState = seed >>> 0;
  const nextUniform = () => {
    generatorState = (Math.imul(generatorState, 1664525) + 1013904223) >>> 0;
    return generatorState / 4294967296;
  };
  return () => nextUniform() + nextUniform() + nextUniform() + nextUniform() - 2;
}

/** Diferencia entre dos ángulos, en grados y dentro de 0-180. */
function angularDistanceDegrees(firstRadians: number, secondRadians: number): number {
  const differenceDegrees = Math.abs(((((firstRadians - secondRadians) * 180) / Math.PI) % 360 + 540) % 360 - 180);
  return differenceDegrees;
}

/** Tono (0-360°) de un color RGB. */
function hueDegreesOf(red: number, green: number, blue: number): number {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  if (maximum === minimum) return 0;
  let hueDegrees: number;
  if (maximum === red) hueDegrees = (60 * (green - blue)) / (maximum - minimum);
  else if (maximum === green) hueDegrees = 120 + (60 * (blue - red)) / (maximum - minimum);
  else hueDegrees = 240 + (60 * (red - green)) / (maximum - minimum);
  return (hueDegrees + 360) % 360;
}

function hueDistanceDegrees(firstHue: number, secondHue: number): number {
  const difference = Math.abs(firstHue - secondHue) % 360;
  return difference > 180 ? 360 - difference : difference;
}

describe('zona de medida', () => {
  it('centrada coincide con el antiguo tercio central', () => {
    expect(regionCellBounds(6, 3, centeredMeasurementRegion)).toEqual({
      firstColumn: 2,
      firstRow: 1,
      regionWidth: 2,
      regionHeight: 1,
    });
    expect(regionCellBounds(48, 64, centeredMeasurementRegion)).toEqual({
      firstColumn: 16,
      firstRow: 21,
      regionWidth: 16,
      regionHeight: 21,
    });
  });

  it('se mueve sin salirse del fotograma y extrae las celdas de ese sitio', () => {
    const cornerRegion = placeMeasurementRegion(0, 1);
    expect(cornerRegion.centerXFraction).toBeCloseTo(1 / 6);
    expect(cornerRegion.centerYFraction).toBeCloseTo(5 / 6);
    expect(regionCellBounds(6, 3, cornerRegion)).toEqual({ firstColumn: 0, firstRow: 2, regionWidth: 2, regionHeight: 1 });
    // Canal 1 = índice del píxel.
    const gridPixels = new Float32Array(6 * 3 * 2);
    for (let pixelIndex = 0; pixelIndex < 18; pixelIndex++) gridPixels[pixelIndex * 2 + 1] = pixelIndex;
    expect(Array.from(extractRegion(gridPixels, 6, 3, 2, 1, cornerRegion))).toEqual([12, 13]);
    expect(placeMeasurementRegion(Number.NaN, 0.5).centerXFraction).toBe(0.5);
  });

  it('pasa un toque de la vista a fracciones del fotograma (con bandas negras de contain)', () => {
    // Fotograma 3:4 en una vista de 400 × 400: ocupa 300 × 400 centrado.
    const frameRectangle = containFrameInView(400, 400, 480, 640)!;
    expect(frameRectangle).toEqual({ left: 50, top: 0, width: 300, height: 400 });
    const tapFractions = viewPointToFrameFractions(125, 100, frameRectangle);
    expect(tapFractions.xFraction).toBeCloseTo(0.25);
    expect(tapFractions.yFraction).toBeCloseTo(0.25);
    const regionRectangle = regionToViewRectangle(placeMeasurementRegion(0.5, 0.5), frameRectangle);
    expect(regionRectangle.left).toBeCloseTo(150);
    expect(regionRectangle.width).toBeCloseTo(100);
    expect(containFrameInView(0, 400, 480, 640)).toBeNull();
  });
});

describe('herramientas de los mapas', () => {
  it('la media exponencial arranca sin sesgo y luego usa la constante de tiempo', () => {
    expect(exponentialSmoothingWeight(0.1, 2, 0.1)).toBe(1);
    expect(exponentialSmoothingWeight(0.1, 2, 0.4)).toBeCloseTo(0.25);
    expect(exponentialSmoothingWeight(0.1, 2)).toBeCloseTo(1 - Math.exp(-0.05));
  });

  it('mediana y percentil alto con el histograma', () => {
    const values = Float32Array.from({ length: 1000 }, (_unused, valueIndex) => valueIndex / 999);
    const statistics = robustAmplitudeStatistics(values, values.length);
    expect(statistics.median).toBeCloseTo(0.5, 1);
    expect(statistics.upper).toBeCloseTo(0.98, 1);
    expect(statistics.lower).toBeCloseTo(0.1, 1);
    expect(robustAmplitudeStatistics(new Float32Array(10), 10)).toEqual({ lower: 0, median: 0, upper: 0 });
  });

  it('el máximo de la escala sube deprisa y baja despacio', () => {
    expect(smoothDisplayMaximum(1, 2, 0.3)).toBeGreaterThan(1.6);
    expect(smoothDisplayMaximum(2, 1, 0.3)).toBeGreaterThan(1.9);
    expect(smoothDisplayMaximum(0, 5, 0.03)).toBe(5);
  });

  it('inferno va de negro a amarillo pálido, y la rueda de fase da tonos opuestos a π', () => {
    const darkestColor = infernoColor(0);
    const brightestColor = infernoColor(1);
    expect(Math.max(...darkestColor)).toBeLessThan(10);
    expect(brightestColor[0]).toBeGreaterThan(240);
    expect(brightestColor[1]).toBeGreaterThan(240);
    expect(brightestColor[2]).toBeGreaterThan(140);
    // Luminosidad creciente (perceptual).
    const luminanceOf = ([red, green, blue]: [number, number, number]) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    for (let step = 1; step <= 10; step++) {
      expect(luminanceOf(infernoColor(step / 10))).toBeGreaterThan(luminanceOf(infernoColor((step - 1) / 10)));
    }
    expect(phaseHueColor(0)).toEqual([255, 0, 0]);
    expect(phaseHueColor(Math.PI)).toEqual([0, 255, 255]);
    expect(phaseHueColor(2 * Math.PI)).toEqual([255, 0, 0]);
    expect(phaseHueColor(-Math.PI / 2)).toEqual(phaseHueColor((3 * Math.PI) / 2));
  });
});

describe('mapas de calor y de fase', () => {
  const gridWidth = 8;
  const gridHeight = 4;
  const framesPerSecond = 30;
  const signalFrequencyHz = 1.2;
  const signalAmplitude = 0.5;

  /**
   * Rejilla de 8 × 4: columnas 0-2 oscilan con +A·sin, columnas 5-7 con −A·sin (contrafase) y las
   * columnas 3-4 solo tienen ruido.
   */
  function fillAntiphaseFrame(frameIndex: number, generateNoise: () => number, frameValues: Float32Array) {
    const oscillation = signalAmplitude * Math.sin(2 * Math.PI * signalFrequencyHz * (frameIndex / framesPerSecond));
    for (let row = 0; row < gridHeight; row++) {
      for (let column = 0; column < gridWidth; column++) {
        const zoneSign = column <= 2 ? 1 : column >= 5 ? -1 : 0;
        frameValues[row * gridWidth + column] = zoneSign * oscillation + 0.05 * generateNoise();
      }
    }
  }

  it('RMS y lock-in: amplitud correcta y dos zonas en contrafase con tonos opuestos', () => {
    const motionMapState = createMotionMapState(gridWidth, gridHeight);
    // f0 un poco desviada (como la que da la FFT): la fase relativa a la zona sigue valiendo.
    setLockInFrequency(motionMapState, 1.25);
    const generateNoise = createNoiseGenerator(3);
    const frameValues = new Float32Array(gridWidth * gridHeight);
    for (let frameIndex = 0; frameIndex < framesPerSecond * 12; frameIndex++) {
      fillAntiphaseFrame(frameIndex, generateNoise, frameValues);
      updateMotionMaps(motionMapState, frameValues, 1, 0, frameIndex / framesPerSecond, 1 / framesPerSecond, 1.5);
    }
    // RMS de una senoide = A/√2.
    expect(Math.sqrt(motionMapState.meanSquares[0]!)).toBeCloseTo(signalAmplitude / Math.SQRT2, 1);
    expect(Math.sqrt(motionMapState.meanSquares[3]!)).toBeLessThan(0.1);

    const leftCell = lockInAmplitudeAndPhase(motionMapState, 1 * gridWidth + 1);
    const rightCell = lockInAmplitudeAndPhase(motionMapState, 1 * gridWidth + 6);
    const noiseCell = lockInAmplitudeAndPhase(motionMapState, 1 * gridWidth + 3);
    expect(leftCell.amplitude).toBeGreaterThan(0.3);
    expect(rightCell.amplitude).toBeGreaterThan(0.3);
    expect(noiseCell.amplitude).toBeLessThan(0.1);
    expect(angularDistanceDegrees(leftCell.phaseRadians, rightCell.phaseRadians)).toBeGreaterThan(170);

    // Pintado con la zona de medida sobre la mitad izquierda: izquierda roja, derecha cian.
    const phaseMapRgba = new Uint8Array(gridWidth * gridHeight * 4);
    const leftRegionBounds = regionCellBounds(gridWidth, gridHeight, placeMeasurementRegion(0.1, 0.5));
    expect(renderPhaseMapRgba(motionMapState, leftRegionBounds, 1 / framesPerSecond, phaseMapRgba)).toBe(true);
    const colorAt = (column: number) => {
      const byteOffset = (1 * gridWidth + column) * 4;
      return Array.from(phaseMapRgba.slice(byteOffset, byteOffset + 4)) as [number, number, number, number];
    };
    const [leftRed, leftGreen, leftBlue, leftAlpha] = colorAt(1);
    const [rightRed, rightGreen, rightBlue, rightAlpha] = colorAt(6);
    expect(leftAlpha).toBeGreaterThan(150);
    expect(rightAlpha).toBeGreaterThan(150);
    expect(colorAt(3)[3]).toBe(0);
    expect(hueDistanceDegrees(hueDegreesOf(leftRed, leftGreen, leftBlue), 0)).toBeLessThan(15);
    expect(hueDistanceDegrees(hueDegreesOf(leftRed, leftGreen, leftBlue), hueDegreesOf(rightRed, rightGreen, rightBlue))).toBeGreaterThan(165);

    // Mapa de calor: las dos zonas brillantes y opacas, el centro (ruido) casi transparente.
    const heatMapRgba = new Uint8Array(gridWidth * gridHeight * 4);
    renderHeatMapRgba(motionMapState, 1 / framesPerSecond, heatMapRgba);
    const heatAlphaAt = (column: number) => heatMapRgba[(1 * gridWidth + column) * 4 + 3]!;
    expect(heatAlphaAt(0)).toBeGreaterThan(150);
    expect(heatAlphaAt(7)).toBeGreaterThan(150);
    expect(heatAlphaAt(4)).toBeLessThan(20);
  });

  it('sin f0 no hay mapa de fase; un cambio grande de f0 olvida lo promediado', () => {
    const motionMapState = createMotionMapState(2, 1);
    const phaseMapRgba = new Uint8Array(2 * 4);
    const wholeGridBounds = { firstColumn: 0, firstRow: 0, regionWidth: 2, regionHeight: 1 };
    expect(renderPhaseMapRgba(motionMapState, wholeGridBounds, 0.03, phaseMapRgba)).toBe(false);
    setLockInFrequency(motionMapState, 2);
    updateMotionMaps(motionMapState, Float32Array.from([1, 1]), 1, 0, 0, 0.03, 1);
    expect(motionMapState.inPhaseAverages[0]).toBeCloseTo(1);
    setLockInFrequency(motionMapState, 2.1);
    expect(motionMapState.inPhaseAverages[0]).toBeCloseTo(1);
    setLockInFrequency(motionMapState, 3);
    expect(motionMapState.inPhaseAverages[0]).toBe(0);
  });
});

describe('motor: zona de medida, monitor y mapa de fase', () => {
  /**
   * Vídeo sintético de luminancia a 30 fotogramas/s (nivel de 8 × 6, base de 16 × 12): la mitad
   * izquierda oscila a 5 Hz y la derecha igual pero en contrafase, como dos lados de una pieza
   * que vibra.
   */
  function createAntiphaseVibrationFrame(frameIndex: number, generateNoise: () => number): GridFrame {
    const oscillation = 0.6 * Math.sin(2 * Math.PI * 5 * (frameIndex / 30));
    const levelPixels = new Float32Array(8 * 6);
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 8; column++) {
        levelPixels[row * 8 + column] = 120 + (column < 4 ? oscillation : -oscillation) + 0.1 * generateNoise();
      }
    }
    return {
      rawTimestamp: 1_000_000_000 + frameIndex * 33_333_333,
      baseRgb: new Uint8Array(16 * 12 * 3).fill(120),
      baseWidth: 16,
      baseHeight: 12,
      levelPixels,
      levelWidth: 8,
      levelHeight: 6,
      levelChannelCount: 1,
    };
  }

  it('mide en la zona elegida, da la señal en vivo y pinta las dos mitades con tonos opuestos', () => {
    const magnificationEngine = createMagnificationEngine({
      lowCutoffHz: 2,
      highCutoffHz: 8,
      amplifiedSignal: 'luminance',
      amplificationFactor: 20,
      maximumAddedLevels: 80,
      measurementWindowSeconds: 8,
      pixelCombination: 'incoherent',
    });
    const generateNoise = createNoiseGenerator(11);
    const outputRequest = { wantsAmplifiedImage: false, wantsHeatMap: true, wantsPhaseMap: true };
    let frameIndex = 0;
    let lastFrame = magnificationEngine.processFrame(createAntiphaseVibrationFrame(frameIndex++, generateNoise), outputRequest);
    for (; frameIndex < 30 * 8; frameIndex++) {
      lastFrame = magnificationEngine.processFrame(createAntiphaseVibrationFrame(frameIndex, generateNoise), outputRequest);
    }
    expect(lastFrame.regionFilteredMean).not.toBeNull();
    expect(lastFrame.heatMapRgba).not.toBeNull();
    // Sin f0 todavía no hay mapa de fase.
    expect(lastFrame.phaseMapRgba).toBeNull();

    const estimate = magnificationEngine.estimateFrequency();
    expect(estimate!.frequencyHz).toBeCloseTo(5, 0);
    magnificationEngine.setLockInFrequency(estimate!.frequencyHz);

    // La zona, sobre la mitad izquierda: vacía la historia de la medida.
    magnificationEngine.setMeasurementRegionCenter(0.2, 0.5);
    expect(magnificationEngine.measurementProgress().storedSeconds).toBe(0);
    expect(magnificationEngine.measurementRegion().centerXFraction).toBeCloseTo(0.2);

    const liveSignal: number[] = [];
    for (const lastFrameIndex = frameIndex + 30 * 6; frameIndex < lastFrameIndex; frameIndex++) {
      lastFrame = magnificationEngine.processFrame(createAntiphaseVibrationFrame(frameIndex, generateNoise), outputRequest);
      liveSignal.push(lastFrame.regionFilteredMean ?? 0);
    }
    // En la zona izquierda todas las celdas van a la vez: la media oscila con casi toda la amplitud.
    expect(Math.max(...liveSignal.slice(-30))).toBeGreaterThan(0.4);

    const phaseMapRgba = lastFrame.phaseMapRgba!;
    expect(phaseMapRgba).not.toBeNull();
    const pixelAt = (column: number, row: number) => {
      const byteOffset = (row * 8 + column) * 4;
      return Array.from(phaseMapRgba.slice(byteOffset, byteOffset + 4)) as [number, number, number, number];
    };
    const [leftRed, leftGreen, leftBlue, leftAlpha] = pixelAt(1, 3);
    const [rightRed, rightGreen, rightBlue, rightAlpha] = pixelAt(6, 3);
    expect(leftAlpha).toBeGreaterThan(100);
    expect(rightAlpha).toBeGreaterThan(100);
    // La zona de medida es la referencia: roja. La otra mitad, en contrafase: cian.
    expect(hueDistanceDegrees(hueDegreesOf(leftRed, leftGreen, leftBlue), 0)).toBeLessThan(20);
    expect(hueDistanceDegrees(hueDegreesOf(rightRed, rightGreen, rightBlue), 180)).toBeLessThan(20);
  });
});
