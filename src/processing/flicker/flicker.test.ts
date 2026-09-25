import { createSeededRandom } from '@/processing/dsp/signalGenerator';
import { createSrgbToLinearTable } from '@/processing/color/regionSampling';

import { evaluateBandModel, fitBandedProfile, removeFittedBackground, solveLinearSystem } from './bandFit';
import { createFlickerAnalyzer, type FlickerAnalysis, type FlickerFrameProfiles } from './flickerAnalyzer';
import { classifyFlickerRisk, classifyLight, computeFlickerMetrics } from './lightClassification';
import { computeLuminanceProfiles, sampledProfileLength } from './luminanceProfiles';
import { estimateFlickerFrequency, type PhaseSample, wrapAngle } from './phaseDrift';

function createGaussianNoise(seed: number) {
  const uniformRandom = createSeededRandom(seed);
  return () => {
    const firstUniform = Math.max(1e-12, uniformRandom());
    const secondUniform = uniformRandom();
    return Math.sqrt(-2 * Math.log(firstUniform)) * Math.cos(2 * Math.PI * secondUniform);
  };
}

describe('solveLinearSystem', () => {
  it('resuelve un sistema 3×3 que necesita pivoteo', () => {
    const matrix = Float64Array.from([0, 2, 1, 1, 1, 1, 2, 1, 3]);
    const expectedSolution = [1, -2, 3];
    const rightHandSide = Float64Array.from([
      0 * 1 + 2 * -2 + 1 * 3,
      1 * 1 + 1 * -2 + 1 * 3,
      2 * 1 + 1 * -2 + 3 * 3,
    ]);
    const solution = solveLinearSystem(matrix, rightHandSide, 3);
    expect(solution).not.toBeNull();
    expectedSolution.forEach((expectedValue, valueIndex) => expect(solution![valueIndex]).toBeCloseTo(expectedValue, 10));
  });

  it('devuelve null si la matriz es singular', () => {
    expect(solveLinearSystem(Float64Array.from([1, 2, 2, 4]), Float64Array.from([1, 2]), 2)).toBeNull();
  });
});

describe('fitBandedProfile', () => {
  const profileLength = 240;
  const spatialFrequency = 2.3 / profileLength;

  function bandedProfile(amplitude: number, phase: number, secondHarmonicAmplitude = 0) {
    return Float64Array.from({ length: profileLength }, (_, sampleIndex) => {
      const centeredPosition = sampleIndex - (profileLength - 1) / 2;
      const normalizedPosition = centeredPosition / (profileLength / 2);
      const background = 2 * (1 + 0.3 * normalizedPosition - 0.2 * normalizedPosition ** 2);
      const bands =
        1 +
        amplitude * Math.cos(2 * Math.PI * spatialFrequency * centeredPosition + phase) +
        secondHarmonicAmplitude * Math.cos(4 * Math.PI * spatialFrequency * centeredPosition + 2 * phase + 0.5);
      return background * bands;
    });
  }

  it('recupera amplitud relativa y fase con un fondo curvado (casi exacto con modelo multiplicativo)', () => {
    const bandFit = fitBandedProfile(bandedProfile(0.1, 1.2), {
      spatialFrequency,
      harmonicCount: 2,
      backgroundDegree: 2,
    });
    expect(bandFit).not.toBeNull();
    // El fondo multiplica a las bandas: el ajuste aditivo da la amplitud media, con un error pequeño.
    expect(bandFit!.relativeAmplitudes[0]).toBeCloseTo(0.1, 1);
    expect(Math.abs(wrapAngle(bandFit!.phases[0]! - 1.2))).toBeLessThan(0.1);
  });

  it('con fondo plano, la amplitud, la fase y el segundo armónico salen exactos', () => {
    const flatProfile = Float64Array.from({ length: profileLength }, (_, sampleIndex) => {
      const centeredPosition = sampleIndex - (profileLength - 1) / 2;
      return (
        3 +
        3 * 0.2 * Math.cos(2 * Math.PI * spatialFrequency * centeredPosition - 2) +
        3 * 0.05 * Math.cos(4 * Math.PI * spatialFrequency * centeredPosition + 0.7)
      );
    });
    const bandFit = fitBandedProfile(flatProfile, { spatialFrequency, harmonicCount: 2, backgroundDegree: 1 })!;
    expect(bandFit.meanLevel).toBeCloseTo(3, 6);
    expect(bandFit.relativeAmplitudes[0]).toBeCloseTo(0.2, 6);
    expect(bandFit.relativeAmplitudes[1]).toBeCloseTo(0.05, 6);
    expect(wrapAngle(bandFit.phases[0]! + 2)).toBeCloseTo(0, 6);
    expect(wrapAngle(bandFit.phases[1]! - 0.7)).toBeCloseTo(0, 6);
    expect(bandFit.relativeResidualRms).toBeLessThan(1e-6);
    const measuredBands = removeFittedBackground(flatProfile, bandFit);
    const modelBands = evaluateBandModel(bandFit, spatialFrequency, profileLength);
    measuredBands.forEach((measuredValue, sampleIndex) => expect(measuredValue).toBeCloseTo(modelBands[sampleIndex]!, 6));
  });

  it('omite los armónicos por encima de Nyquist', () => {
    const bandFit = fitBandedProfile(bandedProfile(0.1, 0), {
      spatialFrequency: 0.3,
      harmonicCount: 3,
      backgroundDegree: 1,
    });
    expect(bandFit?.relativeAmplitudes).toHaveLength(1);
  });
});

