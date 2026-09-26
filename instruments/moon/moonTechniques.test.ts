import type { GrayImage } from '@/processing/image/grayImage';
import { estimateNoiseSigma } from '@/processing/image/lunarDiskFit';
import { createWaveTexture, renderSyntheticMoon } from '@/processing/image/syntheticMoon.testHelpers';

import { fuseDriftPhotos, fuseEarthshineBursts, stackLuckyRecording } from './moonTechniques';

function toRgbBytes(image: GrayImage): Uint8Array {
  const rgbPixels = new Uint8Array(image.values.length * 3);
  for (let pixelIndex = 0; pixelIndex < image.values.length; pixelIndex++) {
    const byteValue = Math.max(0, Math.min(255, Math.round(image.values[pixelIndex]!)));
    rgbPixels[pixelIndex * 3] = byteValue;
    rgbPixels[pixelIndex * 3 + 1] = byteValue;
    rgbPixels[pixelIndex * 3 + 2] = byteValue;
  }
  return rgbPixels;
}

function toGrayBytes(image: GrayImage): Uint8Array {
  return Uint8Array.from(image.values, (value) => Math.max(0, Math.min(255, Math.round(value))));
}

const surfaceAlbedo = createWaveTexture(5, 10, 0.03, 0.2, 0.3);

describe('stackLuckyRecording', () => {
  it('apila fotogramas algo desplazados y con ruido: el resultado tiene menos ruido que uno solo', () => {
    const side = 64;
    const moonParameters = {
      width: side,
      height: side,
      radius: 22,
      albedo: (relativeX: number, relativeY: number) => surfaceAlbedo(relativeX + 40, relativeY + 40),
      subsamplesPerSide: 2,
    };
    const grayFrames = Array.from({ length: 12 }, (_unused, frameIndex) =>
      toGrayBytes(
        renderSyntheticMoon({
          ...moonParameters,
          centerX: 32 + (frameIndex % 3) - 1,
          centerY: 32 + (frameIndex % 2),
          noiseSigma: 12,
          randomSeed: 100 + frameIndex,
        }),
      ),
    );
    const luckyOutcome = stackLuckyRecording(grayFrames, side, 22);
    expect(luckyOutcome.stackedImage.width).toBe(side);
    expect(luckyOutcome.usedFrameCount).toBe(3);
    expect(luckyOutcome.bestSingleImage.width).toBe(side);
    // Ruido estimado por las diferencias entre píxeles vecinos: baja al promediar tres fotogramas.
    expect(estimateNoiseSigma(luckyOutcome.stackedImage)).toBeLessThan(0.8 * estimateNoiseSigma(luckyOutcome.bestSingleImage));
  });
});

describe('fuseDriftPhotos', () => {
  it('mide la deriva y devuelve una imagen del doble de lado', () => {
    const side = 72;
    const driftPhotos = Array.from({ length: 10 }, (_unused, frameIndex) => {
      const timestampSeconds = frameIndex * 5;
      const moonImage = renderSyntheticMoon({
        width: side,
        height: side,
        centerX: 30 + 0.2 * timestampSeconds,
        centerY: 34 + 0.05 * timestampSeconds,
        radius: 20,
        albedo: (relativeX, relativeY) => surfaceAlbedo(relativeX + 40, relativeY + 40),
        subsamplesPerSide: 3,
        noiseSigma: 2,
        randomSeed: frameIndex + 1,
      });
      return { rgbPixels: toRgbBytes(moonImage), side, timestampSeconds };
    });
    const driftOutcome = fuseDriftPhotos(driftPhotos);
    expect(driftOutcome.superResolvedImage.size).toBe(side * 2);
    expect(driftOutcome.singleFrameImage.size).toBe(side * 2);
    expect(driftOutcome.usedFrameCount).toBeGreaterThanOrEqual(8);
    expect(driftOutcome.driftPixelsPerSecond).toBeCloseTo(Math.hypot(0.2, 0.05), 1);
    expect(driftOutcome.driftSpanPixels).toBeGreaterThan(7);
  });
});

describe('fuseEarthshineBursts', () => {
  it('fusiona una exposición corta y otra 100 veces más larga: se ve la parte en sombra sin quemar la iluminada', () => {
    const regionSide = 90;
    const exposureRatio = 100;
    const crescentParameters = {
      width: regionSide,
      height: regionSide,
      radius: 30,
      phaseAngleDegrees: 125,
      diskBrightness: 200,
      // La parte en sombra, 1/1000 de la iluminada: invisible en la corta.
      shadowBrightness: 0.2,
      backgroundBrightness: 1,
      subsamplesPerSide: 3,
      blurSigmaPixels: 0.8,
    };
    const shortRegions = [0, 1, 2].map((photoIndex) => {
      const shortImage = renderSyntheticMoon({ ...crescentParameters, centerX: 44 + photoIndex * 0.3, centerY: 46, noiseSigma: 0.5, randomSeed: photoIndex + 1 });
      return { rgbPixels: toRgbBytes(shortImage), width: regionSide, height: regionSide };
    });
    const longRegions = [0, 1, 2].map((photoIndex) => {
      const longImage = renderSyntheticMoon({
        ...crescentParameters,
        centerX: 45 + photoIndex * 0.3,
        centerY: 46.5,
        diskBrightness: 200 * exposureRatio,
        shadowBrightness: 0.2 * exposureRatio,
        backgroundBrightness: exposureRatio * 0.05,
        noiseSigma: 2,
        randomSeed: photoIndex + 10,
      });
      return { rgbPixels: toRgbBytes(longImage), width: regionSide, height: regionSide };
    });
    const earthshineOutcome = fuseEarthshineBursts(shortRegions, longRegions, exposureRatio);
    expect(Math.abs(earthshineOutcome.diskRadiusPixels - 30)).toBeLessThan(1.5);
    expect(earthshineOutcome.exposureRatio).toBeGreaterThan(40);
    expect(earthshineOutcome.exposureRatio).toBeLessThan(250);
    const { displayImage } = earthshineOutcome;
    const side = displayImage.width;
    const center = side / 2;
    // Con fase de 125° y el Sol a la derecha, la parte en sombra ocupa el centro-izquierda del disco.
    const valueAt = (columnIndex: number, rowIndex: number) => displayImage.values[Math.round(rowIndex) * side + Math.round(columnIndex)]!;
    const shadowValue = valueAt(center - 15, center);
    const skyValue = valueAt(3, 3);
    const litValue = valueAt(center + 27, center);
    expect(shadowValue).toBeGreaterThan(skyValue + 0.1);
    expect(litValue).toBeGreaterThan(shadowValue);
    expect(litValue).toBeLessThanOrEqual(1);
  });
});
