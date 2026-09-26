import { defaultMineralMoonOptions, luminanceOfPlanes, renderMineralMoon } from './mineralMoon';
import type { RgbPlanes } from './rgbPlanes';
import { createGaussianNoise, createWaveTexture, renderSyntheticMoon } from './syntheticMoon.testHelpers';

const imageSize = 100;
const moonCenter = 50;
const moonRadius = 40;
/** Tinte real de cada mitad: ±2 % en rojo y ∓2 % en azul (izquierda anaranjada, derecha azulada). */
const tintAmplitude = 0.02;
/** Dominante de color de la cámara (balance de blancos erróneo). */
const colorCast = { red: 1.15, green: 1, blue: 0.85 };
const colorNoiseSigma = 5;
const skyLevel = 6;

const luminance = renderSyntheticMoon({
  width: imageSize,
  height: imageSize,
  centerX: moonCenter,
  centerY: moonCenter,
  radius: moonRadius,
  diskBrightness: 150,
  backgroundBrightness: 0,
  albedo: createWaveTexture(8, 30, 1 / 60, 1 / 6, 0.2),
  blurSigmaPixels: 0.8,
  subsamplesPerSide: 3,
});

function tintOfColumn(columnIndex: number): number {
  return columnIndex < moonCenter ? tintAmplitude : -tintAmplitude;
}

const redNoise = createGaussianNoise(21);
const greenNoise = createGaussianNoise(22);
const blueNoise = createGaussianNoise(23);
const stackedPlanes: RgbPlanes = { width: imageSize, height: imageSize, red: new Float32Array(imageSize ** 2), green: new Float32Array(imageSize ** 2), blue: new Float32Array(imageSize ** 2) };
for (let pixelIndex = 0; pixelIndex < imageSize ** 2; pixelIndex++) {
  const tint = tintOfColumn(pixelIndex % imageSize);
  const pixelLuminance = luminance.values[pixelIndex]!;
  stackedPlanes.red[pixelIndex] = skyLevel + colorCast.red * pixelLuminance * (1 + tint) + colorNoiseSigma * redNoise();
  stackedPlanes.green[pixelIndex] = skyLevel + colorCast.green * pixelLuminance + colorNoiseSigma * greenNoise();
  stackedPlanes.blue[pixelIndex] = skyLevel + colorCast.blue * pixelLuminance * (1 - tint) + colorNoiseSigma * blueNoise();
}

/** Diferencia de tono rojo−azul normalizada por el verde, y su dispersión, en un recuadro. */
function redMinusBlueStatistics(planes: RgbPlanes, balance: { red: number; blue: number }, firstColumn: number, lastColumn: number, skyLevels = { red: 0, green: 0, blue: 0 }) {
  const hueValues: number[] = [];
  for (let rowIndex = moonCenter - 12; rowIndex <= moonCenter + 12; rowIndex++) {
    for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex++) {
      const pixelIndex = rowIndex * imageSize + columnIndex;
      const green = planes.green[pixelIndex]! - skyLevels.green;
      hueValues.push(((planes.red[pixelIndex]! - skyLevels.red) * balance.red - (planes.blue[pixelIndex]! - skyLevels.blue) * balance.blue) / green);
    }
  }
  const mean = hueValues.reduce((sum, value) => sum + value, 0) / hueValues.length;
  const standardDeviation = Math.sqrt(hueValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / hueValues.length);
  return { mean, standardDeviation };
}

describe('Luna mineral', () => {
  const saturationGain = 10;
  const result = renderMineralMoon(stackedPlanes, { saturationGain })!;
  const leftColumns = [moonCenter - 25, moonCenter - 8] as const;
  const rightColumns = [moonCenter + 8, moonCenter + 25] as const;

  it('neutraliza la dominante de color con el balance de blancos sobre el disco', () => {
    expect(result).not.toBeNull();
    expect(result.whiteBalanceGains.red).toBeCloseTo(1 / colorCast.red, 1);
    expect(result.whiteBalanceGains.blue).toBeCloseTo(1 / colorCast.blue, 1);
    expect(result.skyLevels.green).toBeCloseTo(skyLevel, 0);
  });

  it('separa claramente en tono las dos zonas con tinte tenue opuesto', () => {
    const inputLeft = redMinusBlueStatistics(stackedPlanes, result.whiteBalanceGains, ...leftColumns, result.skyLevels);
    const inputRight = redMinusBlueStatistics(stackedPlanes, result.whiteBalanceGains, ...rightColumns, result.skyLevels);
    const outputLeft = redMinusBlueStatistics(result.planes, { red: 1, blue: 1 }, ...leftColumns);
    const outputRight = redMinusBlueStatistics(result.planes, { red: 1, blue: 1 }, ...rightColumns);
    expect(outputLeft.mean).toBeGreaterThan(0.2);
    expect(outputRight.mean).toBeLessThan(-0.2);
    expect(outputLeft.mean - outputRight.mean).toBeGreaterThan(5 * (inputLeft.mean - inputRight.mean));
    // Antes, las dos zonas se solapaban por el ruido; después están separadas por muchas desviaciones.
    expect(inputLeft.mean - inputRight.mean).toBeLessThan(2 * inputLeft.standardDeviation);
    expect(outputLeft.mean - outputRight.mean).toBeGreaterThan(6 * outputLeft.standardDeviation);
  });

  it('el ruido de color no se amplifica como la señal (se suaviza antes)', () => {
    const inputLeft = redMinusBlueStatistics(stackedPlanes, result.whiteBalanceGains, ...leftColumns, result.skyLevels);
    const outputLeft = redMinusBlueStatistics(result.planes, { red: 1, blue: 1 }, ...leftColumns);
    expect(outputLeft.standardDeviation).toBeLessThan(0.5 * saturationGain * inputLeft.standardDeviation);
  });

  it('conserva la luminancia y deja el cielo gris', () => {
    const outputLuminance = luminanceOfPlanes(result.planes);
    const centerIndex = moonCenter * imageSize + moonCenter - 20;
    const gains = result.whiteBalanceGains;
    const expectedLuminance =
      0.2126 * (stackedPlanes.red[centerIndex]! - result.skyLevels.red) * gains.red +
      0.7152 * (stackedPlanes.green[centerIndex]! - result.skyLevels.green) +
      0.0722 * (stackedPlanes.blue[centerIndex]! - result.skyLevels.blue) * gains.blue;
    expect(outputLuminance.values[centerIndex]).toBeCloseTo(expectedLuminance, 3);
    const skyIndex = 3 * imageSize + 3;
    expect(result.planes.red[skyIndex]).toBeCloseTo(result.planes.green[skyIndex]!, 5);
    expect(result.planes.blue[skyIndex]).toBeCloseTo(result.planes.green[skyIndex]!, 5);
  });
});