describe('computeLuminanceProfiles', () => {
  it('promedia por filas y columnas con la luminancia lineal y cuenta los saturados', () => {
    const frameWidth = 4;
    const frameHeight = 2;
    const bytesPerPixel = 4;
    const bytesPerRow = frameWidth * bytesPerPixel + 8; // relleno al final de cada fila
    const pixels = new Uint8Array(bytesPerRow * frameHeight);
    const setPixel = (rowIndex: number, columnIndex: number, channelValue: number) => {
      const pixelStart = rowIndex * bytesPerRow + columnIndex * bytesPerPixel;
      pixels[pixelStart] = channelValue;
      pixels[pixelStart + 1] = channelValue;
      pixels[pixelStart + 2] = channelValue;
      pixels[pixelStart + 3] = 255; // alfa: no cuenta
    };
    for (let columnIndex = 0; columnIndex < frameWidth; columnIndex++) {
      setPixel(0, columnIndex, 255);
      setPixel(1, columnIndex, 0);
    }
    const linearTable = createSrgbToLinearTable();
    const rowProfile = new Float64Array(sampledProfileLength(frameHeight, 1));
    const columnProfile = new Float64Array(sampledProfileLength(frameWidth, 1));
    const profileResult = computeLuminanceProfiles(
      pixels,
      frameWidth,
      frameHeight,
      bytesPerRow,
      bytesPerPixel,
      linearTable,
      1,
      rowProfile,
      columnProfile,
    );
    expect(Array.from(rowProfile)).toEqual([3, 0]);
    expect(Array.from(columnProfile)).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect(profileResult.saturatedFraction).toBeCloseTo(0.5);
    expect(profileResult.meanLuminance).toBeCloseTo(1.5);
  });
});

