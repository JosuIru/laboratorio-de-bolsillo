import {
  amplitudeChangePercentPerTenGrams,
  buildScaleModel,
  type CalibrationPoint,
  computeTareOffset,
  estimateMass,
  featureUncertainty,
  featureValue,
  fitCalibration,
  fitStraightLine,
  massOfCoins,
  type ResponseMeasurement,
  responseMeasurementFromAnalysis,
} from './massCalibration';
import { analyzePulseResponse } from './pulseResponse';
import { createSyntheticPulseRecording } from './syntheticRecording';

/** Sistema físico de juguete: a = F / (M + m) con un móvil de 190 g. */
const phoneMassGrams = 190;
const driveForce = 400;

function simulatedMeasurement(
  massGrams: number,
  { relativeSpread = 0.01, frequencyHz = 170 as number | null, frequencySpreadHz = 0.5 } = {},
): ResponseMeasurement {
  return {
    amplitudeRms: driveForce / (phoneMassGrams + massGrams),
    amplitudeSpreadRms: (relativeSpread * driveForce) / (phoneMassGrams + massGrams),
    peakFrequencyHz: frequencyHz,
    peakFrequencySpreadHz: frequencyHz === null ? null : frequencySpreadHz,
    pulseCount: 6,
  };
}

function calibrationPoint(massGrams: number, options?: Parameters<typeof simulatedMeasurement>[1]): CalibrationPoint {
  return { massGrams, ...simulatedMeasurement(massGrams, options) };
}

describe('monedas', () => {
  it('suma las masas oficiales', () => {
    expect(massOfCoins({ oneEuro: 2, twoEuros: 1, fiftyCents: 1 })).toBeCloseTo(31.3);
    expect(massOfCoins({})).toBe(0);
  });
});

