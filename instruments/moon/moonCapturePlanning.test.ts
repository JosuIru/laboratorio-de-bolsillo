import {
  averageGrayImages,
  copyGrayCropWithDownsampling,
  earthshineRegionSide,
  floatRgbFromGray,
  fullDiskRadiusFromBrightArea,
  planDriftCropSide,
  planEarthshineExposures,
  planLuckyFrameCrop,
  resampleCenteredSquare,
} from './moonCapturePlanning';

describe('planDriftCropSide', () => {
  it('deja sitio para la deriva de un minuto: la Luna recorre casi medio diámetro', () => {
    // 31′ de diámetro aparente: en 60 s recorre 15,04·60/1860 ≈ 0,49 diámetros.
    const cropSide = planDriftCropSide(100, 31, 60, 3024);
    expect(cropSide).toBeGreaterThanOrEqual(100 * 2 + 2 * 48);
    expect(cropSide % 2).toBe(0);
  });

  it('solo depende del diámetro en la foto (no del zoom) y se acota', () => {
    expect(planDriftCropSide(20, 31, 60, 3024)).toBe(96);
    expect(planDriftCropSide(40, 31, 60, 3024)).toBe(120);
    expect(planDriftCropSide(900, 31, 60, 3024)).toBe(640);
    expect(planDriftCropSide(300, 31, 60, 500)).toBe(500);
  });
});

describe('fullDiskRadiusFromBrightArea', () => {
  it('recupera el radio del disco en una fase creciente', () => {
    const fullRadius = 50;
    const illuminatedFraction = 0.25;
    const equalAreaRadius = Math.sqrt(illuminatedFraction) * fullRadius;
    expect(fullDiskRadiusFromBrightArea(equalAreaRadius, illuminatedFraction)).toBeCloseTo(fullRadius, 6);
  });
});

describe('planEarthshineExposures', () => {
  const phoneRange = { minimumSeconds: 0.0001, maximumSeconds: 0.185 };

  it('alarga 200 veces la exposición si cabe', () => {
    const exposurePlan = planEarthshineExposures(0.0005, phoneRange);
    expect(exposurePlan.shortExposureSeconds).toBeCloseTo(0.0005, 9);
    expect(exposurePlan.longExposureSeconds).toBeCloseTo(0.1, 9);
    expect(exposurePlan.exposureRatio).toBeCloseTo(200, 6);
    expect(exposurePlan.isRatioLimited).toBe(false);
  });

  it('si la larga toca el máximo, acorta la corta hasta la relación mínima', () => {
    const exposurePlan = planEarthshineExposures(0.004, phoneRange);
    expect(exposurePlan.longExposureSeconds).toBeCloseTo(0.185, 9);
    expect(exposurePlan.shortExposureSeconds).toBeCloseTo(0.00185, 9);
    expect(exposurePlan.exposureRatio).toBeCloseTo(100, 6);
    expect(exposurePlan.isRatioLimited).toBe(false);
  });

  it('avisa si el móvil no da para la relación mínima', () => {
    const exposurePlan = planEarthshineExposures(0.01, { minimumSeconds: 0.001, maximumSeconds: 0.03 });
    expect(exposurePlan.exposureRatio).toBeCloseTo(30, 6);
    expect(exposurePlan.isRatioLimited).toBe(true);
  });
});

describe('earthshineRegionSide', () => {
  it('abarca el disco entero con margen, sin pasar de la foto', () => {
    expect(earthshineRegionSide(100, 3024)).toBe(Math.round(400 + 3024 * 0.08));
    expect(earthshineRegionSide(2000, 3024)).toBe(3024);
    expect(earthshineRegionSide(1, 3024)).toBe(256);
  });
});

describe('planLuckyFrameCrop', () => {
  it('no reduce una Luna pequeña', () => {
    expect(planLuckyFrameCrop(100, 768)).toEqual({ cropSide: 240, downsampleFactor: 1, outputSide: 240 });
  });

  it('reduce una Luna grande para no pasar del lado máximo', () => {
    const cropPlan = planLuckyFrameCrop(300, 768, 320);
    expect(cropPlan.downsampleFactor).toBe(3);
    expect(cropPlan.outputSide).toBeLessThanOrEqual(320);
    expect(cropPlan.cropSide).toBe(cropPlan.outputSide * 3);
  });
});

describe('copyGrayCropWithDownsampling', () => {
  it('promedia bloques y deja negro lo que cae fuera del fotograma', () => {
    // Fotograma RGBA de 4×2: la columna 0 blanca, el resto gris 100.
    const frameWidth = 4;
    const frameHeight = 2;
    const pixels = new Uint8Array(frameWidth * frameHeight * 4);
    for (let rowIndex = 0; rowIndex < frameHeight; rowIndex++) {
      for (let columnIndex = 0; columnIndex < frameWidth; columnIndex++) {
        const channelValue = columnIndex === 0 ? 255 : 100;
        pixels.set([channelValue, channelValue, channelValue, 255], (rowIndex * frameWidth + columnIndex) * 4);
      }
    }
    // Recorte de 2×2 bloques de 2 px desde (0, 0): la fila de abajo cae fuera del fotograma.
    const grayPixels = copyGrayCropWithDownsampling(pixels, frameWidth, frameHeight, frameWidth * 4, 4, 0, 0, 2, 2);
    expect(Array.from(grayPixels)).toEqual([Math.round((255 * 2 + 100 * 2) / 4), 100, 0, 0]);
  });
});

describe('resampleCenteredSquare y averageGrayImages', () => {
  it('centra el recorte con precisión subpíxel y promedia', () => {
    const width = 10;
    const values = new Float32Array(width * width);
    for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) values[pixelIndex] = pixelIndex % width;
    const resampled = resampleCenteredSquare({ width, height: width, values }, 5.5, 5, 4);
    // La columna 0 del recorte es x = 3,5 del original.
    expect(resampled.values[0]).toBeCloseTo(3.5, 5);
    const averaged = averageGrayImages([resampled, { ...resampled, values: resampled.values.map((value) => value + 2) }]);
    expect(averaged.values[0]).toBeCloseTo(4.5, 5);
  });

  it('floatRgbFromGray reparte el valor a los tres canales con la escala', () => {
    const floatImage = floatRgbFromGray({ width: 1, height: 1, values: Float32Array.from([0.5]) }, 255);
    expect(Array.from(floatImage.channels)).toEqual([127.5, 127.5, 127.5]);
  });
});