describe('estimateFlickerFrequency', () => {
  function simulatedPhases({
    flickerFrequencyHz,
    frameRateHz,
    durationSeconds,
    readoutDirection = 1,
    phaseNoiseRadians = 0.05,
    seed = 1,
  }: {
    flickerFrequencyHz: number;
    frameRateHz: number;
    durationSeconds: number;
    readoutDirection?: 1 | -1;
    phaseNoiseRadians?: number;
    seed?: number;
  }): PhaseSample[] {
    const gaussianNoise = createGaussianNoise(seed);
    const phaseSamples: PhaseSample[] = [];
    const startTime = 12345.678; // el reloj de la cámara no empieza en 0
    for (let frameIndex = 0; frameIndex < durationSeconds * frameRateHz; frameIndex++) {
      // Fotogramas con algo de temblor en la marca de tiempo y alguno perdido.
      if (frameIndex % 17 === 5) continue;
      const timeSeconds = startTime + frameIndex / frameRateHz + 0.0002 * gaussianNoise();
      phaseSamples.push({
        timeSeconds,
        phaseRadians: wrapAngle(
          readoutDirection * 2 * Math.PI * flickerFrequencyHz * timeSeconds + 0.4 + phaseNoiseRadians * gaussianNoise(),
        ),
        weight: 1,
      });
    }
    return phaseSamples;
  }

  const phaseDriftOptions = { maximumDeviationHz: 2, clockToleranceRelative: 30e-6 };

  it('mide la desviación respecto a 100 Hz con precisión de milésimas de hercio', () => {
    const estimate = estimateFlickerFrequency(
      simulatedPhases({ flickerFrequencyHz: 100.034, frameRateHz: 30, durationSeconds: 10 }),
      { ...phaseDriftOptions, nominalFlickerFrequencyHz: 100 },
    );
    expect(estimate).not.toBeNull();
    expect(estimate!.flickerFrequencyHz).toBeCloseTo(100.034, 3);
    expect(estimate!.readoutDirection).toBe(1);
    expect(estimate!.isDirectionAmbiguous).toBe(false);
    expect(estimate!.phaseCoherence).toBeGreaterThan(0.95);
    // La incertidumbre incluye el reloj (30 ppm de 100 Hz = 0,003 Hz).
    expect(estimate!.uncertaintyHz).toBeGreaterThanOrEqual(0.003);
    expect(estimate!.uncertaintyHz).toBeLessThan(0.01);
    expect(Math.abs(estimate!.flickerFrequencyHz - 100.034)).toBeLessThan(3 * estimate!.uncertaintyHz);
  });

  it('deduce el sentido de lectura cuando el sensor lee al revés', () => {
    const estimate = estimateFlickerFrequency(
      simulatedPhases({ flickerFrequencyHz: 99.95, frameRateHz: 30, durationSeconds: 8, readoutDirection: -1 }),
      { ...phaseDriftOptions, nominalFlickerFrequencyHz: 100 },
    );
    expect(estimate!.readoutDirection).toBe(-1);
    expect(estimate!.flickerFrequencyHz).toBeCloseTo(99.95, 3);
  });

  it('marca como ambiguo el sentido cuando 2·f₀/fps es entero (120 Hz a 30 fps)', () => {
    const estimate = estimateFlickerFrequency(
      simulatedPhases({ flickerFrequencyHz: 120.02, frameRateHz: 30, durationSeconds: 8 }),
      { ...phaseDriftOptions, nominalFlickerFrequencyHz: 120 },
    );
    expect(estimate!.isDirectionAmbiguous).toBe(true);
    expect(Math.abs(estimate!.deviationHz)).toBeCloseTo(0.02, 3);
  });

  it('funciona a 60 fps y con fases muy ruidosas', () => {
    const estimate = estimateFlickerFrequency(
      simulatedPhases({
        flickerFrequencyHz: 100.1,
        frameRateHz: 60,
        durationSeconds: 10,
        phaseNoiseRadians: 0.6,
        seed: 7,
      }),
      { ...phaseDriftOptions, nominalFlickerFrequencyHz: 100 },
    );
    expect(Math.abs(estimate!.flickerFrequencyHz - 100.1)).toBeLessThan(0.01);
  });

  it('da coherencia baja con fases aleatorias', () => {
    const uniformRandom = createSeededRandom(3);
    const randomPhases: PhaseSample[] = Array.from({ length: 300 }, (_, frameIndex) => ({
      timeSeconds: frameIndex / 30,
      phaseRadians: 2 * Math.PI * uniformRandom() - Math.PI,
      weight: 1,
    }));
    const estimate = estimateFlickerFrequency(randomPhases, { ...phaseDriftOptions, nominalFlickerFrequencyHz: 100 });
    expect(estimate!.phaseCoherence).toBeLessThan(0.35);
  });

  it('devuelve null sin datos suficientes', () => {
    expect(estimateFlickerFrequency([], { ...phaseDriftOptions, nominalFlickerFrequencyHz: 100 })).toBeNull();
  });
});

