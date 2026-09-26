import { fitLinearDrift, superResolveByDrift } from './driftSuperResolution';
import type { FloatRgbImage } from './lunarStacking';
import { createCachedScene, createGaussianNoise, createWaveTexture } from './syntheticMoon.testHelpers';

const frameSize = 80;
const moonRadius = 30;
/** Centro del disco en t = 0; la deriva lo lleva unos 9 px a la derecha y 3,5 abajo. */
const startCenterX = 34.3;
const startCenterY = 37.6;
const driftVelocityX = 0.2;
const driftVelocityY = 0.078;
const frameIntervalSeconds = 1.5;
const frameCount = 30;

/**
 * Superficie con detalle por encima de la frecuencia de Nyquist del sensor (0,5 ciclos/px): un
 * fotograma solo lo confunde (aliasing), la secuencia desplazada lo recupera en parte.
 */
const surfaceTexture = createWaveTexture(77, 18, 0.03, 0.7, 0.45);
const scene = createCachedScene(
  (positionX, positionY) => {
    const distance = Math.hypot(positionX - startCenterX, positionY - startCenterY);
    if (distance > moonRadius) return 8;
    return 8 + 150 * surfaceTexture(positionX, positionY);
  },
  -2,
  frameSize + 2,
  0.1,
);

/** Fotograma en el instante t: la escena desplazada por la deriva e integrada en cada píxel. */
function renderFrameAt(timeSeconds: number, pixelSize: number, outputSize: number, noiseSeed: number, noiseSigma: number) {
  const shiftX = driftVelocityX * timeSeconds;
  const shiftY = driftVelocityY * timeSeconds;
  const subsamples = 4;
  const values = new Float32Array(outputSize * outputSize);
  const gaussianNoise = createGaussianNoise(noiseSeed);
  for (let rowIndex = 0; rowIndex < outputSize; rowIndex++) {
    for (let columnIndex = 0; columnIndex < outputSize; columnIndex++) {
      // Centro del píxel de salida en coordenadas del sensor (para la rejilla fina, (u + 0,5)/2 − 0,5).
      const pixelCenterX = (columnIndex + 0.5) * pixelSize - 0.5;
      const pixelCenterY = (rowIndex + 0.5) * pixelSize - 0.5;
      let brightnessSum = 0;
      for (let subRow = 0; subRow < subsamples; subRow++) {
        for (let subColumn = 0; subColumn < subsamples; subColumn++) {
          brightnessSum += scene(
            pixelCenterX + ((subColumn + 0.5) / subsamples - 0.5) * pixelSize - shiftX,
            pixelCenterY + ((subRow + 0.5) / subsamples - 0.5) * pixelSize - shiftY,
          );
        }
      }
      values[rowIndex * outputSize + columnIndex] = brightnessSum / subsamples ** 2 + noiseSigma * gaussianNoise();
    }
  }
  return values;
}

function toRgbFrame(values: Float32Array): Uint8Array {
  const rgbPixels = new Uint8Array(values.length * 3);
  values.forEach((value, pixelIndex) => {
    const brightness = Math.min(255, Math.max(0, Math.round(value)));
    rgbPixels[pixelIndex * 3] = brightness;
    rgbPixels[pixelIndex * 3 + 1] = brightness;
    rgbPixels[pixelIndex * 3 + 2] = brightness;
  });
  return rgbPixels;
}

/** Error cuadrático medio (canal verde) dentro del disco, lejos del limbo. */
function rmsErrorInsideDisk(image: FloatRgbImage, truth: Float32Array, centerX: number, centerY: number, scale: number): number {
  let squaredErrorSum = 0;
  let sampleCount = 0;
  for (let rowIndex = 0; rowIndex < image.size; rowIndex++) {
    for (let columnIndex = 0; columnIndex < image.size; columnIndex++) {
      const sensorX = (columnIndex + 0.5) / scale - 0.5;
      const sensorY = (rowIndex + 0.5) / scale - 0.5;
      if (Math.hypot(sensorX - centerX, sensorY - centerY) > moonRadius - 4) continue;
      const pixelIndex = rowIndex * image.size + columnIndex;
      squaredErrorSum += (image.channels[pixelIndex * 3 + 1]! - truth[pixelIndex]!) ** 2;
      sampleCount++;
    }
  }
  return Math.sqrt(squaredErrorSum / sampleCount);
}

