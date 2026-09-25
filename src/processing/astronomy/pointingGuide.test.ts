import {
  cameraPointingFromAxes,
  computePointingGuidance,
  type DeviceVector,
  smoothVector,
  worldAxesFromSensors,
} from './pointingGuide';

const degreesToRadians = Math.PI / 180;
/** Inclinación magnética aproximada en la península ibérica. */
const magneticDipDegrees = 57;

type WorldVector = [east: number, north: number, up: number];

function dotProduct(first: WorldVector, second: WorldVector): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

/**
 * Lecturas simuladas de los sensores con la cámara trasera mirando a (acimut, altura) y el móvil
 * girado `rollDegrees` sobre su eje z (0 = vertical, -90 = apaisado con la derecha hacia arriba).
 */
function simulateSensors(cameraAzimuthDegrees: number, cameraElevationDegrees: number, rollDegrees = 0) {
  const azimuth = cameraAzimuthDegrees * degreesToRadians;
  const elevation = cameraElevationDegrees * degreesToRadians;
  const roll = rollDegrees * degreesToRadians;
  const cameraDirection: WorldVector = [
    Math.sin(azimuth) * Math.cos(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
  ];
  const deviceZ: WorldVector = [-cameraDirection[0], -cameraDirection[1], -cameraDirection[2]];
  const uprightY: WorldVector = [
    -Math.sin(azimuth) * Math.sin(elevation),
    -Math.cos(azimuth) * Math.sin(elevation),
    Math.cos(elevation),
  ];
  const uprightX: WorldVector = [
    uprightY[1] * deviceZ[2] - uprightY[2] * deviceZ[1],
    uprightY[2] * deviceZ[0] - uprightY[0] * deviceZ[2],
    uprightY[0] * deviceZ[1] - uprightY[1] * deviceZ[0],
  ];
  const combine = (firstWeight: number, first: WorldVector, secondWeight: number, second: WorldVector): WorldVector => [
    firstWeight * first[0] + secondWeight * second[0],
    firstWeight * first[1] + secondWeight * second[1],
    firstWeight * first[2] + secondWeight * second[2],
  ];
  const deviceX = combine(Math.cos(roll), uprightX, -Math.sin(roll), uprightY);
  const deviceY = combine(Math.sin(roll), uprightX, Math.cos(roll), uprightY);
  const toDevice = (worldVector: WorldVector): DeviceVector => ({
    x: dotProduct(worldVector, deviceX),
    y: dotProduct(worldVector, deviceY),
    z: dotProduct(worldVector, deviceZ),
  });
  const magneticField: WorldVector = [
    0,
    40 * Math.cos(magneticDipDegrees * degreesToRadians),
    -40 * Math.sin(magneticDipDegrees * degreesToRadians),
  ];
  return { upwardAcceleration: toDevice([0, 0, 9.81]), magneticField: toDevice(magneticField) };
}

function axesFor(cameraAzimuthDegrees: number, cameraElevationDegrees: number, rollDegrees = 0) {
  const { upwardAcceleration, magneticField } = simulateSensors(cameraAzimuthDegrees, cameraElevationDegrees, rollDegrees);
  return worldAxesFromSensors(upwardAcceleration, magneticField)!;
}

describe('orientación de la cámara', () => {
  it.each([
    [0, 0],
    [110, 17],
    [250, 45],
    [359, -10],
  ])('reconoce acimut %s° y altura %s°', (cameraAzimuthDegrees, cameraElevationDegrees) => {
    const cameraPointing = cameraPointingFromAxes(axesFor(cameraAzimuthDegrees, cameraElevationDegrees));
    expect(cameraPointing.azimuthDegrees).toBeCloseTo(cameraAzimuthDegrees, 6);
    expect(cameraPointing.elevationDegrees).toBeCloseTo(cameraElevationDegrees, 6);
  });

  it('no depende de cómo esté girado el móvil', () => {
    const cameraPointing = cameraPointingFromAxes(axesFor(110, 17, 70));
    expect(cameraPointing.azimuthDegrees).toBeCloseTo(110, 6);
    expect(cameraPointing.elevationDegrees).toBeCloseTo(17, 6);
  });

  it('devuelve null con vectores paralelos o nulos', () => {
    expect(worldAxesFromSensors({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBeNull();
    expect(worldAxesFromSensors({ x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 })).toBeNull();
  });
});

describe('guía para apuntar', () => {
  it('con el astro centrado, la distancia es cero', () => {
    const guidance = computePointingGuidance(axesFor(110, 17), 110, 17);
    expect(guidance.angularDistanceDegrees).toBeCloseTo(0, 4);
    expect(guidance.turnRightDegrees).toBeCloseTo(0, 6);
    expect(guidance.raiseDegrees).toBeCloseTo(0, 6);
  });

  it('señala a la derecha, arriba o abajo según dónde esté', () => {
    const rightGuidance = computePointingGuidance(axesFor(90, 0), 120, 0);
    expect(rightGuidance.turnRightDegrees).toBeCloseTo(30, 6);
    expect(rightGuidance.screenArrowAngleDegrees).toBeCloseTo(0, 4);
    expect(rightGuidance.angularDistanceDegrees).toBeCloseTo(30, 4);

    const upGuidance = computePointingGuidance(axesFor(90, 0), 90, 40);
    expect(upGuidance.raiseDegrees).toBeCloseTo(40, 6);
    expect(upGuidance.screenArrowAngleDegrees).toBeCloseTo(90, 4);

    const leftDownGuidance = computePointingGuidance(axesFor(10, 20), 340, 5);
    expect(leftDownGuidance.turnRightDegrees).toBeCloseTo(-30, 6);
    expect(leftDownGuidance.raiseDegrees).toBeCloseTo(-15, 6);
    expect(Math.abs(leftDownGuidance.screenArrowAngleDegrees)).toBeGreaterThan(90);
  });

  it('gira la flecha si el móvil está apaisado', () => {
    // Con el móvil girado 90° (la derecha de la pantalla hacia arriba), «arriba» es la derecha de la pantalla.
    const guidance = computePointingGuidance(axesFor(90, 0, -90), 90, 40);
    expect(guidance.screenArrowAngleDegrees).toBeCloseTo(0, 4);
    // Y con la derecha hacia abajo, hacia la izquierda.
    expect(Math.abs(computePointingGuidance(axesFor(90, 0, 90), 90, 40).screenArrowAngleDegrees)).toBeCloseTo(180, 4);
  });

  it('resuelve el giro por el camino corto al cruzar el norte', () => {
    expect(computePointingGuidance(axesFor(350, 0), 20, 0).turnRightDegrees).toBeCloseTo(30, 6);
  });
});

describe('suavizado', () => {
  it('se acerca a la nueva muestra según el factor', () => {
    expect(smoothVector(null, { x: 1, y: 2, z: 3 }, 0.2)).toEqual({ x: 1, y: 2, z: 3 });
    expect(smoothVector({ x: 0, y: 0, z: 0 }, { x: 10, y: -10, z: 5 }, 0.2)).toEqual({ x: 2, y: -2, z: 1 });
  });
});
