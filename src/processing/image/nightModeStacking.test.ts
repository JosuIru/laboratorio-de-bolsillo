import { createGrayImage, createSeededRandom, gaussianBlurGray, type GrayImage } from './grayImage';
import type { FloatRgbImage } from './lunarStacking';
import {
  denoiseNightImage,
  measureNightToneStatistics,
  nightToneGain,
  planNightModeExposure,
  stackNightBurst,
  toneMapNightImage,
} from './nightModeStacking';

const frameSize = 96;
const sceneMargin = 8;
const sceneSize = frameSize + 2 * sceneMargin;
const frameCount = 16;
const noiseSigma = 8;
const channelFactors = [1, 0.9, 0.75] as const;

/** Escena oscura con detalle (valores ~15-85). */
function createDarkScene(): GrayImage {
  const randomValue = createSeededRandom(21);
  const scene = createGrayImage(sceneSize, sceneSize);
  for (let pixelIndex = 0; pixelIndex < scene.values.length; pixelIndex++) scene.values[pixelIndex] = 50 + 70 * (randomValue() - 0.5);
  return gaussianBlurGray(scene, 1.5);
}

const darkScene = createDarkScene();

/** Temblor de la mano: desplazamientos enteros (el remuestreo no suaviza el ruido por su cuenta). */
function frameShift(frameIndex: number): { shiftX: number; shiftY: number } {
  return { shiftX: (frameIndex % 3) - 1, shiftY: (Math.floor(frameIndex / 3) % 3) - 1 };
}

function gaussianNoise(randomValue: () => number): number {
  const radius = Math.sqrt(-2 * Math.log(Math.max(1e-12, randomValue())));
  return radius * Math.cos(2 * Math.PI * randomValue());
}

interface MovingSquare {
  frameIndex: number;
  left: number;
  top: number;
  side: number;
  value: number;
}

function sceneValue(sceneColumn: number, sceneRow: number, frameIndex: number, movingSquare: MovingSquare | null): number {
  if (
    movingSquare &&
    movingSquare.frameIndex === frameIndex &&
    sceneColumn >= movingSquare.left &&
    sceneColumn < movingSquare.left + movingSquare.side &&
    sceneRow >= movingSquare.top &&
    sceneRow < movingSquare.top + movingSquare.side
  ) {
    return movingSquare.value;
  }
  return darkScene.values[sceneRow * sceneSize + sceneColumn]!;
}

function renderNoisyFrame(frameIndex: number, movingSquare: MovingSquare | null): Uint8Array {
  const randomValue = createSeededRandom(500 + frameIndex);
  const { shiftX, shiftY } = frameShift(frameIndex);
  const rgbPixels = new Uint8Array(frameSize * frameSize * 3);
  for (let rowIndex = 0; rowIndex < frameSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < frameSize; columnIndex++) {
      const value = sceneValue(columnIndex + sceneMargin + shiftX, rowIndex + sceneMargin + shiftY, frameIndex, movingSquare);
      for (let channelIndex = 0; channelIndex < 3; channelIndex++) {
        const noisyValue = value * channelFactors[channelIndex]! + noiseSigma * gaussianNoise(randomValue);
        rgbPixels[(rowIndex * frameSize + columnIndex) * 3 + channelIndex] = Math.min(255, Math.max(0, Math.round(noisyValue)));
      }
    }
  }
  return rgbPixels;
}

/** Error cuadrático medio del verde frente a la escena real, vista como la referencia, lejos de los bordes. */
function greenRootMeanSquareError(image: FloatRgbImage, referenceFrameIndex: number, region?: { left: number; top: number; side: number }): number {
  const { shiftX, shiftY } = frameShift(referenceFrameIndex);
  const firstColumn = region ? region.left : 8;
  const firstRow = region ? region.top : 8;
  const endColumn = region ? region.left + region.side : frameSize - 8;
  const endRow = region ? region.top + region.side : frameSize - 8;
  let squaredErrorSum = 0;
  let sampleCount = 0;
  for (let rowIndex = firstRow; rowIndex < endRow; rowIndex++) {
    for (let columnIndex = firstColumn; columnIndex < endColumn; columnIndex++) {
      const trueValue = darkScene.values[(rowIndex + sceneMargin + shiftY) * sceneSize + columnIndex + sceneMargin + shiftX]! * channelFactors[1];
      const error = image.channels[(rowIndex * frameSize + columnIndex) * 3 + 1]! - trueValue;
      squaredErrorSum += error * error;
      sampleCount++;
    }
  }
  return Math.sqrt(squaredErrorSum / sampleCount);
}