describe('computeFlickerMetrics y clasificación', () => {
  it('una senoidal del 10 % da un 10 % de parpadeo e índice 0,1/π', () => {
    const metrics = computeFlickerMetrics([0.1], [0]);
    expect(metrics.percentFlicker).toBeCloseTo(10, 5);
    expect(metrics.flickerIndex).toBeCloseTo(0.1 / Math.PI, 3);
    expect(metrics.harmonicDistortion).toBe(0);
  });

  it('una onda cuadrada (armónicos impares, aquí también pares por el rectificado) tiene distorsión alta', () => {
    const metrics = computeFlickerMetrics([0.6, 0.25, 0.2], [0, 0, 0]);
    expect(metrics.harmonicDistortion).toBeGreaterThan(0.5);
    expect(classifyLight(metrics)).toBe('flickeringLed');
  });

  it('clasifica por profundidad y forma', () => {
    expect(classifyLight(null)).toBe('steady');
    expect(classifyLight(computeFlickerMetrics([0.01], [0]))).toBe('steady');
    expect(classifyLight(computeFlickerMetrics([0.08, 0.005], [0, 0]))).toBe('incandescent');
    expect(classifyLight(computeFlickerMetrics([0.35, 0.03], [0, 0]))).toBe('fluorescent');
    expect(classifyLight(computeFlickerMetrics([0.9], [0]))).toBe('flickeringLed');
  });

  it('aplica los umbrales de IEEE 1789 a 100 Hz', () => {
    expect(classifyFlickerRisk(2, 100)).toBe('noObservableEffect');
    expect(classifyFlickerRisk(5, 100)).toBe('lowRisk');
    expect(classifyFlickerRisk(30, 100)).toBe('aboveLowRisk');
  });
});

/**
 * Simula los perfiles que daría el obturador rodante: el fotograma k empieza a leerse en tₖ y la
 * fila r en tₖ + r·(tiempo por fila). La luz es una onda con armónicos; la escena, un fondo con
 * bordes; y se suma ruido. `exposureSeconds` promedia la luz durante la exposición.
 */
