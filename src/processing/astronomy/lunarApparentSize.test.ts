import { createGaussianNoise } from '../image/syntheticMoon.testHelpers';
import {
  analyzeApparentSizeSeries,
  type ApparentSizeMeasurement,
  arcminutesToPixels,
  motoG57MainCamera,
  pixelScaleArcsecondsPerPixel,
  pixelsToArcminutes,
  predictLunarApparentSize,
  superMoonDiameterRatio,
  topocentricDistanceForAltitude,
  typicalApogeeDistanceKilometers,
  typicalPerigeeDistanceKilometers,
} from './lunarApparentSize';
import { julianDayFromDate, moonApparentDiameterArcminutes, moonHorizontalPosition } from './moonEphemeris';

const donostia = { latitudeDegrees: 43.32, longitudeDegrees: -1.98 };
const seriesStart = new Date('2026-09-26T16:00:00Z');

/** Instantes cada 30 min durante un día con la Luna a más de 5° de altura. */
const moonUpDates = Array.from({ length: 48 }, (_unused, stepIndex) => new Date(seriesStart.getTime() + stepIndex * 30 * 60_000)).filter(
  (date) => predictLunarApparentSize(donostia, date).altitudeDegrees > 5,
);

describe('diámetro aparente', () => {
  it('perigeo ~33,5′, apogeo ~29,4′ y superluna ~14 % mayor', () => {
    expect(moonApparentDiameterArcminutes(typicalPerigeeDistanceKilometers)).toBeCloseTo(33.5, 1);
    expect(moonApparentDiameterArcminutes(typicalApogeeDistanceKilometers)).toBeCloseTo(29.4, 1);
    expect(superMoonDiameterRatio()).toBeGreaterThan(1.13);
    expect(superMoonDiameterRatio()).toBeLessThan(1.15);
  });

  it('del horizonte al cenit la Luna crece ~1,5–1,7 % (está un radio terrestre más cerca)', () => {
    const geocentricDistance = 384_400;
    const horizonDistance = topocentricDistanceForAltitude(geocentricDistance, 0);
    const zenithDistance = topocentricDistanceForAltitude(geocentricDistance, 90);
    expect(zenithDistance).toBeCloseTo(geocentricDistance - 6378.14, 3);
    const growthPercent = 100 * (horizonDistance / zenithDistance - 1);
    expect(growthPercent).toBeGreaterThan(1.5);
    expect(growthPercent).toBeLessThan(1.75);
  });

  it('con las efemérides: el crecimiento sigue a (R⊕/Δ)·sen(h) y la altura coincide con moonHorizontalPosition', () => {
    expect(moonUpDates.length).toBeGreaterThan(10);
    for (const date of moonUpDates) {
      const prediction = predictLunarApparentSize(donostia, date);
      const expectedGrowth = (6378.14 / prediction.geocentricDistanceKilometers) * Math.sin((prediction.altitudeDegrees * Math.PI) / 180);
      const actualGrowth = prediction.topocentricDiameterArcminutes / prediction.geocentricDiameterArcminutes - 1;
      expect(Math.abs(actualGrowth - expectedGrowth)).toBeLessThan(0.0005);
      const referenceAltitude = moonHorizontalPosition(donostia, julianDayFromDate(date)).altitudeDegrees;
      expect(Math.abs(prediction.altitudeDegrees - referenceAltitude)).toBeLessThan(0.1);
    }
  });
});

describe('escala de la cámara', () => {
  it('moto g57: 68,6″/px y la Luna ocupa ~27 px', () => {
    expect(pixelScaleArcsecondsPerPixel(motoG57MainCamera)).toBeCloseTo(68.6, 1);
    expect(arcminutesToPixels(31, motoG57MainCamera)).toBeCloseTo(27.1, 1);
    expect(pixelsToArcminutes(arcminutesToPixels(31, motoG57MainCamera), motoG57MainCamera)).toBeCloseTo(31, 6);
  });
});

describe('serie de medidas', () => {
  const pixelsPerArcminute = 60 / pixelScaleArcsecondsPerPixel(motoG57MainCamera);

  function synthesizeSeries(diameterFromPrediction: (topocentric: number, geocentric: number) => number, noisePixels: number): ApparentSizeMeasurement[] {
    const gaussianNoise = createGaussianNoise(4);
    return moonUpDates.map((date) => {
      const prediction = predictLunarApparentSize(donostia, date);
      return {
        date,
        diameterPixels:
          pixelsPerArcminute * diameterFromPrediction(prediction.topocentricDiameterArcminutes, prediction.geocentricDiameterArcminutes) +
          noisePixels * gaussianNoise(),
        diameterUncertaintyPixels: noisePixels,
      };
    });
  }

  it('ajusta la escala y confirma que la Luna baja es más pequeña', () => {
    const analysis = analyzeApparentSizeSeries(synthesizeSeries((topocentric) => topocentric, 0.02), donostia, motoG57MainCamera)!;
    expect(Math.abs(analysis.fittedArcsecondsPerPixel / 68.6 - 1)).toBeLessThan(0.003);
    expect(analysis.impliedFocalLengthMillimeters).toBeCloseTo(4.81, 1);
    expect(analysis.reducedChiSquared).toBeLessThan(3);
    // R⊕/Δ: entre 6378/406700 (apogeo) y 6378/356500 (perigeo).
    expect(analysis.predictedGrowthPerSineAltitude).toBeGreaterThan(0.0156);
    expect(analysis.predictedGrowthPerSineAltitude).toBeLessThan(0.0179);
    expect(analysis.predictedLowToHighPercent).toBeGreaterThan(0.5);
    expect(analysis.moonIllusionVerdict).toBe('consistentWithGeometry');
    for (const measurement of analysis.measurements) expect(Math.abs(measurement.residualPixels)).toBeLessThan(0.1);
  });

  it('detecta medidas en que la Luna baja sale más grande', () => {
    const invertedSeries = synthesizeSeries((topocentric, geocentric) => geocentric * (2 - topocentric / geocentric), 0.02);
    expect(analyzeApparentSizeSeries(invertedSeries, donostia)!.moonIllusionVerdict).toBe('horizonLarger');
  });

  it('con demasiado ruido no se pronuncia', () => {
    expect(analyzeApparentSizeSeries(synthesizeSeries((topocentric) => topocentric, 1), donostia)!.moonIllusionVerdict).toBe('inconclusive');
    expect(analyzeApparentSizeSeries([], donostia)).toBeNull();
  });
});
