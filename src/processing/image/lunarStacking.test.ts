import {
  type AlignedCrop,
  chooseCropSize,
  copyCenteredCrop,
  gaussianBlur,
  locateBrightObject,
  measureCropSharpness,
  planCenteredCrop,
  renderImageToRgba,
  stackAlignedCrops,
  stackSharpestCrops,
} from './lunarStacking';

/** Generador pseudoaleatorio determinista (LCG) para que los tests sean reproducibles. */
function createSeededRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

/** Fotograma RGB con un disco brillante sobre cielo oscuro, con ruido opcional. */
function renderDiskFrame(options: {
  frameWidth: number;
  frameHeight: number;
  centerX: number;
  centerY: number;
  radius: number;
  diskBrightness?: number;
  noiseAmplitude?: number;
  random?: () => number;
  bytesPerPixel?: number;
}): Uint8Array {
  const { frameWidth, frameHeight, centerX, centerY, radius, diskBrightness = 200, noiseAmplitude = 0 } = options;
  const bytesPerPixel = options.bytesPerPixel ?? 3;
  const random = options.random ?? createSeededRandom(1);
  const pixels = new Uint8Array(frameWidth * frameHeight * bytesPerPixel);
  for (let rowIndex = 0; rowIndex < frameHeight; rowIndex++) {
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex++) {
      // Borde suave de 1 px para que el centroide tenga sentido subpíxel.
      const distanceToCenter = Math.hypot(columnIndex - centerX, rowIndex - centerY);
      const coverage = Math.max(0, Math.min(1, radius - distanceToCenter + 0.5));
      const noise = (random() - 0.5) * 2 * noiseAmplitude;
      const value = Math.max(0, Math.min(255, 10 + coverage * (diskBrightness - 10) + noise));
      const pixelOffset = (rowIndex * frameWidth + columnIndex) * bytesPerPixel;
      pixels[pixelOffset] = value;
      pixels[pixelOffset + 1] = value;
      pixels[pixelOffset + 2] = value;
      if (bytesPerPixel === 4) pixels[pixelOffset + 3] = 255;
    }
  }
  return pixels;
}

function cropFromFrame(frameRgb: Uint8Array, frameWidth: number, frameHeight: number, cropSize: number): AlignedCrop {
  const detection = locateBrightObject(frameRgb, frameWidth, frameHeight, frameWidth * 3, 3, 1)!;
  const cropPlan = planCenteredCrop(detection.centerX, detection.centerY, cropSize);
  const rgbPixels = new Uint8Array(cropSize * cropSize * 3);
  copyCenteredCrop(frameRgb, frameWidth, frameHeight, frameWidth * 3, 3, false, cropPlan.cropLeft, cropPlan.cropTop, cropSize, rgbPixels);
  return { rgbPixels, fractionalOffsetX: cropPlan.fractionalOffsetX, fractionalOffsetY: cropPlan.fractionalOffsetY };
}

function standardDeviation(values: readonly number[]): number {
  let valueSum = 0;
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) valueSum += values[valueIndex]!;
  const meanValue = valueSum / values.length;
  let squaredDeviationSum = 0;
  for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
    squaredDeviationSum += (values[valueIndex]! - meanValue) ** 2;
  }
  return Math.sqrt(squaredDeviationSum / values.length);
}

describe('locateBrightObject', () => {
  it('encuentra el centro y el radio de un disco', () => {
    const frameRgb = renderDiskFrame({ frameWidth: 160, frameHeight: 120, centerX: 70.3, centerY: 50.6, radius: 20 });
    const detection = locateBrightObject(frameRgb, 160, 120, 160 * 3, 3, 1)!;
    expect(detection.centerX).toBeCloseTo(70.3, 0);
    expect(detection.centerY).toBeCloseTo(50.6, 0);
    expect(Math.abs(detection.radiusPixels - 20)).toBeLessThan(1.5);
    expect(detection.saturatedFraction).toBe(0);
  });

  it('funciona con 4 bytes por píxel y saltando píxeles', () => {
    const frameRgba = renderDiskFrame({ frameWidth: 160, frameHeight: 120, centerX: 100, centerY: 40, radius: 15, bytesPerPixel: 4 });
    const detection = locateBrightObject(frameRgba, 160, 120, 160 * 4, 4, 2)!;
    expect(Math.abs(detection.centerX - 100)).toBeLessThan(1);
    expect(Math.abs(detection.centerY - 40)).toBeLessThan(1);
  });

  it('detecta la sobreexposición', () => {
    const frameRgb = renderDiskFrame({ frameWidth: 80, frameHeight: 80, centerX: 40, centerY: 40, radius: 15, diskBrightness: 255 });
    expect(locateBrightObject(frameRgb, 80, 80, 80 * 3, 3, 1)!.saturatedFraction).toBeGreaterThan(0.8);
  });

  it('no encuentra nada en un cielo uniforme', () => {
    const uniformSky = new Uint8Array(50 * 50 * 3).fill(30);
    expect(locateBrightObject(uniformSky, 50, 50, 150, 3, 1)).toBeNull();
  });
});