function simulateRollingShutterFrames({
  flickerFrequencyHz,
  modulationDepth,
  secondHarmonicDepth = 0,
  frameRateHz,
  durationSeconds,
  readoutSeconds = 0.024,
  exposureSeconds = 0.002,
  noiseLevel = 0.002,
  bandsAlongColumns = false,
  isPlainWall = false,
  seed = 11,
}: {
  flickerFrequencyHz: number;
  modulationDepth: number;
  secondHarmonicDepth?: number;
  frameRateHz: number;
  durationSeconds: number;
  readoutSeconds?: number;
  exposureSeconds?: number;
  noiseLevel?: number;
  bandsAlongColumns?: boolean;
  /** Pared lisa con un degradado suave en vez de una lámpara con bordes. */
  isPlainWall?: boolean;
  seed?: number;
}): FlickerFrameProfiles[] {
  const gaussianNoise = createGaussianNoise(seed);
  const readoutSampleCount = bandsAlongColumns ? 320 : 240;
  const crossSampleCount = bandsAlongColumns ? 240 : 320;
  const sampleReadoutSeconds = readoutSeconds / readoutSampleCount;
  // Escena: una lámpara brillante en el centro y un borde (nada periódico).
  const readoutScene = Float64Array.from({ length: readoutSampleCount }, (_, sampleIndex) => {
    const normalizedPosition = sampleIndex / readoutSampleCount;
    if (isPlainWall) return 0.8 - 0.3 * (normalizedPosition - 0.5) ** 2;
    return 0.4 + 0.5 * Math.exp(-(((normalizedPosition - 0.45) / 0.12) ** 2)) + (normalizedPosition > 0.8 ? 0.2 : 0);
  });
  const crossScene = Float64Array.from(
    { length: crossSampleCount },
    (_, sampleIndex) => 0.7 + 0.3 * Math.sin(sampleIndex / 23),
  );
  const exposureStepCount = 8;
  const lightAt = (timeSeconds: number) => {
    let averagedLight = 0;
    for (let exposureStep = 0; exposureStep < exposureStepCount; exposureStep++) {
      const sampleTime = timeSeconds + (exposureSeconds * (exposureStep + 0.5)) / exposureStepCount;
      averagedLight +=
        1 +
        modulationDepth * Math.cos(2 * Math.PI * flickerFrequencyHz * sampleTime) +
        secondHarmonicDepth * Math.cos(4 * Math.PI * flickerFrequencyHz * sampleTime + 0.3);
    }
    return averagedLight / exposureStepCount;
  };

  const frames: FlickerFrameProfiles[] = [];
  const startTime = 5000.123;
  for (let frameIndex = 0; frameIndex < durationSeconds * frameRateHz; frameIndex++) {
    const frameStartTime = startTime + frameIndex / frameRateHz + 0.0001 * gaussianNoise();
    const readoutProfile = new Float64Array(readoutSampleCount);
    let readoutAverage = 0;
    for (let sampleIndex = 0; sampleIndex < readoutSampleCount; sampleIndex++) {
      readoutProfile[sampleIndex] =
        readoutScene[sampleIndex]! * lightAt(frameStartTime + sampleIndex * sampleReadoutSeconds) +
        noiseLevel * gaussianNoise();
      readoutAverage += readoutProfile[sampleIndex]!;
    }
    readoutAverage /= readoutSampleCount;
    const crossProfile = Float64Array.from(
      crossScene,
      (sceneValue) => sceneValue * readoutAverage + noiseLevel * 0.3 * gaussianNoise(),
    );
    frames.push({
      timestampSeconds: frameStartTime,
      rowProfile: bandsAlongColumns ? crossProfile : readoutProfile,
      columnProfile: bandsAlongColumns ? readoutProfile : crossProfile,
      saturatedFraction: 0,
    });
  }
  return frames;
}

function runAnalyzer(frames: FlickerFrameProfiles[], nominalFlickerFrequencyHz: number): FlickerAnalysis {
  const analyzer = createFlickerAnalyzer({ nominalFlickerFrequencyHz });
  let latestAnalysis: FlickerAnalysis | null = null;
  frames.forEach((frame, frameIndex) => {
    analyzer.pushFrame(frame);
    if (frameIndex % 15 === 14) latestAnalysis = analyzer.analyze();
  });
  return latestAnalysis ?? analyzer.analyze();
}

