import {
  computeLunarNorthAngleInImageDegrees,
  computeLunarOrientation,
  computeParallacticAngleDegrees,
  signedDegrees,
} from './lunarOrientation';
import { greenwichMeanSiderealTimeDegrees, julianDayFromDate } from './moonEphemeris';
import { projectSelenographicPoint } from './lunarFeatures';

/** 1992-04-12 0h TD: el día de los ejemplos 47.a, 48.a y 53.a de Meeus. */
const meeusExampleJulianDay = 2448724.5;

describe('computeLunarOrientation', () => {
  const orientation = computeLunarOrientation(meeusExampleJulianDay);

  it('reproduce la libración óptica del ejemplo 53.a de Meeus', () => {
    // Libración óptica: l′ = −1,206°, b′ = +4,194° (la total, con la física, es −1,23° y +4,20°).
    expect(orientation.librationLongitudeDegrees).toBeCloseTo(-1.206, 1);
    expect(Math.abs(orientation.librationLongitudeDegrees - -1.206)).toBeLessThan(0.03);
    expect(Math.abs(orientation.librationLatitudeDegrees - 4.194)).toBeLessThan(0.03);
  });

  it('reproduce el ángulo de posición del eje del ejemplo 53.a (P = 15,08°)', () => {
    expect(Math.abs(orientation.axisPositionAngleDegrees - 15.08)).toBeLessThan(0.1);
  });

  it('reproduce el limbo iluminado y la fase del ejemplo 48.a (χ = 285,0°, k = 0,6786)', () => {
    expect(Math.abs(orientation.brightLimbPositionAngleDegrees - 285.0)).toBeLessThan(0.3);
    expect(orientation.illuminatedFraction).toBeCloseTo(0.6786, 2);
  });

  it('el punto subsolar, proyectado con el norte celeste arriba, cae en la dirección del limbo iluminado', () => {
    for (const dayOffset of [0, 3.3, 9.7, 17.2, 24.5]) {
      const julianDay = meeusExampleJulianDay + dayOffset;
      const dayOrientation = computeLunarOrientation(julianDay);
      const projectedSubsolarPoint = projectSelenographicPoint(dayOrientation.subsolarPoint, {
        centerX: 0,
        centerY: 0,
        radiusPixels: 1,
        librationLongitudeDegrees: dayOrientation.librationLongitudeDegrees,
        librationLatitudeDegrees: dayOrientation.librationLatitudeDegrees,
        northAngleDegrees: dayOrientation.axisPositionAngleDegrees,
      });
      // Ángulo de posición: desde arriba, hacia la izquierda (el este en el cielo).
      const positionAngleDegrees =
        (Math.atan2(-projectedSubsolarPoint.imageX, -projectedSubsolarPoint.imageY) * 180) / Math.PI;
      expect(Math.abs(signedDegrees(positionAngleDegrees - dayOrientation.brightLimbPositionAngleDegrees))).toBeLessThan(1);
    }
  });

  it('la libración se mantiene en sus márgenes (±8° en longitud, ±7° en latitud) y P en ±25°', () => {
    const startJulianDay = julianDayFromDate(new Date('2026-01-01T00:00:00Z'));
    for (let dayIndex = 0; dayIndex < 400; dayIndex += 1.7) {
      const dayOrientation = computeLunarOrientation(startJulianDay + dayIndex);
      expect(Math.abs(dayOrientation.librationLongitudeDegrees)).toBeLessThan(8.2);
      expect(Math.abs(dayOrientation.librationLatitudeDegrees)).toBeLessThan(7);
      expect(Math.abs(dayOrientation.axisPositionAngleDegrees)).toBeLessThan(25);
    }
  });

  it('en luna llena el punto subsolar está cerca del centro visible y en luna nueva en la cara oculta', () => {
    // Luna llena del 3 de marzo de 2026 (eclipse total) y luna nueva del 17 de febrero de 2026.
    const fullMoon = computeLunarOrientation(julianDayFromDate(new Date('2026-03-03T11:38:00Z')));
    expect(Math.abs(signedDegrees(fullMoon.subsolarPoint.longitudeDegrees - fullMoon.librationLongitudeDegrees))).toBeLessThan(3);
    expect(fullMoon.illuminatedFraction).toBeGreaterThan(0.99);
    const newMoon = computeLunarOrientation(julianDayFromDate(new Date('2026-02-17T12:01:00Z')));
    expect(Math.abs(signedDegrees(newMoon.subsolarPoint.longitudeDegrees - newMoon.librationLongitudeDegrees))).toBeGreaterThan(170);
  });
});

describe('computeParallacticAngleDegrees', () => {
  const observerLocation = { latitudeDegrees: 43.3, longitudeDegrees: -2.0 };
  const julianDay = meeusExampleJulianDay;
  const localSiderealTime = greenwichMeanSiderealTimeDegrees(julianDay) + observerLocation.longitudeDegrees;

  it('vale 0 en el meridiano (al sur del cenit) y cambia de signo al cruzarlo', () => {
    const onMeridian = { rightAscensionDegrees: localSiderealTime, declinationDegrees: 10 };
    expect(computeParallacticAngleDegrees(onMeridian, observerLocation, julianDay)).toBeCloseTo(0, 6);
    const rising = { rightAscensionDegrees: localSiderealTime + 40, declinationDegrees: 10 };
    const setting = { rightAscensionDegrees: localSiderealTime - 40, declinationDegrees: 10 };
    const risingAngle = computeParallacticAngleDegrees(rising, observerLocation, julianDay);
    const settingAngle = computeParallacticAngleDegrees(setting, observerLocation, julianDay);
    expect(risingAngle).toBeLessThan(0);
    expect(settingAngle).toBeCloseTo(-risingAngle, 6);
  });

  it('en el ecuador, un astro en el ecuador celeste que sale por el este tiene q = −90°', () => {
    const equatorialObserver = { latitudeDegrees: 0, longitudeDegrees: 0 };
    const equatorialSidereal = greenwichMeanSiderealTimeDegrees(julianDay);
    const risingStar = { rightAscensionDegrees: equatorialSidereal + 60, declinationDegrees: 0 };
    expect(computeParallacticAngleDegrees(risingStar, equatorialObserver, julianDay)).toBeCloseTo(-90, 6);
  });
});

describe('computeLunarNorthAngleInImageDegrees', () => {
  it('combina P, el ángulo paraláctico, el giro del móvil y el de la óptica', () => {
    expect(computeLunarNorthAngleInImageDegrees({ axisPositionAngleDegrees: 15, parallacticAngleDegrees: -30 })).toBeCloseTo(45);
    expect(
      computeLunarNorthAngleInImageDegrees({
        axisPositionAngleDegrees: 15,
        parallacticAngleDegrees: -30,
        deviceRollDegrees: 90,
        opticsRotationDegrees: 180,
      }),
    ).toBeCloseTo(135);
    expect(
      computeLunarNorthAngleInImageDegrees({ axisPositionAngleDegrees: 20, parallacticAngleDegrees: 30, opticsRotationDegrees: 180 }),
    ).toBeCloseTo(170);
  });
});
