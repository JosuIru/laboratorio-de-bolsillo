import {
  earthshineGeometryAtJulianDay,
  estimateEarthAlbedoFromEarthshine,
  lambertSpherePhaseFunction,
  lunarSurfacePhaseFunction,
  maximumModeledLunarPhaseAngleDegrees,
  predictEarthshineToSunlitRatio,
  typicalMareToHighlandAlbedoRatio,
} from './earthshineAlbedo';
import { findNextMoonPhaseJulianDay, julianDayFromDate } from './moonEphemeris';

describe('funciones de fase', () => {
  it('lambertiana: 1 llena, 1/π en cuadratura, 0 nueva', () => {
    expect(lambertSpherePhaseFunction(0)).toBeCloseTo(1, 6);
    expect(lambertSpherePhaseFunction(90)).toBeCloseTo(1 / Math.PI, 6);
    expect(lambertSpherePhaseFunction(180)).toBeCloseTo(0, 6);
  });

  it('superficie lunar: decrece con la fase', () => {
    let previousValue = lunarSurfacePhaseFunction(0);
    expect(previousValue).toBeCloseTo(1, 6);
    for (let phaseAngle = 10; phaseAngle <= maximumModeledLunarPhaseAngleDegrees; phaseAngle += 10) {
      const value = lunarSurfacePhaseFunction(phaseAngle);
      expect(value).toBeLessThan(previousValue);
      previousValue = value;
    }
  });
});

describe('albedo de la Tierra con la luz cenicienta', () => {
  it('un albedo de 0,30 da razones plausibles, del orden de 1e-4 a 1e-3 en fase creciente', () => {
    for (const lunarPhaseAngle of [110, 120, 130, 140, 150]) {
      const ratio = predictEarthshineToSunlitRatio(0.3, lunarPhaseAngle);
      expect(ratio).toBeGreaterThan(1e-4);
      expect(ratio).toBeLessThan(1e-3);
    }
  });

  it('la razón crece con el albedo y hacia la luna nueva (la Tierra se ve más «llena»)', () => {
    expect(predictEarthshineToSunlitRatio(0.4, 120)).toBeGreaterThan(predictEarthshineToSunlitRatio(0.3, 120));
    let previousRatio = 0;
    for (let lunarPhaseAngle = 60; lunarPhaseAngle <= maximumModeledLunarPhaseAngleDegrees; lunarPhaseAngle += 10) {
      const ratio = predictEarthshineToSunlitRatio(0.3, lunarPhaseAngle);
      expect(ratio).toBeGreaterThan(previousRatio);
      previousRatio = ratio;
    }
  });

  it('invierte la medida y da un intervalo con las incertidumbres', () => {
    const measuredRatio = predictEarthshineToSunlitRatio(0.3, 125, typicalMareToHighlandAlbedoRatio);
    const estimate = estimateEarthAlbedoFromEarthshine({
      earthshineToSunlitRatio: measuredRatio,
      ratioRelativeUncertainty: 0.1,
      lunarPhaseAngleDegrees: 125,
      darkToSunlitAlbedoRatio: typicalMareToHighlandAlbedoRatio,
    });
    expect(estimate.apparentBondAlbedo).toBeCloseTo(0.3, 6);
    expect(estimate.lowerBound).toBeLessThan(0.3);
    expect(estimate.upperBound).toBeGreaterThan(0.3);
    expect(estimate.relativeUncertainty).toBeGreaterThan(Math.hypot(0.1, 0.1));
    expect(estimate.earthPhaseAngleDegrees).toBeCloseTo(55, 6);
    expect(estimate.earthIlluminatedFraction).toBeGreaterThan(0.75);
    // Más brillo en la zona oscura ⇒ más albedo.
    const brighterEstimate = estimateEarthAlbedoFromEarthshine({
      earthshineToSunlitRatio: measuredRatio * 1.2,
      ratioRelativeUncertainty: 0.1,
      lunarPhaseAngleDegrees: 125,
      darkToSunlitAlbedoRatio: typicalMareToHighlandAlbedoRatio,
    });
    expect(brighterEstimate.apparentBondAlbedo).toBeCloseTo(0.36, 6);
  });

  it('geometría con las efemérides: en cuarto creciente θ ≈ β ≈ 90° y el Sol a la misma distancia', () => {
    const firstQuarterJulianDay = findNextMoonPhaseJulianDay(julianDayFromDate(new Date('2026-09-01T00:00:00Z')), 90);
    const geometry = earthshineGeometryAtJulianDay(firstQuarterJulianDay);
    expect(Math.abs(geometry.lunarPhaseAngleDegrees - 90)).toBeLessThan(1);
    expect(Math.abs(geometry.earthPhaseAngleDegrees - 90)).toBeLessThan(1);
    expect(Math.abs(geometry.sunDistanceRatioSquared - 1)).toBeLessThan(0.006);
    expect(geometry.earthMoonDistanceKilometers).toBeGreaterThan(356_000);
    expect(geometry.earthMoonDistanceKilometers).toBeLessThan(407_000);
  });
});