describe('stackNightBurst', () => {
  it('reduce el ruido cerca de √N', () => {
    const frames = Array.from({ length: frameCount }, (_unused, frameIndex) => renderNoisyFrame(frameIndex, null));
    const result = stackNightBurst(frames, frameSize);
    const singleError = greenRootMeanSquareError(result.referenceImage, result.referenceFrameIndex);
    const stackedError = greenRootMeanSquareError(result.stackedImage, result.referenceFrameIndex);
    const noiseReduction = singleError / stackedError;
    // √16 = 4. El rechazo tira alguna muestra buena (menos); el remuestreo subpíxel del
    // alineado por zonas promedia un poco el ruido de cada foto (más): sale ~5.
    expect(noiseReduction).toBeGreaterThan(0.8 * Math.sqrt(frameCount));
    expect(noiseReduction).toBeLessThan(1.4 * Math.sqrt(frameCount));
    expect(result.noiseReductionFactor).toBeGreaterThan(2.5);
    expect(result.rejectedFraction).toBeLessThan(0.03);
    expect(result.usedFrameCount).toBe(frameCount);
  });

  it('borra un objeto que cruza en una sola foto', () => {
    // En coordenadas de la escena; en la referencia queda desplazado como mucho 1 px.
    const movingSquare: MovingSquare = { frameIndex: 5, left: 40 + sceneMargin, top: 30 + sceneMargin, side: 14, value: 230 };
    const frames = Array.from({ length: frameCount }, (_unused, frameIndex) => renderNoisyFrame(frameIndex, movingSquare));
    const result = stackNightBurst(frames, frameSize);
    const squareRegion = { left: 42, top: 32, side: 10 };
    const stackedSquareError = greenRootMeanSquareError(result.stackedImage, result.referenceFrameIndex, squareRegion);
    // Con la media simple quedaría un fantasma de (230 − ~45)·0,9 / 16 ≈ 10 niveles.
    expect(stackedSquareError).toBeLessThan(4);
    expect(result.rejectedFraction).toBeLessThan(0.05);
  });
});

describe('planNightModeExposure', () => {
  const exposureLimits = { minimumExposureSeconds: 0.0001, maximumExposureSeconds: 0.185, minimumIso: 100, maximumIso: 6400 };

  it('apoyado: exposición larga e ISO bajo', () => {
    const plan = planNightModeExposure({ exposureSeconds: 1 / 15, iso: 3200 }, exposureLimits, 'tripod');
    expect(plan?.exposureSeconds).toBeCloseTo(0.185, 6);
    expect(plan?.iso).toBe(807);
    expect(plan?.frameCount).toBe(10);
    expect(plan?.brightnessRelativeToAutomatic).toBeCloseTo(0.7, 2);
  });

  it('en la mano: 1/30 s como mucho e ISO alto, con tope', () => {
    const plan = planNightModeExposure({ exposureSeconds: 1 / 10, iso: 6400 }, exposureLimits, 'handheld');
    expect(plan?.exposureSeconds).toBeCloseTo(1 / 30, 6);
    expect(plan?.iso).toBe(6400);
    expect(plan?.frameCount).toBe(16);
    expect(plan!.brightnessRelativeToAutomatic).toBeLessThan(0.7);
  });

  it('con luz de sobra baja el tiempo con ISO mínimo', () => {
    const plan = planNightModeExposure({ exposureSeconds: 1 / 100, iso: 200 }, exposureLimits, 'tripod');
    expect(plan?.iso).toBe(100);
    expect(plan?.exposureSeconds).toBeCloseTo(0.014, 6);
  });
});

describe('revelado nocturno', () => {
  /** Escena oscura con una farola (valores de 200 a 250) en una esquina. */
  function sceneWithStreetLight(): FloatRgbImage {
    const size = 64;
    const channels = new Float32Array(size * size * 3);
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      for (let columnIndex = 0; columnIndex < size; columnIndex++) {
        const isLight = rowIndex < 4 && columnIndex < 3;
        const value = isLight ? 200 + 25 * columnIndex : 20 + (columnIndex % 8) * 3;
        channels.fill(value, (rowIndex * size + columnIndex) * 3, (rowIndex * size + columnIndex) * 3 + 3);
      }
    }
    return { size, channels };
  }

  it('«Ambiente» aclara la escena sin quemar las luces', () => {
    const image = sceneWithStreetLight();
    const statistics = measureNightToneStatistics(image);
    expect(nightToneGain(statistics, 1)).toBeGreaterThan(nightToneGain(statistics, 0));
    const nightLook = toneMapNightImage(image, statistics, 0);
    const dayLook = toneMapNightImage(image, statistics, 1);
    const darkPixelOffset = (40 * 64 + 45) * 3 + 1;
    expect(dayLook.channels[darkPixelOffset]!).toBeGreaterThan(nightLook.channels[darkPixelOffset]! + 30);
    // La farola sigue ordenada (200 < 225 < 250) y por debajo del blanco.
    const lightValues = [0, 1, 2].map((columnIndex) => dayLook.channels[columnIndex * 3 + 1]!);
    expect(lightValues[0]!).toBeLessThan(lightValues[1]!);
    expect(lightValues[1]!).toBeLessThan(lightValues[2]!);
    expect(lightValues[2]!).toBeLessThanOrEqual(255);
    expect(lightValues[1]!).toBeLessThan(254);
  });

  it('la reducción de ruido baja el ruido sin mover la media', () => {
    const size = 64;
    const randomValue = createSeededRandom(9);
    const channels = new Float32Array(size * size * 3);
    for (let valueIndex = 0; valueIndex < channels.length; valueIndex++) channels[valueIndex] = 60 + 6 * gaussianNoise(randomValue);
    const denoised = denoiseNightImage({ size, channels }, 0.6);
    function greenStatistics(values: Float32Array): { mean: number; sigma: number } {
      let valueSum = 0;
      let squaredSum = 0;
      for (let pixelIndex = 0; pixelIndex < size * size; pixelIndex++) {
        valueSum += values[pixelIndex * 3 + 1]!;
        squaredSum += values[pixelIndex * 3 + 1]! ** 2;
      }
      const mean = valueSum / (size * size);
      return { mean, sigma: Math.sqrt(squaredSum / (size * size) - mean * mean) };
    }
    const before = greenStatistics(channels);
    const after = greenStatistics(denoised.channels);
    expect(after.sigma).toBeLessThan(0.6 * before.sigma);
    expect(Math.abs(after.mean - before.mean)).toBeLessThan(0.5);
  });
});
