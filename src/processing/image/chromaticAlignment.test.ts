import { correctLateralChromaticAberration, measureLateralChromaticAberration } from './chromaticAlignment';
import { fitLunarDisk } from './lunarDiskFit';
import { channelAsGrayImage, type RgbPlanes, rgbPlanesFromInterleaved, rgbPlanesToInterleaved } from './rgbPlanes';
import { createCachedScene, createWaveTexture, renderSyntheticMoon } from './syntheticMoon.testHelpers';

const imageSize = 96;
const greenCenterX = 48.3;
const greenCenterY = 47.6;
const greenRadius = 30;
const albedoTexture = createCachedScene(createWaveTexture(3, 30, 1 / 40, 1 / 6, 0.2), -45, 45, 0.25);

/** Canal con su propio aumento y desplazamiento (la textura escala con el disco, como en la óptica). */
function renderChannel(scale: number, shiftX: number, shiftY: number, brightness: number, seed: number): Float32Array {
  return renderSyntheticMoon({
    width: imageSize,
    height: imageSize,
    centerX: greenCenterX + shiftX,
    centerY: greenCenterY + shiftY,
    radius: greenRadius * scale,
    phaseAngleDegrees: 30,
    litDirectionDegrees: 200,
    diskBrightness: brightness,
    backgroundBrightness: 4,
    albedo: (relativeX, relativeY) => albedoTexture(relativeX / scale, relativeY / scale),
    blurSigmaPixels: 1,
    noiseSigma: 0.5,
    randomSeed: seed,
    subsamplesPerSide: 4,
  }).values;
}

const redGeometry = { scale: 1.012, shiftX: 0.45, shiftY: -0.3 };
const blueGeometry = { scale: 0.99, shiftX: -0.35, shiftY: 0.25 };
const aberratedPlanes: RgbPlanes = {
  width: imageSize,
  height: imageSize,
  red: renderChannel(redGeometry.scale, redGeometry.shiftX, redGeometry.shiftY, 190, 1),
  green: renderChannel(1, 0, 0, 200, 2),
  blue: renderChannel(blueGeometry.scale, blueGeometry.shiftX, blueGeometry.shiftY, 170, 3),
};

/** Diferencia cuadrática media entre dos canales normalizados por su brillo máximo. */
function normalizedChannelDifference(firstChannel: Float32Array, secondChannel: Float32Array): number {
  const firstMaximum = Math.max(...firstChannel);
  const secondMaximum = Math.max(...secondChannel);
  let squaredDifferenceSum = 0;
  for (let pixelIndex = 0; pixelIndex < firstChannel.length; pixelIndex++) {
    squaredDifferenceSum += (firstChannel[pixelIndex]! / firstMaximum - secondChannel[pixelIndex]! / secondMaximum) ** 2;
  }
  return Math.sqrt(squaredDifferenceSum / firstChannel.length);
}

describe('aberración cromática lateral', () => {
  const measurement = measureLateralChromaticAberration(aberratedPlanes)!;

  it('mide la escala y el desplazamiento de R y B respecto a G', () => {
    expect(measurement).not.toBeNull();
    expect(Math.abs(measurement.red.scale - redGeometry.scale)).toBeLessThan(0.001);
    expect(Math.abs(measurement.blue.scale - blueGeometry.scale)).toBeLessThan(0.001);
    expect(Math.abs(measurement.red.shiftX - redGeometry.shiftX)).toBeLessThan(0.05);
    expect(Math.abs(measurement.red.shiftY - redGeometry.shiftY)).toBeLessThan(0.05);
    expect(Math.abs(measurement.blue.shiftX - blueGeometry.shiftX)).toBeLessThan(0.05);
    expect(Math.abs(measurement.blue.shiftY - blueGeometry.shiftY)).toBeLessThan(0.05);
    expect(measurement.maximumFringeWidthPixels).toBeGreaterThan(0.8);
  });

  it('tras corregir, los discos de los tres canales coinciden y las franjas desaparecen', () => {
    const corrected = correctLateralChromaticAberration(aberratedPlanes, measurement)!;
    for (const channelName of ['red', 'blue'] as const) {
      const correctedDisk = fitLunarDisk(channelAsGrayImage(corrected.planes, channelName))!;
      expect(Math.abs(correctedDisk.centerX - measurement.greenDisk.centerX)).toBeLessThan(0.05);
      expect(Math.abs(correctedDisk.centerY - measurement.greenDisk.centerY)).toBeLessThan(0.05);
      expect(Math.abs(correctedDisk.radius - measurement.greenDisk.radius)).toBeLessThan(0.05);
      const differenceBefore = normalizedChannelDifference(aberratedPlanes[channelName], aberratedPlanes.green);
      const differenceAfter = normalizedChannelDifference(corrected.planes[channelName], corrected.planes.green);
      expect(differenceAfter).toBeLessThan(differenceBefore / 2);
    }
  });

  it('entrelazar y separar los planos es reversible', () => {
    const roundTrip = rgbPlanesFromInterleaved(rgbPlanesToInterleaved(aberratedPlanes), imageSize, imageSize);
    expect(roundTrip.blue).toEqual(aberratedPlanes.blue);
  });

  it('devuelve null sin disco', () => {
    const emptyPlane = new Float32Array(32 * 32);
    expect(measureLateralChromaticAberration({ width: 32, height: 32, red: emptyPlane, green: emptyPlane, blue: emptyPlane })).toBeNull();
  });
});