describe('createFlickerAnalyzer (de principio a fin, con fotogramas simulados)', () => {
  it('fluorescente a 100,02 Hz y 30 fps: frecuencia, profundidad, tipo y tiempo de lectura', () => {
    const analysis = runAnalyzer(
      simulateRollingShutterFrames({ flickerFrequencyHz: 100.02, modulationDepth: 0.3, frameRateHz: 30, durationSeconds: 12 }),
      100,
    );
    expect(analysis.status).toBe('bands');
    expect(analysis.detection?.axis).toBe('rows');
    expect(analysis.detection?.mode).toBe('temporal');
    expect(analysis.frameRateHz).toBeCloseTo(30, 0);
    expect(analysis.frequency).not.toBeNull();
    expect(Math.abs(analysis.frequency!.flickerFrequencyHz - 100.02)).toBeLessThan(0.004);
    expect(analysis.frequency!.isDirectionAmbiguous).toBe(false);
    // Exposición de 2 ms: la profundidad medida es algo menor que la real (sinc(π·f·e) ≈ 0,93).
    expect(analysis.metrics!.fundamentalDepth).toBeGreaterThan(0.25);
    expect(analysis.metrics!.fundamentalDepth).toBeLessThan(0.31);
    expect(analysis.lightType).toBe('fluorescent');
    expect(analysis.readoutTimeMilliseconds!).toBeGreaterThan(22.5);
    expect(analysis.readoutTimeMilliseconds!).toBeLessThan(25.5);
    expect(analysis.latestModulationProfile).toHaveLength(240);
  });

  it('LED de mala calidad (onda muy deformada) a 99,97 Hz', () => {
    const analysis = runAnalyzer(
      simulateRollingShutterFrames({
        flickerFrequencyHz: 99.97,
        modulationDepth: 0.5,
        secondHarmonicDepth: 0.25,
        frameRateHz: 30,
        durationSeconds: 8,
        readoutSeconds: 0.03,
      }),
      100,
    );
    expect(analysis.status).toBe('bands');
    expect(Math.abs(analysis.frequency!.flickerFrequencyHz - 99.97)).toBeLessThan(0.005);
    expect(analysis.lightType).toBe('flickeringLed');
  });

  it('incandescente (parpadeo suave del 6 %)', () => {
    const analysis = runAnalyzer(
      simulateRollingShutterFrames({ flickerFrequencyHz: 100, modulationDepth: 0.06, frameRateHz: 30, durationSeconds: 6 }),
      100,
    );
    expect(analysis.status).toBe('bands');
    expect(analysis.lightType).toBe('incandescent');
    expect(Math.abs(analysis.frequency!.deviationHz)).toBeLessThan(0.01);
  });

  it('encuentra las bandas en el eje de las columnas si el sensor lee en ese sentido', () => {
    const analysis = runAnalyzer(
      simulateRollingShutterFrames({
        flickerFrequencyHz: 100.05,
        modulationDepth: 0.2,
        frameRateHz: 30,
        durationSeconds: 6,
        bandsAlongColumns: true,
      }),
      100,
    );
    expect(analysis.detection?.axis).toBe('columns');
    expect(Math.abs(analysis.frequency!.flickerFrequencyHz - 100.05)).toBeLessThan(0.01);
  });

  it('red de 60 Hz (parpadeo a 120 Hz) a 30 fps: bandas quietas, modo espacial y signo ambiguo', () => {
    const analysis = runAnalyzer(
      simulateRollingShutterFrames({
        flickerFrequencyHz: 120.03,
        modulationDepth: 0.3,
        frameRateHz: 30,
        durationSeconds: 10,
        isPlainWall: true,
      }),
      120,
    );
    expect(analysis.status).toBe('bands');
    expect(analysis.detection?.mode).toBe('spatial');
    expect(analysis.frequency?.isDirectionAmbiguous).toBe(true);
    expect(Math.abs(Math.abs(analysis.frequency!.deviationHz) - 0.03)).toBeLessThan(0.01);
  });

  it('luz estable: sin bandas, con una cota superior pequeña', () => {
    const analysis = runAnalyzer(
      simulateRollingShutterFrames({ flickerFrequencyHz: 100, modulationDepth: 0, frameRateHz: 30, durationSeconds: 3 }),
      100,
    );
    expect(analysis.status).toBe('noBands');
    expect(analysis.lightType).toBe('steady');
    expect(analysis.frequency).toBeNull();
    expect(analysis.percentFlickerUpperBound!).toBeLessThan(1);
  });

  it('exposición de 10 ms (un periodo entero): las bandas desaparecen', () => {
    const analysis = runAnalyzer(
      simulateRollingShutterFrames({
        flickerFrequencyHz: 100,
        modulationDepth: 0.3,
        frameRateHz: 30,
        durationSeconds: 3,
        exposureSeconds: 0.01,
      }),
      100,
    );
    expect(analysis.status).toBe('noBands');
  });

  it('espera a tener fotogramas suficientes', () => {
    const analyzer = createFlickerAnalyzer({ nominalFlickerFrequencyHz: 100 });
    expect(analyzer.analyze().status).toBe('collecting');
  });
});
