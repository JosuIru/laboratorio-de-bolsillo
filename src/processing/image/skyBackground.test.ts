import { asinhStretchToBytes, automaticAsinhStretch, fitSkyBackground, subtractSkyBackground } from './skyBackground';
import { randomStars, renderStarField } from './syntheticStarField.testHelpers';

describe('fondo del cielo', () => {
  const width = 240;
  const height = 180;
  const image = renderStarField({
    width,
    height,
    stars: randomStars(120, width, height, 2, 200, 5000),
    backgroundLevel: 40,
    horizontalGradientLevels: 30,
    verticalGradientLevels: 15,
    noiseSigma: 2,
    seed: 8,
  });

  it('ajusta el gradiente sin que las estrellas lo levanten', () => {
    const model = fitSkyBackground(image);
    const evaluate = (positionX: number, positionY: number) => 40 + (30 * positionX) / width + (15 * positionY) / height;
    const residuals: number[] = [];
    const flattened = subtractSkyBackground(image);
    for (const [positionX, positionY] of [
      [10, 10],
      [120, 90],
      [230, 170],
      [20, 160],
    ]) {
      // El modelo es la imagen menos la aplanada.
      const pixelIndex = positionY! * width + positionX!;
      const modelValue = image.values[pixelIndex]! - flattened.flattenedImage.values[pixelIndex]!;
      residuals.push(modelValue - evaluate(positionX!, positionY!));
    }
    for (const residual of residuals) expect(Math.abs(residual)).toBeLessThan(1);
    expect(model.keptCellFraction).toBeGreaterThan(0.7);
    expect(flattened.gradientRangeLevels).toBeGreaterThan(38);
    expect(flattened.gradientRangeLevels).toBeLessThan(52);
    expect(flattened.backgroundNoise).toBeCloseTo(2, 0);
  });

  it('el estirado asinh levanta el cielo sin quemar las estrellas', () => {
    const { flattenedImage, backgroundNoise } = subtractSkyBackground(image);
    const stretch = automaticAsinhStretch(flattenedImage, backgroundNoise);
    const stretchedBytes = asinhStretchToBytes(flattenedImage, stretch);
    const sortedBytes = Array.from(stretchedBytes).sort((first, second) => first - second);
    const medianByte = sortedBytes[sortedBytes.length >> 1]!;
    expect(medianByte).toBeGreaterThan(10);
    expect(medianByte).toBeLessThan(60);
    expect(sortedBytes[sortedBytes.length - 1]).toBe(255);
    // Monótono: más brillo, más claro.
    const orderedBytes = asinhStretchToBytes({ width: 3, height: 1, values: Float32Array.from([0, 5, 50]) }, stretch);
    expect(orderedBytes[0]!).toBeLessThan(orderedBytes[1]!);
    expect(orderedBytes[1]!).toBeLessThan(orderedBytes[2]!);
  });
});
