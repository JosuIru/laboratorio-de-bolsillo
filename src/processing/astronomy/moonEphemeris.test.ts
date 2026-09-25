import {
  compassPointIndex,
  computeMoonReport,
  dateFromJulianDay,
  equatorialToHorizontal,
  findNextMoonPhaseJulianDay,
  findNextMoonRiseAndSet,
  greenwichMeanSiderealTimeDegrees,
  julianDayFromDate,
  moonApparentDiameterArcminutes,
  moonEclipticPosition,
  moonHorizontalPosition,
  moonIlluminatedFraction,
  moonPhaseName,
} from './moonEphemeris';

const fiveMinutesInMilliseconds = 5 * 60_000;

function expectDateNear(actualDate: Date, expectedIsoDate: string, toleranceMilliseconds: number) {
  expect(Math.abs(actualDate.getTime() - Date.parse(expectedIsoDate))).toBeLessThan(toleranceMilliseconds);
}

describe('fecha juliana', () => {
  it('convierte ida y vuelta', () => {
    const date = new Date('2024-04-08T18:21:00Z');
    expect(dateFromJulianDay(julianDayFromDate(date)).getTime()).toBeCloseTo(date.getTime(), -1);
    expect(julianDayFromDate(new Date('2000-01-01T12:00:00Z'))).toBe(2_451_545);
  });

  it('calcula el tiempo sidéreo de Greenwich (Meeus, ejemplo 12.a)', () => {
    expect(greenwichMeanSiderealTimeDegrees(2_446_895.5)).toBeCloseTo(197.693195, 4);
  });
});

describe('posición de la Luna', () => {
  it('coincide con el ejemplo 47.a de Meeus', () => {
    const moonPosition = moonEclipticPosition(2_448_724.5);
    expect(moonPosition.longitudeDegrees).toBeCloseTo(133.162655, 2);
    expect(moonPosition.latitudeDegrees).toBeCloseTo(-3.229126, 2);
    expect(Math.abs(moonPosition.distanceKilometers - 368_409.7)).toBeLessThan(20);
  });

  it('calcula la fracción iluminada del ejemplo 48.a de Meeus', () => {
    expect(moonIlluminatedFraction(2_448_724.5)).toBeCloseTo(0.6786, 3);
  });

  it('pasa de ecuatoriales a horizontales (Meeus, ejemplo 13.b)', () => {
    const horizontalPosition = equatorialToHorizontal(
      { rightAscensionDegrees: 347.3193375, declinationDegrees: -6.719892 },
      { latitudeDegrees: 38.921389, longitudeDegrees: -77.065556 },
      2_446_896.30625,
    );
    expect(horizontalPosition.azimuthDegrees).toBeCloseTo(248.0337, 2);
    expect(horizontalPosition.altitudeDegrees).toBeCloseTo(15.1249, 2);
  });
});

describe('fases', () => {
  it.each([
    ['luna nueva (eclipse total)', '2024-04-01T00:00:00Z', 0, '2024-04-08T18:21:00Z'],
    ['cuarto creciente', '2024-04-10T00:00:00Z', 90, '2024-04-15T19:13:00Z'],
    ['luna llena', '2024-04-10T00:00:00Z', 180, '2024-04-23T23:49:00Z'],
    ['luna llena', '2025-01-01T00:00:00Z', 180, '2025-01-13T22:27:00Z'],
  ])('encuentra la %s', (_phaseLabel, startIsoDate, targetPhaseAngleDegrees, expectedIsoDate) => {
    const phaseJulianDay = findNextMoonPhaseJulianDay(julianDayFromDate(new Date(startIsoDate)), targetPhaseAngleDegrees);
    expectDateNear(dateFromJulianDay(phaseJulianDay), expectedIsoDate, fiveMinutesInMilliseconds);
  });

  it('nombra las fases por sectores de 45°', () => {
    expect(moonPhaseName(0)).toBe('newMoon');
    expect(moonPhaseName(359)).toBe('newMoon');
    expect(moonPhaseName(45)).toBe('waxingCrescent');
    expect(moonPhaseName(90)).toBe('firstQuarter');
    expect(moonPhaseName(180)).toBe('fullMoon');
    expect(moonPhaseName(250)).toBe('lastQuarter');
    expect(moonPhaseName(320)).toBe('waningCrescent');
  });

  it('resume la Luna en plena luna llena', () => {
    const moonReport = computeMoonReport(new Date('2024-04-23T23:49:00Z'));
    expect(moonReport.phaseName).toBe('fullMoon');
    expect(moonReport.illuminatedFraction).toBeGreaterThan(0.99);
    // De la luna nueva del 8 de abril a la llena del 23: 15,2 días.
    expect(moonReport.ageDays).toBeCloseTo(15.23, 1);
    expectDateNear(moonReport.nextNewMoon, '2024-05-08T03:22:00Z', fiveMinutesInMilliseconds);
    expect(moonReport.apparentDiameterArcminutes).toBeGreaterThan(29);
    expect(moonReport.apparentDiameterArcminutes).toBeLessThan(34);
    expect(moonReport.horizontalPosition).toBeUndefined();
  });
});

