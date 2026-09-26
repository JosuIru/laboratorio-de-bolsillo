import { detectStars, estimateBackgroundMesh, typicalBackgroundNoise } from './starDetection';
import { randomStars, renderStarField } from './syntheticStarField.testHelpers';

describe('detectStars', () => {
  const width = 256;
  const height = 256;
  const trueStars = randomStars(80, width, height, 11, 300, 3000);
  const hotPixels = [
    { x: 40, y: 200, excess: 150 },
    { x: 130, y: 20, excess: 200 },
    { x: 210, y: 128, excess: 120 },
  ].filter((hotPixel) => trueStars.every((star) => Math.hypot(star.x - hotPixel.x, star.y - hotPixel.y) > 6));
  const image = renderStarField({
    width,
    height,
    stars: trueStars,
    backgroundLevel: 25,
    horizontalGradientLevels: 30,
    verticalGradientLevels: 10,
    noiseSigma: 3,
    seed: 5,
    hotPixels,
  });
  const detectedStars = detectStars(image);

  function nearestDetection(star: { x: number; y: number }) {
    let bestDistance = Infinity;
    let bestIndex = -1;
    detectedStars.forEach((detectedStar, detectedIndex) => {
      const distance = Math.hypot(detectedStar.x - star.x, detectedStar.y - star.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = detectedIndex;
      }
    });
    return { bestDistance, bestIndex };
  }

  it('recupera casi todas las estrellas con error de centroide subpíxel', () => {
    const centroidErrors: number[] = [];
    for (const trueStar of trueStars) {
      const { bestDistance } = nearestDetection(trueStar);
      if (bestDistance < 1.5) centroidErrors.push(bestDistance);
    }
    const recoveredFraction = centroidErrors.length / trueStars.length;
    const rmsCentroidError = Math.sqrt(centroidErrors.reduce((sum, error) => sum + error * error, 0) / centroidErrors.length);
    expect(recoveredFraction).toBeGreaterThanOrEqual(0.95);
    expect(rmsCentroidError).toBeLessThan(0.1);
  });

  it('no confunde píxeles calientes ni ruido con estrellas', () => {
    expect(hotPixels.length).toBeGreaterThan(0);
    for (const hotPixel of hotPixels) {
      expect(detectedStars.some((detectedStar) => Math.hypot(detectedStar.x - hotPixel.x, detectedStar.y - hotPixel.y) < 2)).toBe(false);
    }
    const spuriousCount = detectedStars.filter(
      (detectedStar) => trueStars.every((trueStar) => Math.hypot(detectedStar.x - trueStar.x, detectedStar.y - trueStar.y) >= 1.5),
    ).length;
    expect(spuriousCount).toBeLessThanOrEqual(2);
  });

  it('ordena de más a menos brillante', () => {
    for (let detectedIndex = 1; detectedIndex < detectedStars.length; detectedIndex++) {
      expect(detectedStars[detectedIndex]!.flux).toBeLessThanOrEqual(detectedStars[detectedIndex - 1]!.flux);
    }
    const brightestTrueStar = trueStars.reduce((brightest, star) => (star.flux > brightest.flux ? star : brightest));
    expect(nearestDetection(brightestTrueStar).bestIndex).toBeLessThan(3);
  });

  it('mide el fondo con gradiente y el ruido sin que las estrellas lo suban', () => {
    const mesh = estimateBackgroundMesh(image, 32);
    const leftLevel = mesh.levels[3 * mesh.columnCount]!;
    const rightLevel = mesh.levels[3 * mesh.columnCount + mesh.columnCount - 1]!;
    expect(rightLevel - leftLevel).toBeGreaterThan(20);
    expect(typicalBackgroundNoise(image)).toBeCloseTo(3, 0);
  });

  it('no convierte el rastro de un avión en una hilera de estrellas', () => {
    const streakImage = renderStarField({ width: 128, height: 128, stars: [], backgroundLevel: 20, noiseSigma: 2, seed: 3 });
    for (let columnIndex = 10; columnIndex < 118; columnIndex++) {
      const rowIndex = Math.round(30 + columnIndex * 0.5);
      streakImage.values[rowIndex * 128 + columnIndex] = streakImage.values[rowIndex * 128 + columnIndex]! + 80;
    }
    expect(detectStars(streakImage)).toHaveLength(0);
  });
});
