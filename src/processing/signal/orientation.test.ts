import { tiltAnglesFromGravity } from './orientation';

describe('tiltAnglesFromGravity', () => {
  it('es 0 con el móvil plano boca arriba', () => {
    const tiltAngles = tiltAnglesFromGravity({ x: 0, y: 0, z: 9.81 });
    expect(tiltAngles.tiltXDegrees).toBeCloseTo(0);
    expect(tiltAngles.tiltYDegrees).toBeCloseTo(0);
  });

  it('da 45° al inclinar sobre un eje', () => {
    const componentAt45Degrees = 9.81 * Math.SQRT1_2;
    expect(tiltAnglesFromGravity({ x: componentAt45Degrees, y: 0, z: componentAt45Degrees }).tiltXDegrees).toBeCloseTo(45);
    expect(tiltAnglesFromGravity({ x: 0, y: -componentAt45Degrees, z: componentAt45Degrees }).tiltYDegrees).toBeCloseTo(-45);
  });

  it('da 90° con el móvil de canto', () => {
    expect(tiltAnglesFromGravity({ x: 9.81, y: 0, z: 0 }).tiltXDegrees).toBeCloseTo(90);
  });

  it('no depende de la magnitud (sirve en g o en m/s²)', () => {
    const tiltInG = tiltAnglesFromGravity({ x: 0.1, y: 0.2, z: 0.97 });
    const tiltInMetersPerSecondSquared = tiltAnglesFromGravity({ x: 0.981, y: 1.962, z: 9.5157 });
    expect(tiltInMetersPerSecondSquared.tiltXDegrees).toBeCloseTo(tiltInG.tiltXDegrees, 10);
    expect(tiltInMetersPerSecondSquared.tiltYDegrees).toBeCloseTo(tiltInG.tiltYDegrees, 10);
  });
});