describe('recorte y alineado', () => {
  it('rellena de negro lo que queda fuera del fotograma', () => {
    const frameRgb = new Uint8Array(4 * 4 * 3).fill(100);
    const cropRgb = new Uint8Array(4 * 4 * 3);
    copyCenteredCrop(frameRgb, 4, 4, 12, 3, false, -2, -2, 4, cropRgb);
    expect(cropRgb[0]).toBe(0);
    expect(cropRgb[(3 * 4 + 3) * 3]).toBe(100);
  });

  it('invierte rojo y azul en orden BGR', () => {
    const frameBgra = new Uint8Array([10, 20, 30, 255]);
    const cropRgb = new Uint8Array(3);
    copyCenteredCrop(frameBgra, 1, 1, 4, 4, true, 0, 0, 1, cropRgb);
    expect(Array.from(cropRgb)).toEqual([30, 20, 10]);
  });

  it('apila discos desplazados dejándolos centrados y nítidos', () => {
    const cropSize = 64;
    const diskCenters: [number, number][] = [
      [60.2, 50.7],
      [75.9, 44.1],
      [68.5, 58.5],
    ];
    const crops = diskCenters.map(([centerX, centerY]) =>
      cropFromFrame(renderDiskFrame({ frameWidth: 160, frameHeight: 120, centerX, centerY, radius: 18 }), 160, 120, cropSize),
    );
    const stackedImage = stackAlignedCrops(crops, cropSize);
    const brightnessAt = (columnIndex: number, rowIndex: number) => stackedImage.channels[(rowIndex * cropSize + columnIndex) * 3]!;
    // Centro brillante, esquina oscura, y el borde del disco a ~18 px del centro en los cuatro lados.
    expect(brightnessAt(32, 32)).toBeGreaterThan(190);
    expect(brightnessAt(2, 2)).toBeLessThan(20);
    for (const [columnIndex, rowIndex] of [[32 + 16, 32], [32 - 16, 32], [32, 32 + 16], [32, 32 - 16]] as const) {
      expect(brightnessAt(columnIndex, rowIndex)).toBeGreaterThan(150);
    }
    for (const [columnIndex, rowIndex] of [[32 + 21, 32], [32 - 21, 32], [32, 32 + 21], [32, 32 - 21]] as const) {
      expect(brightnessAt(columnIndex, rowIndex)).toBeLessThan(40);
    }
  });

  it('apilar reduce el ruido del cielo aproximadamente con √N', () => {
    const cropSize = 48;
    const random = createSeededRandom(7);
    const crops = Array.from({ length: 16 }, () =>
      cropFromFrame(
        renderDiskFrame({ frameWidth: 96, frameHeight: 96, centerX: 48, centerY: 48, radius: 12, noiseAmplitude: 8, random }),
        96,
        96,
        cropSize,
      ),
    );
    const skyValues = (channels: ArrayLike<number>) => Array.from({ length: 8 * 8 }, (_value, index) => channels[(Math.floor(index / 8) * cropSize + (index % 8)) * 3]!);
    const singleFrameNoise = standardDeviation(skyValues(crops[0]!.rgbPixels));
    const stackedNoise = standardDeviation(skyValues(stackAlignedCrops(crops, cropSize).channels));
    expect(stackedNoise).toBeLessThan(singleFrameNoise / 2.5);
  });
});

describe('nitidez y proceso completo', () => {
  it('puntúa más alto un fotograma nítido que uno desenfocado', () => {
    const cropSize = 48;
    const sharpCrop = cropFromFrame(renderDiskFrame({ frameWidth: 96, frameHeight: 96, centerX: 48, centerY: 48, radius: 12 }), 96, 96, cropSize);
    const blurredImage = gaussianBlur(stackAlignedCrops([sharpCrop], cropSize), 2.5);
    const blurredPixels = Uint8Array.from(blurredImage.channels, (value) => Math.round(value));
    expect(measureCropSharpness(sharpCrop.rgbPixels, cropSize)).toBeGreaterThan(2 * measureCropSharpness(blurredPixels, cropSize));
  });

  it('se queda con los fotogramas más nítidos', () => {
    const cropSize = 48;
    const sharpCrop = cropFromFrame(renderDiskFrame({ frameWidth: 96, frameHeight: 96, centerX: 48, centerY: 48, radius: 12 }), 96, 96, cropSize);
    const blurredPixels = Uint8Array.from(gaussianBlur(stackAlignedCrops([sharpCrop], cropSize), 3).channels, Math.round);
    const blurredCrop: AlignedCrop = { rgbPixels: blurredPixels, fractionalOffsetX: 0, fractionalOffsetY: 0 };
    const stackingResult = stackSharpestCrops([blurredCrop, sharpCrop, blurredCrop, blurredCrop], cropSize, 0.25, 0);
    expect(stackingResult.usedCropCount).toBe(1);
    expect(Array.from(stackingResult.bestSingleImage.channels.slice(0, 30))).toEqual(
      Array.from(stackAlignedCrops([sharpCrop], cropSize).channels.slice(0, 30)),
    );
  });

  it('estira el contraste a 0-255 y devuelve RGBA opaco', () => {
    const cropSize = 32;
    const crop = cropFromFrame(renderDiskFrame({ frameWidth: 64, frameHeight: 64, centerX: 32, centerY: 32, radius: 8, diskBrightness: 120 }), 64, 64, cropSize);
    const rgbaPixels = renderImageToRgba(stackAlignedCrops([crop], cropSize));
    expect(rgbaPixels.length).toBe(cropSize * cropSize * 4);
    expect(rgbaPixels[0]).toBe(0);
    expect(rgbaPixels[(16 * cropSize + 16) * 4]).toBe(255);
    expect(rgbaPixels[3]).toBe(255);
  });

  it('elige un recorte par y acotado', () => {
    expect(chooseCropSize(10)).toBe(96);
    expect(chooseCropSize(101)).toBe(304);
    expect(chooseCropSize(1000)).toBe(600);
  });
});
