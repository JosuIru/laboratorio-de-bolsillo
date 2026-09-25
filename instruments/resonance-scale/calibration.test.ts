import { buildScaleModel, type CalibrationPoint } from '@/processing/resonanceScale/massCalibration';

import { validateResonanceScaleCalibration } from './calibration';

const calibrationPoints: CalibrationPoint[] = [0, 15, 30].map((massGrams) => ({
  massGrams,
  amplitudeRms: 400 / (190 + massGrams),
  amplitudeSpreadRms: 0.02,
  peakFrequencyHz: massGrams === 30 ? null : 170,
  peakFrequencySpreadHz: massGrams === 30 ? null : 0.5,
  pulseCount: 6,
}));

describe('validateResonanceScaleCalibration', () => {
  const scaleModel = buildScaleModel(calibrationPoints, 'inverse-amplitude')!;

  it('acepta una calibración guardada (también tras pasar por JSON)', () => {
    const storedParameters = JSON.parse(JSON.stringify({ model: scaleModel, points: calibrationPoints }));
    expect(validateResonanceScaleCalibration(storedParameters)).toEqual({ model: scaleModel, points: calibrationPoints });
  });

  it('rechaza modelos o puntos corruptos', () => {
    expect(() => validateResonanceScaleCalibration(null)).toThrow();
    expect(() => validateResonanceScaleCalibration({ model: scaleModel })).toThrow();
    expect(() => validateResonanceScaleCalibration({ model: { ...scaleModel, feature: 'color' }, points: [] })).toThrow();
    expect(() => validateResonanceScaleCalibration({ model: { ...scaleModel, slope: 0 }, points: [] })).toThrow();
    expect(() => validateResonanceScaleCalibration({ model: { ...scaleModel, pointCount: 2 }, points: [] })).toThrow();
    expect(() =>
      validateResonanceScaleCalibration({ model: scaleModel, points: [{ ...calibrationPoints[0], massGrams: 'mucho' }] }),
    ).toThrow();
  });
});