describe('Luna mineral: tendencia radial del color', () => {
  // Además del tinte de cada mitad, un color que crece del centro al borde (anaranjado en el
  // limbo), como el de las fotos reales: sin quitarlo, sale un anillo naranja.
  const radialPlanes: RgbPlanes = { width: imageSize, height: imageSize, red: new Float32Array(imageSize ** 2), green: new Float32Array(imageSize ** 2), blue: new Float32Array(imageSize ** 2) };
  const radialRedNoise = createGaussianNoise(31);
  const radialGreenNoise = createGaussianNoise(32);
  const radialBlueNoise = createGaussianNoise(33);
  for (let pixelIndex = 0; pixelIndex < imageSize ** 2; pixelIndex++) {
    const columnIndex = pixelIndex % imageSize;
    const rowIndex = Math.floor(pixelIndex / imageSize);
    const normalizedRadius = Math.min(1, Math.hypot(columnIndex - moonCenter, rowIndex - moonCenter) / moonRadius);
    const tint = 0.04 * normalizedRadius ** 2 - 0.015 + (columnIndex < moonCenter ? 0.015 : -0.015);
    const pixelLuminance = luminance.values[pixelIndex]!;
    radialPlanes.red[pixelIndex] = skyLevel + pixelLuminance * (1 + tint) + 2 * radialRedNoise();
    radialPlanes.green[pixelIndex] = skyLevel + pixelLuminance + 2 * radialGreenNoise();
    radialPlanes.blue[pixelIndex] = skyLevel + pixelLuminance * (1 - tint) + 2 * radialBlueNoise();
  }

  /** Media de (R − B)/G en una corona entre dos fracciones del radio. */
  function meanHueInAnnulus(planes: RgbPlanes, innerFraction: number, outerFraction: number): number {
    let hueSum = 0;
    let sampleCount = 0;
    for (let pixelIndex = 0; pixelIndex < imageSize ** 2; pixelIndex++) {
      const normalizedRadius = Math.hypot((pixelIndex % imageSize) - moonCenter, Math.floor(pixelIndex / imageSize) - moonCenter) / moonRadius;
      if (normalizedRadius < innerFraction || normalizedRadius >= outerFraction) continue;
      hueSum += (planes.red[pixelIndex]! - planes.blue[pixelIndex]!) / planes.green[pixelIndex]!;
      sampleCount++;
    }
    return hueSum / sampleCount;
  }

  it('sin restar la tendencia sale un anillo de color; restándola desaparece y las dos zonas siguen separadas', () => {
    const withTrend = renderMineralMoon(radialPlanes, { radialTrendDegree: -1 })!;
    const withoutTrend = renderMineralMoon(radialPlanes)!;
    const ringContrastWithTrend = meanHueInAnnulus(withTrend.planes, 0.75, 0.88) - meanHueInAnnulus(withTrend.planes, 0, 0.3);
    const ringContrastWithoutTrend = meanHueInAnnulus(withoutTrend.planes, 0.75, 0.88) - meanHueInAnnulus(withoutTrend.planes, 0, 0.3);
    expect(ringContrastWithTrend).toBeGreaterThan(0.15);
    expect(Math.abs(ringContrastWithoutTrend)).toBeLessThan(0.03);
    const leftHue = redMinusBlueStatistics(withoutTrend.planes, { red: 1, blue: 1 }, ...[moonCenter - 25, moonCenter - 8] as const).mean;
    const rightHue = redMinusBlueStatistics(withoutTrend.planes, { red: 1, blue: 1 }, ...[moonCenter + 8, moonCenter + 25] as const).mean;
    expect(leftHue).toBeGreaterThan(0.08);
    expect(rightHue).toBeLessThan(-0.08);
  });

  it('la ganancia por defecto es moderada (5)', () => {
    expect(defaultMineralMoonOptions.saturationGain).toBe(5);
  });
});