describe('posición para el observador', () => {
  const bilbao = { latitudeDegrees: 43.263, longitudeDegrees: -2.935 };

  it('la luna llena está alta hacia el sur a medianoche solar', () => {
    // Luna llena del 13-1-2025: a la medianoche solar de Bilbao (~0:12 UTC) culmina alta al sur.
    const horizontalPosition = moonHorizontalPosition(bilbao, julianDayFromDate(new Date('2025-01-14T00:12:00Z')));
    expect(horizontalPosition.altitudeDegrees).toBeGreaterThan(55);
    expect(Math.abs(horizontalPosition.azimuthDegrees - 180)).toBeLessThan(15);
  });

  it('encuentra salida y puesta en las que la Luna cruza el horizonte', () => {
    const startJulianDay = julianDayFromDate(new Date('2025-01-13T00:00:00Z'));
    const { nextRiseJulianDay, nextSetJulianDay } = findNextMoonRiseAndSet(bilbao, startJulianDay);
    expect(nextRiseJulianDay).not.toBeNull();
    expect(nextSetJulianDay).not.toBeNull();
    for (const crossingJulianDay of [nextRiseJulianDay!, nextSetJulianDay!]) {
      expect(Math.abs(moonHorizontalPosition(bilbao, crossingJulianDay).altitudeDegrees + 0.825)).toBeLessThan(0.05);
    }
    const altitudeJustAfterRise = moonHorizontalPosition(bilbao, nextRiseJulianDay! + 0.01).altitudeDegrees;
    expect(altitudeJustAfterRise).toBeGreaterThan(-0.825);
    // En luna llena sale al atardecer y se pone al amanecer: unas 12 h de diferencia.
    expect(Math.abs(nextSetJulianDay! - nextRiseJulianDay!)).toBeGreaterThan(0.3);
  });

  it('incluye posición, salida y puesta en el resumen si hay ubicación', () => {
    const moonReport = computeMoonReport(new Date('2025-01-14T00:12:00Z'), bilbao);
    expect(moonReport.horizontalPosition).toBeDefined();
    expect(moonReport.nextRise).toBeInstanceOf(Date);
    expect(moonReport.nextSet).toBeInstanceOf(Date);
  });
});

describe('utilidades', () => {
  it('calcula el diámetro aparente en perigeo y apogeo', () => {
    expect(moonApparentDiameterArcminutes(356_500)).toBeCloseTo(33.5, 1);
    expect(moonApparentDiameterArcminutes(406_700)).toBeCloseTo(29.4, 1);
  });

  it('asigna puntos cardinales', () => {
    expect(compassPointIndex(0)).toBe(0);
    expect(compassPointIndex(355)).toBe(0);
    expect(compassPointIndex(90)).toBe(4);
    expect(compassPointIndex(181)).toBe(8);
    expect(compassPointIndex(270)).toBe(12);
  });
});