describe('fitLinearDrift', () => {
  it('recupera la velocidad y marca el punto que se aparta', () => {
    const times = [0, 1, 2, 3, 4, 5];
    const centersX = times.map((time) => 10 + 0.2 * time);
    const centersY = times.map((time) => 20 - 0.1 * time);
    centersX[3] = centersX[3]! + 2;
    const driftFit = fitLinearDrift(times, centersX, centersY)!;
    expect(driftFit.velocityYPixelsPerSecond).toBeCloseTo(-0.1, 6);
    const largestResidualIndex = driftFit.residualsPixels.indexOf(Math.max(...driftFit.residualsPixels));
    expect(largestResidualIndex).toBe(3);
  });
});

describe('superResolveByDrift', () => {
  const timestampsSeconds = Array.from({ length: frameCount }, (_unused, frameIndex) => frameIndex * frameIntervalSeconds);
  const frames = timestampsSeconds.map((timeSeconds, frameIndex) => toRgbFrame(renderFrameAt(timeSeconds, 1, frameSize, frameIndex, 1.5)));
  const result = superResolveByDrift(frames, frameSize, timestampsSeconds);
  const referenceTime = timestampsSeconds[result.referenceFrameIndex]!;
  const referenceCenterX = startCenterX + driftVelocityX * referenceTime;
  const referenceCenterY = startCenterY + driftVelocityY * referenceTime;

  it('mide la deriva y los desplazamientos con precisión subpíxel', () => {
    expect(result.usedFrameIndices).toHaveLength(frameCount);
    expect(result.driftVelocityPixelsPerSecond!.velocityX).toBeCloseTo(driftVelocityX, 2);
    expect(result.driftVelocityPixelsPerSecond!.velocityY).toBeCloseTo(driftVelocityY, 2);
    result.usedFrameIndices.forEach((frameIndex, usedPosition) => {
      const expectedOffsetX = driftVelocityX * (timestampsSeconds[frameIndex]! - referenceTime);
      const expectedOffsetY = driftVelocityY * (timestampsSeconds[frameIndex]! - referenceTime);
      expect(Math.abs(result.frameOffsets[usedPosition]!.offsetX - expectedOffsetX)).toBeLessThan(0.08);
      expect(Math.abs(result.frameOffsets[usedPosition]!.offsetY - expectedOffsetY)).toBeLessThan(0.08);
    });
  });

  it('se acerca más a la verdad que un fotograma ampliado', () => {
    const truthAtFinerGrid = renderFrameAt(referenceTime, 0.5, frameSize * 2, 0, 0);
    const fusedError = rmsErrorInsideDisk(result.image, truthAtFinerGrid, referenceCenterX, referenceCenterY, 2);
    const singleFrameError = rmsErrorInsideDisk(result.singleFrameImage, truthAtFinerGrid, referenceCenterX, referenceCenterY, 2);
    expect(result.image.size).toBe(frameSize * 2);
    expect(fusedError).toBeLessThan(0.85 * singleFrameError);
  });

  it('descarta un fotograma movido (un golpe al trípode)', () => {
    const bumpedFrames = frames.slice();
    bumpedFrames[7] = toRgbFrame(renderFrameAt(timestampsSeconds[7]! + 12, 1, frameSize, 99, 1.5));
    const bumpedResult = superResolveByDrift(bumpedFrames, frameSize, timestampsSeconds);
    expect(bumpedResult.usedFrameIndices).not.toContain(7);
    expect(bumpedResult.usedFrameIndices).toHaveLength(frameCount - 1);
  });
});
