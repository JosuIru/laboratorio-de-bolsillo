import {
  expectedStackingGainMagnitudes,
  fieldOfViewForRegion,
  limitingMagnitudeFromStarCount,
  magnitudeDifference,
  siderealDriftPixelsPerSecond,
  skyStarCountBrighterThan,
} from './starFieldStatistics';

describe('fieldOfViewForRegion', () => {
  it('da la escala y el campo de una cámara de 26 mm equivalentes', () => {
    const fieldOfView = fieldOfViewForRegion({
      focalLength35mm: 26,
      photoWidthPixels: 3024,
      photoHeightPixels: 4032,
      regionWidthPixels: 3024,
      regionHeightPixels: 4032,
    });
    expect(fieldOfView.pixelScaleArcseconds).toBeCloseTo(68.1, 0);
    expect(fieldOfView.widthDegrees).toBeCloseTo(53.1, 0);
    expect(fieldOfView.heightDegrees).toBeCloseTo(67.3, 0);
    // En proyección gnomónica el ángulo sólido es menor que ancho × alto.
    expect(fieldOfView.solidAngleSquareDegrees).toBeLessThan(fieldOfView.widthDegrees * fieldOfView.heightDegrees);
    expect(fieldOfView.solidAngleSquareDegrees).toBeGreaterThan(0.8 * fieldOfView.widthDegrees * fieldOfView.heightDegrees);
  });

  it('un recorte pequeño con zoom es casi un rectángulo plano', () => {
    const fieldOfView = fieldOfViewForRegion({
      focalLength35mm: 26,
      photoWidthPixels: 3024,
      photoHeightPixels: 4032,
      regionWidthPixels: 512,
      regionHeightPixels: 512,
      zoomFactor: 2,
    });
    expect(fieldOfView.pixelScaleArcseconds).toBeCloseTo(34.05, 1);
    expect(fieldOfView.solidAngleSquareDegrees).toBeCloseTo(fieldOfView.widthDegrees * fieldOfView.heightDegrees, 1);
  });
});

describe('magnitud límite por recuento', () => {
  it('invierte la tabla de estrellas por magnitud', () => {
    expect(skyStarCountBrighterThan(5)).toBeCloseTo(1602, 0);
    expect(skyStarCountBrighterThan(6.5)).toBeGreaterThan(4800);
    expect(skyStarCountBrighterThan(6.5)).toBeLessThan(14_000);
    const fieldSquareDegrees = 8000;
    for (const magnitude of [2.5, 4, 5.3, 7.8]) {
      const expectedCount = (skyStarCountBrighterThan(magnitude) * fieldSquareDegrees) / 41_252.96;
      expect(limitingMagnitudeFromStarCount(expectedCount, fieldSquareDegrees)).toBeCloseTo(magnitude, 5);
    }
  });

  it('crece con el número de estrellas y no dice nada con muy pocas', () => {
    expect(limitingMagnitudeFromStarCount(400, 1500)!).toBeGreaterThan(limitingMagnitudeFromStarCount(100, 1500)!);
    expect(limitingMagnitudeFromStarCount(2, 1500)).toBeNull();
  });

  it('ganancia del apilado y diferencias de magnitud', () => {
    expect(expectedStackingGainMagnitudes(100)).toBeCloseTo(2.5, 9);
    expect(expectedStackingGainMagnitudes(1)).toBe(0);
    expect(magnitudeDifference(100, 1)).toBeCloseTo(5, 9);
  });

  it('deriva sideral en píxeles', () => {
    expect(siderealDriftPixelsPerSecond(68, 0)).toBeCloseTo(15.041 / 68, 9);
    expect(siderealDriftPixelsPerSecond(68, 60)).toBeCloseTo(15.041 / 68 / 2, 9);
  });
});