describe('fitStraightLine', () => {
  it('recupera una recta exacta', () => {
    const lineFit = fitStraightLine([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(lineFit!.slope).toBeCloseTo(2);
    expect(lineFit!.intercept).toBeCloseTo(1);
    expect(lineFit!.residualStandardDeviation).toBeCloseTo(0);
  });

  it('no ajusta si todas las x son iguales', () => {
    expect(fitStraightLine([5, 5, 5], [1, 2, 3])).toBeNull();
  });
});

describe('rasgos', () => {
  it('la inversa de la amplitud crece con la masa y propaga la dispersión', () => {
    const emptyMeasurement = simulatedMeasurement(0);
    const loadedMeasurement = simulatedMeasurement(50);
    expect(featureValue('inverse-amplitude', loadedMeasurement)!).toBeGreaterThan(
      featureValue('inverse-amplitude', emptyMeasurement)!,
    );
    // σ(1/A) = σA / A² / √n = 0,01 / A / √6.
    expect(featureUncertainty('inverse-amplitude', emptyMeasurement)).toBeCloseTo(
      0.01 / emptyMeasurement.amplitudeRms / Math.sqrt(6),
    );
    expect(featureValue('peak-frequency', simulatedMeasurement(0, { frequencyHz: null }))).toBeNull();
  });
});

describe('calibración y estimación', () => {
  const coinCalibration = [0, 17, 34].map((massGrams) => calibrationPoint(massGrams));

  it('con el modelo físico ideal recupera masas desconocidas', () => {
    const scaleModel = buildScaleModel(coinCalibration, 'inverse-amplitude')!;
    expect(scaleModel.slope).toBeCloseTo(1 / driveForce);
    expect(scaleModel.intercept).toBeCloseTo(phoneMassGrams / driveForce);
    const massEstimate = estimateMass(scaleModel, simulatedMeasurement(25))!;
    expect(massEstimate.massGrams).toBeCloseTo(25, 5);
    expect(massEstimate.isExtrapolated).toBe(false);
    // Con un 1 % de dispersión entre pulsos, la incertidumbre ronda un gramo.
    expect(massEstimate.standardUncertaintyGrams).toBeGreaterThan(0.3);
    expect(massEstimate.standardUncertaintyGrams).toBeLessThan(3);
    expect(massEstimate.expandedUncertaintyGrams).toBeCloseTo(2 * massEstimate.standardUncertaintyGrams);
  });

  it('marca como extrapolada una masa muy fuera del rango calibrado', () => {
    const scaleModel = buildScaleModel(coinCalibration, 'inverse-amplitude')!;
    expect(estimateMass(scaleModel, simulatedMeasurement(120))!.isExtrapolated).toBe(true);
  });

  it('la incertidumbre crece con la dispersión de la calibración', () => {
    const noisyCalibration: CalibrationPoint[] = [
      { ...calibrationPoint(0), amplitudeRms: calibrationPoint(0).amplitudeRms * 1.03 },
      { ...calibrationPoint(17), amplitudeRms: calibrationPoint(17).amplitudeRms * 0.97 },
      calibrationPoint(34),
      { ...calibrationPoint(25), amplitudeRms: calibrationPoint(25).amplitudeRms * 1.02 },
    ];
    const cleanModel = buildScaleModel(coinCalibration, 'inverse-amplitude')!;
    const noisyModel = buildScaleModel(noisyCalibration, 'inverse-amplitude')!;
    const cleanEstimate = estimateMass(cleanModel, simulatedMeasurement(20))!;
    const noisyEstimate = estimateMass(noisyModel, simulatedMeasurement(20))!;
    expect(noisyEstimate.standardUncertaintyGrams).toBeGreaterThan(cleanEstimate.standardUncertaintyGrams * 1.5);
    expect(noisyModel.crossValidationErrorGrams!).toBeGreaterThan(cleanModel.crossValidationErrorGrams!);
  });

  it('rechaza calibraciones sin sentido físico o insuficientes', () => {
    // La amplitud sube con la masa: al revés de lo esperado.
    const invertedPoints = [0, 17, 34].map((massGrams) => ({
      ...calibrationPoint(massGrams),
      amplitudeRms: 1 + massGrams / 100,
    }));
    expect(buildScaleModel(invertedPoints, 'inverse-amplitude')).toBeNull();
    expect(buildScaleModel(coinCalibration.slice(0, 2), 'inverse-amplitude')).toBeNull();
    expect(buildScaleModel([0, 1, 2].map((massGrams) => calibrationPoint(massGrams)), 'inverse-amplitude')).toBeNull();
  });

  it('no usa la frecuencia si no cambia más que el ruido', () => {
    expect(buildScaleModel(coinCalibration, 'peak-frequency')).toBeNull();
    const { bestModel, candidateModels } = fitCalibration(coinCalibration);
    expect(bestModel!.feature).toBe('inverse-amplitude');
    expect(candidateModels).toHaveLength(1);
  });

  it('elige la frecuencia si es la que mejor predice', () => {
    // La amplitud apenas se mueve y es ruidosa; la frecuencia baja 0,2 Hz por gramo.
    const frequencyDrivenPoints: CalibrationPoint[] = [0, 10, 20, 30].map((massGrams, pointIndex) => ({
      massGrams,
      amplitudeRms: 2 * (1 + [0.04, -0.03, 0.02, -0.05][pointIndex]!) * (1 - massGrams / 3000),
      amplitudeSpreadRms: 0.04,
      peakFrequencyHz: 180 - 0.2 * massGrams,
      peakFrequencySpreadHz: 0.2,
      pulseCount: 6,
    }));
    const { bestModel } = fitCalibration(frequencyDrivenPoints);
    expect(bestModel!.feature).toBe('peak-frequency');
    const massEstimate = estimateMass(bestModel!, {
      amplitudeRms: 2,
      amplitudeSpreadRms: 0.04,
      peakFrequencyHz: 177,
      peakFrequencySpreadHz: 0.2,
      pulseCount: 6,
    })!;
    expect(massEstimate.massGrams).toBeCloseTo(15, 3);
  });

  it('la tara compensa un desplazamiento de la línea base', () => {
    const scaleModel = buildScaleModel(coinCalibration, 'inverse-amplitude')!;
    // La esponja se ha asentado: todo vibra un 5 % menos, como si hubiera ~10 g más.
    const shiftedMeasurement = (massGrams: number) => {
      const baseMeasurement = simulatedMeasurement(massGrams);
      return { ...baseMeasurement, amplitudeRms: driveForce / (phoneMassGrams + 10 + massGrams) };
    };
    expect(estimateMass(scaleModel, shiftedMeasurement(0))!.massGrams).toBeCloseTo(10, 3);
    const tareOffset = computeTareOffset(scaleModel, shiftedMeasurement(0))!;
    expect(estimateMass(scaleModel, shiftedMeasurement(20), tareOffset)!.massGrams).toBeCloseTo(20, 3);
  });

  it('expresa la sensibilidad en % de amplitud por cada 10 g', () => {
    const scaleModel = buildScaleModel(coinCalibration, 'inverse-amplitude')!;
    // 190 / 200 − 1 = −5 %.
    expect(amplitudeChangePercentPerTenGrams(scaleModel)).toBeCloseTo(-5, 3);
  });
});

describe('de extremo a extremo con grabaciones sintéticas', () => {
  it('pesa una masa desconocida a partir de pulsos simulados', () => {
    const measureWithMass = (massGrams: number, seed: number): ResponseMeasurement => {
      const recording = createSyntheticPulseRecording({
        vibrationAmplitude: driveForce / (phoneMassGrams + massGrams),
        pulseAmplitudeJitter: 0.01,
        noiseAmplitude: 0.03,
        seed,
      });
      const pulseResult = analyzePulseResponse(recording);
      if (!pulseResult.isSuccessful) throw new Error(pulseResult.failure);
      return responseMeasurementFromAnalysis(pulseResult.analysis);
    };
    const points: CalibrationPoint[] = [0, 17, 34, 51].map((massGrams, pointIndex) => ({
      massGrams,
      ...measureWithMass(massGrams, 100 + pointIndex),
    }));
    const { bestModel } = fitCalibration(points);
    expect(bestModel!.feature).toBe('inverse-amplitude');
    const massEstimate = estimateMass(bestModel!, measureWithMass(30, 999))!;
    expect(Math.abs(massEstimate.massGrams - 30)).toBeLessThan(2 * massEstimate.expandedUncertaintyGrams);
    expect(Math.abs(massEstimate.massGrams - 30)).toBeLessThan(6);
  });
});
