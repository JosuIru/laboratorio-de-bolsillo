import { createSeededRandom } from '../image/grayImage';
import { randomStars, rotationAboutPoint } from '../image/syntheticStarField.testHelpers';

import {
  alignStarFields,
  applyRigidTransform,
  composeRigidTransforms,
  interpolateRigidTransform,
  invertRigidTransform,
  type RigidTransform,
  type StarPosition,
} from './starFieldAlignment';

const radiansToDegrees = 180 / Math.PI;

describe('transformaciones rígidas', () => {
  const transform: RigidTransform = { rotationRadians: 0.3, translationX: 12, translationY: -7 };
  const point = { x: 40, y: 25 };

  it('la inversa deshace la transformación y la composición encadena', () => {
    const roundTrip = applyRigidTransform(invertRigidTransform(transform), applyRigidTransform(transform, point));
    expect(roundTrip.x).toBeCloseTo(point.x, 9);
    expect(roundTrip.y).toBeCloseTo(point.y, 9);
    const composed = applyRigidTransform(composeRigidTransforms(transform, transform), point);
    const twice = applyRigidTransform(transform, applyRigidTransform(transform, point));
    expect(composed.x).toBeCloseTo(twice.x, 9);
    expect(composed.y).toBeCloseTo(twice.y, 9);
  });

  it('la interpolación gira alrededor del mismo punto fijo (el polo)', () => {
    const rotationAboutPole = rotationAboutPoint(2, 500, -300);
    const halfway = interpolateRigidTransform(rotationAboutPole, 0.5);
    expect(halfway.rotationRadians * radiansToDegrees).toBeCloseTo(1, 9);
    const movedPole = applyRigidTransform(halfway, { x: 500, y: -300 });
    expect(movedPole.x).toBeCloseTo(500, 6);
    expect(movedPole.y).toBeCloseTo(-300, 6);
    const composedHalves = composeRigidTransforms(halfway, halfway);
    const fullMove = applyRigidTransform(rotationAboutPole, point);
    const halvesMove = applyRigidTransform(composedHalves, point);
    expect(halvesMove.x).toBeCloseTo(fullMove.x, 6);
    expect(halvesMove.y).toBeCloseTo(fullMove.y, 6);
    const pureShift = interpolateRigidTransform({ rotationRadians: 0, translationX: 10, translationY: 4 }, 0.25);
    expect(pureShift).toEqual({ rotationRadians: 0, translationX: 2.5, translationY: 1 });
  });
});

describe('alignStarFields', () => {
  const width = 1000;
  const height = 750;
  const referenceStars = randomStars(120, width, height, 3, 100, 10_000).sort((first, second) => second.flux - first.flux);
  // El cielo gira 0,4° alrededor de un polo fuera de la imagen (como en unos 100 s cerca del ecuador).
  const skyMotion = rotationAboutPoint(0.4, 300, -2500);
  const noiseRandom = createSeededRandom(17);

  function movedStarField(dropEvery: number, spuriousCount: number): StarPosition[] {
    const movingToReference = invertRigidTransform(skyMotion);
    // Posiciones en el fotograma nuevo: las de la referencia movidas por el cielo, con 0,1 px de error.
    const movedStars: { x: number; y: number; flux: number }[] = referenceStars
      .filter((_star, starIndex) => starIndex % dropEvery !== dropEvery - 1)
      .map((star) => {
        const movedPosition = applyRigidTransform(invertRigidTransform(movingToReference), star);
        return { x: movedPosition.x + (noiseRandom() - 0.5) * 0.2, y: movedPosition.y + (noiseRandom() - 0.5) * 0.2, flux: star.flux };
      });
    for (let spuriousIndex = 0; spuriousIndex < spuriousCount; spuriousIndex++) {
      movedStars.push({ x: noiseRandom() * width, y: noiseRandom() * height, flux: 50 + noiseRandom() * 5000 });
    }
    return movedStars.sort((first, second) => second.flux - first.flux);
  }

  it('recupera rotación y traslación aunque falten estrellas y sobren falsas', () => {
    const movedStars = movedStarField(7, 15);
    const alignment = alignStarFields(referenceStars, movedStars);
    expect(alignment).not.toBeNull();
    const expectedTransform = invertRigidTransform(skyMotion);
    expect(alignment!.transform.rotationRadians * radiansToDegrees).toBeCloseTo(expectedTransform.rotationRadians * radiansToDegrees, 2);
    // Comparación por el efecto en las esquinas (la traslación sola depende del origen).
    for (const corner of [
      { x: 0, y: 0 },
      { x: width, y: height },
    ]) {
      const estimated = applyRigidTransform(alignment!.transform, corner);
      const expected = applyRigidTransform(expectedTransform, corner);
      expect(Math.hypot(estimated.x - expected.x, estimated.y - expected.y)).toBeLessThan(0.1);
    }
    expect(alignment!.matchedStarCount).toBeGreaterThan(80);
    expect(alignment!.rmsResidualPixels).toBeLessThan(0.15);
  });

  it('devuelve null con campos que no tienen nada que ver', () => {
    const unrelatedStars = randomStars(60, width, height, 99, 100, 10_000).sort((first, second) => second.flux - first.flux);
    expect(alignStarFields(referenceStars, unrelatedStars, { minimumMatchedStars: 8 })).toBeNull();
  });
});
