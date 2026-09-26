import { renderSyntheticMoon } from '@/processing/image/syntheticMoon.testHelpers';
import type { FloatRgbImage } from '@/processing/image/lunarStacking';

import { floatRgbToLinearPlanes, linearPlanesToFloatRgb, processMoonResult, renderMineralView } from './resultProcessing';

const imageSide = 120;
const moonCenter = 59.5;
const moonRadius = 40;
/** Dominante de color de la cámara y aberración cromática: el rojo sale un 1,5 % más pequeño. */
const colorCast = { red: 1.25, green: 1, blue: 0.8 };
const redRadiusScale = 0.985;
const blurSigma = 2;

function renderChannel(radius: number, brightness: number) {
  return renderSyntheticMoon({
    width: imageSide,
    height: imageSide,
    centerX: moonCenter,
    centerY: moonCenter,
    radius,
    diskBrightness: brightness,
    backgroundBrightness: 2,
    blurSigmaPixels: blurSigma,
    noiseSigma: 0.3,
    subsamplesPerSide: 3,
  });
}

/** Imagen como la de un apilado de JPEG: brillo lineal pasado a la curva sRGB (0-255). */
function buildStackedImage(): FloatRgbImage {
  const linearPlanes = {
    width: imageSide,
    height: imageSide,
    red: renderChannel(moonRadius * redRadiusScale, 120 * colorCast.red).values,
    green: renderChannel(moonRadius, 120 * colorCast.green).values,
    blue: renderChannel(moonRadius, 120 * colorCast.blue).values,
  };
  return linearPlanesToFloatRgb(linearPlanes);
}

/** Anchura 10-90 % del borde en el perfil horizontal del verde (lineal), a la derecha. */
function edgeWidthPixels(image: FloatRgbImage): number {
  const greenPlane = floatRgbToLinearPlanes(image).green;
  const rowIndex = Math.round(moonCenter);
  const interiorLevel = greenPlane[rowIndex * imageSide + Math.round(moonCenter + moonRadius * 0.5)]!;
  const skyLevel = greenPlane[rowIndex * imageSide + imageSide - 3]!;
  let firstCrossing = 0;
  let lastCrossing = 0;
  for (let columnIndex = Math.round(moonCenter + moonRadius * 0.6); columnIndex < imageSide - 1; columnIndex++) {
    const normalizedValue = (greenPlane[rowIndex * imageSide + columnIndex]! - skyLevel) / (interiorLevel - skyLevel);
    if (normalizedValue > 0.9) firstCrossing = columnIndex;
    if (normalizedValue > 0.1) lastCrossing = columnIndex;
  }
  return lastCrossing - firstCrossing;
}

describe('procesado del resultado de la Luna', () => {
  const stackedImage = buildStackedImage();

  it('pasar a lineal y volver deja la imagen igual', () => {
    const roundTrip = linearPlanesToFloatRgb(floatRgbToLinearPlanes(stackedImage));
    for (let valueIndex = 0; valueIndex < stackedImage.channels.length; valueIndex += 97) {
      expect(roundTrip.channels[valueIndex]).toBeCloseTo(stackedImage.channels[valueIndex]!, 2);
    }
  });

  it('sin nada activado devuelve la misma imagen', () => {
    const result = processMoonResult(stackedImage, { correctColor: false, deconvolutionStrength: 'off', isColorImage: true });
    expect(result.image).toBe(stackedImage);
  });

  it('corrige la aberración cromática y la dominante de color', () => {
    const result = processMoonResult(stackedImage, { correctColor: true, deconvolutionStrength: 'off', isColorImage: true });
    expect(result.report.colorCorrectionFailed).toBe(false);
    expect(result.report.redScale).toBeCloseTo(redRadiusScale, 2);
    expect(result.report.whiteBalanceGains!.red).toBeCloseTo(1 / colorCast.red, 1);
    expect(result.report.whiteBalanceGains!.blue).toBeCloseTo(1 / colorCast.blue, 1);
    const correctedPlanes = floatRgbToLinearPlanes(result.image);
    const centerIndex = Math.round(moonCenter) * imageSide + Math.round(moonCenter);
    expect(correctedPlanes.red[centerIndex]! / correctedPlanes.green[centerIndex]!).toBeCloseTo(1, 1);
  });

  it('la deconvolución afila el borde', () => {
    const result = processMoonResult(stackedImage, { correctColor: false, deconvolutionStrength: 'medium', isColorImage: true });
    expect(result.report.deconvolutionFailed).toBe(false);
    expect(result.report.psfSigmaPixels).toBeGreaterThan(1.4);
    expect(result.report.psfSigmaPixels).toBeLessThan(2.6);
    expect(edgeWidthPixels(result.image)).toBeLessThan(edgeWidthPixels(stackedImage));
  });

  it('da una vista mineral', () => {
    const mineralImage = renderMineralView(stackedImage, 5);
    expect(mineralImage).not.toBeNull();
    expect(mineralImage!.size).toBe(imageSide);
  });
});
