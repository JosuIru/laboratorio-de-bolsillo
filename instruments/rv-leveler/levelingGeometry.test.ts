import {
  applyZeroOffset,
  computeFourWheelLifts,
  computeSingleAxleLeveling,
  isVehicleLevel,
  vehicleTiltFromPhoneTilt,
  zeroOffsetFromInversion,
} from './levelingGeometry';

const degreesForRise = (riseCentimeters: number, distanceCentimeters: number) =>
  (Math.asin(riseCentimeters / distanceCentimeters) * 180) / Math.PI;

describe('computeFourWheelLifts', () => {
  it('un vehículo a nivel no necesita calzos', () => {
    const wheelLifts = computeFourWheelLifts({ lateralTiltDegrees: 0, longitudinalTiltDegrees: 0 }, 180, 400);
    for (const liftCentimeters of Object.values(wheelLifts)) expect(liftCentimeters).toBeCloseTo(0, 10);
  });

  it('con el lado derecho más alto se calzan las dos ruedas izquierdas', () => {
    const lateralTiltDegrees = degreesForRise(6, 180);
    const wheelLifts = computeFourWheelLifts({ lateralTiltDegrees, longitudinalTiltDegrees: 0 }, 180, 400);
    expect(wheelLifts.frontLeftLiftCentimeters).toBeCloseTo(6, 6);
    expect(wheelLifts.rearLeftLiftCentimeters).toBeCloseTo(6, 6);
    expect(wheelLifts.frontRightLiftCentimeters).toBeCloseTo(0, 6);
    expect(wheelLifts.rearRightLiftCentimeters).toBeCloseTo(0, 6);
    expect(wheelLifts.frontAxleLiftCentimeters).toBeCloseTo(3, 6);
  });

  it('con el morro bajo se calza el eje delantero', () => {
    const longitudinalTiltDegrees = -degreesForRise(8, 400);
    const wheelLifts = computeFourWheelLifts({ lateralTiltDegrees: 0, longitudinalTiltDegrees }, 180, 400);
    expect(wheelLifts.frontLeftLiftCentimeters).toBeCloseTo(8, 6);
    expect(wheelLifts.frontRightLiftCentimeters).toBeCloseTo(8, 6);
    expect(wheelLifts.rearLeftLiftCentimeters).toBeCloseTo(0, 6);
    expect(wheelLifts.frontAxleLiftCentimeters).toBeCloseTo(8, 6);
    expect(wheelLifts.rearAxleLiftCentimeters).toBeCloseTo(0, 6);
  });

  it('con las dos inclinaciones, la rueda más alta queda a 0 y las alturas se suman', () => {
    // Derecha más alta (3 cm en la vía) y morro más alto (4 cm en la batalla): la más baja es la trasera izquierda.
    const vehicleTilt = { lateralTiltDegrees: degreesForRise(3, 180), longitudinalTiltDegrees: degreesForRise(4, 400) };
    const wheelLifts = computeFourWheelLifts(vehicleTilt, 180, 400);
    expect(wheelLifts.frontRightLiftCentimeters).toBeCloseTo(0, 6);
    expect(wheelLifts.frontLeftLiftCentimeters).toBeCloseTo(3, 6);
    expect(wheelLifts.rearRightLiftCentimeters).toBeCloseTo(4, 6);
    expect(wheelLifts.rearLeftLiftCentimeters).toBeCloseTo(7, 6);
    expect(Math.min(...Object.values(wheelLifts))).toBeCloseTo(0, 6);
  });
});

describe('computeSingleAxleLeveling', () => {
  it('calza la rueda baja y sube el morro lo que haga falta', () => {
    // Izquierda más alta 4 cm en la vía; morro 10 cm más bajo que el eje, jockey a 400 cm.
    const vehicleTilt = { lateralTiltDegrees: -degreesForRise(4, 200), longitudinalTiltDegrees: -degreesForRise(10, 400) };
    const leveling = computeSingleAxleLeveling(vehicleTilt, 200, 400);
    expect(leveling.leftWheelLiftCentimeters).toBeCloseTo(0, 6);
    expect(leveling.rightWheelLiftCentimeters).toBeCloseTo(4, 6);
    // El centro del eje sube 2 cm al calzar: el morro tiene que subir 10 + 2.
    expect(leveling.jockeyWheelChangeCentimeters).toBeCloseTo(12, 6);
  });

  it('con el morro alto indica bajarlo (valor negativo)', () => {
    const vehicleTilt = { lateralTiltDegrees: 0, longitudinalTiltDegrees: degreesForRise(5, 350) };
    const leveling = computeSingleAxleLeveling(vehicleTilt, 200, 350);
    expect(leveling.leftWheelLiftCentimeters).toBeCloseTo(0, 6);
    expect(leveling.rightWheelLiftCentimeters).toBeCloseTo(0, 6);
    expect(leveling.jockeyWheelChangeCentimeters).toBeCloseTo(-5, 6);
  });
});

describe('isVehicleLevel', () => {
  it('usa la tolerancia en los dos ejes por separado', () => {
    expect(isVehicleLevel({ lateralTiltDegrees: 0.2, longitudinalTiltDegrees: -0.25 })).toBe(true);
    expect(isVehicleLevel({ lateralTiltDegrees: 0.35, longitudinalTiltDegrees: 0 })).toBe(false);
    expect(isVehicleLevel({ lateralTiltDegrees: 0, longitudinalTiltDegrees: -0.4 })).toBe(false);
  });
});

describe('cero por inversión', () => {
  it('separa el desfase del móvil de la inclinación del suelo', () => {
    const floorTilt = { tiltXDegrees: 1.2, tiltYDegrees: -0.8 };
    const phoneOffset = { tiltXDegrees: 0.4, tiltYDegrees: 0.3 };
    const firstReading = {
      tiltXDegrees: floorTilt.tiltXDegrees + phoneOffset.tiltXDegrees,
      tiltYDegrees: floorTilt.tiltYDegrees + phoneOffset.tiltYDegrees,
    };
    // Girado 180°, el móvil ve el suelo con los dos ejes invertidos.
    const rotatedReading = {
      tiltXDegrees: -floorTilt.tiltXDegrees + phoneOffset.tiltXDegrees,
      tiltYDegrees: -floorTilt.tiltYDegrees + phoneOffset.tiltYDegrees,
    };
    const zeroOffset = zeroOffsetFromInversion(firstReading, rotatedReading);
    expect(zeroOffset.tiltXDegrees).toBeCloseTo(0.4, 10);
    expect(zeroOffset.tiltYDegrees).toBeCloseTo(0.3, 10);

    const correctedTilt = applyZeroOffset(firstReading, zeroOffset);
    expect(correctedTilt.tiltXDegrees).toBeCloseTo(1.2, 10);
    expect(correctedTilt.tiltYDegrees).toBeCloseTo(-0.8, 10);
  });

  it('traduce los ejes del móvil a los del vehículo', () => {
    expect(vehicleTiltFromPhoneTilt({ tiltXDegrees: 1, tiltYDegrees: -2 })).toEqual({
      lateralTiltDegrees: 1,
      longitudinalTiltDegrees: -2,
    });
  });
});
