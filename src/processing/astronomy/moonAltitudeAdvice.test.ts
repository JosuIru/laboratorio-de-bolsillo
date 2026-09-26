import { airMassKastenYoung, assessMoonAltitude, findBestMoonTimeTonight } from './moonAltitudeAdvice';
import {
  eclipticToEquatorial,
  equatorialToHorizontal,
  julianDayFromDate,
  moonEclipticPosition,
  moonHorizontalPosition,
  sunEclipticPosition,
} from './moonEphemeris';

const donostia = { latitudeDegrees: 43.32, longitudeDegrees: -1.98 };

describe('masa de aire', () => {
  it('1 en el cenit, ~2 a 30°, ~38 en el horizonte e infinita muy por debajo', () => {
    expect(airMassKastenYoung(90)).toBeCloseTo(1, 3);
    expect(airMassKastenYoung(30)).toBeCloseTo(2, 1);
    expect(airMassKastenYoung(0)).toBeGreaterThan(37);
    expect(airMassKastenYoung(0)).toBeLessThan(39);
    expect(airMassKastenYoung(-10)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('consejo por altura', () => {
  it('avisa por debajo de 25° y valora mejor cuanto más alta', () => {
    expect(assessMoonAltitude(-2).quality).toBe('belowHorizon');
    expect(assessMoonAltitude(5).quality).toBe('poor');
    expect(assessMoonAltitude(20).quality).toBe('fair');
    expect(assessMoonAltitude(20).warnings).toContain('lowAltitudeBlurAndTint');
    expect(assessMoonAltitude(35).quality).toBe('good');
    expect(assessMoonAltitude(35).warnings).toHaveLength(0);
    expect(assessMoonAltitude(60).quality).toBe('excellent');
    // La Luna baja se oscurece y enrojece más.
    expect(assessMoonAltitude(10).extinctionMagnitudes).toBeGreaterThan(assessMoonAltitude(60).extinctionMagnitudes);
    expect(assessMoonAltitude(10).blueMinusRedExtinctionMagnitudes).toBeGreaterThan(0.5);
  });
});

describe('mejor hora de la noche', () => {
  const startDate = new Date('2026-09-26T12:00:00Z');
  const bestTime = findBestMoonTimeTonight(donostia, startDate)!;

  it('es la Luna más alta con el Sol bajo −6°', () => {
    expect(bestTime).not.toBeNull();
    const startJulianDay = julianDayFromDate(startDate);
    for (let minuteIndex = 0; minuteIndex <= 24 * 60; minuteIndex += 7) {
      const julianDay = startJulianDay + minuteIndex / 1440;
      const sunAltitude = equatorialToHorizontal(eclipticToEquatorial(sunEclipticPosition(julianDay), julianDay), donostia, julianDay).altitudeDegrees;
      if (sunAltitude >= -6) continue;
      expect(moonHorizontalPosition(donostia, julianDay).altitudeDegrees).toBeLessThanOrEqual(bestTime.altitudeDegrees + 1e-6);
    }
    const bestJulianDay = julianDayFromDate(bestTime.bestDate);
    const sunAltitudeAtBest = equatorialToHorizontal(eclipticToEquatorial(sunEclipticPosition(bestJulianDay), bestJulianDay), donostia, bestJulianDay).altitudeDegrees;
    expect(sunAltitudeAtBest).toBeLessThan(-6);
  });

  it('la culminación sube hasta 90° − |φ − δ| (menos el paralaje)', () => {
    const culminationJulianDay = julianDayFromDate(bestTime.culminationDate);
    const declination = eclipticToEquatorial(moonEclipticPosition(culminationJulianDay), culminationJulianDay).declinationDegrees;
    const expectedAltitude = 90 - Math.abs(donostia.latitudeDegrees - declination);
    expect(bestTime.culminationAltitudeDegrees).toBeLessThan(expectedAltitude);
    expect(bestTime.culminationAltitudeDegrees).toBeGreaterThan(expectedAltitude - 1.2);
    if (bestTime.isCulmination) expect(Math.abs(bestTime.bestDate.getTime() - bestTime.culminationDate.getTime())).toBeLessThan(60_000);
  });

  it('sin noche (verano en Svalbard) no hay mejor hora', () => {
    expect(findBestMoonTimeTonight({ latitudeDegrees: 78.2, longitudeDegrees: 15.6 }, new Date('2026-06-21T12:00:00Z'))).toBeNull();
  });
});
