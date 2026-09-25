import { classifyCarrierBand, constellationFromAndroidCode } from './constellations';
import { averageAutomaticGainControlByBand, InterferenceDetector, type InterferenceAssessment } from './interferenceDetector';
import { computePseudorangeMeters, measurementStateBits, nanosecondsPerWeek, speedOfLightMetersPerSecond } from './pseudorange';
import {
  type RawMeasurement,
  summarizeRawMeasurements,
  toAutomaticGainControlReadings,
  toSatelliteObservations,
} from './rawConversion';
import { carrierToNoiseQuality, elevationRingRadius, projectSkyPosition } from './skyProjection';
import { median, sortForCarrierToNoiseBars, summarizeSky } from './skyStatistics';
import type { AutomaticGainControlReading, SatelliteObservation } from './types';

function makeObservation(overrides: Partial<SatelliteObservation> = {}): SatelliteObservation {
  return {
    constellationId: 'gps',
    svid: 1,
    bandId: 'L1',
    carrierToNoiseDensityDbHz: 40,
    elevationDegrees: 45,
    azimuthDegrees: 90,
    isUsedInFix: true,
    ...overrides,
  };
}

/** Cielo sintético: `satelliteCount` satélites repartidos en azimut, cada uno con su C/N0 base. */
function makeSky(satelliteCount: number, carrierToNoiseForIndex: (satelliteIndex: number) => number): SatelliteObservation[] {
  return Array.from({ length: satelliteCount }, (_, satelliteIndex) =>
    makeObservation({
      constellationId: satelliteIndex % 2 === 0 ? 'gps' : 'galileo',
      svid: satelliteIndex + 1,
      azimuthDegrees: (satelliteIndex * 360) / satelliteCount,
      elevationDegrees: 20 + ((satelliteIndex * 7) % 60),
      carrierToNoiseDensityDbHz: carrierToNoiseForIndex(satelliteIndex),
    }),
  );
}

describe('constelaciones y bandas', () => {
  it('traduce los códigos de Android', () => {
    expect(constellationFromAndroidCode(1)).toBe('gps');
    expect(constellationFromAndroidCode(3)).toBe('glonass');
    expect(constellationFromAndroidCode(5)).toBe('beidou');
    expect(constellationFromAndroidCode(6)).toBe('galileo');
    expect(constellationFromAndroidCode(42)).toBe('unknown');
  });

  it('clasifica las portadoras en bandas', () => {
    expect(classifyCarrierBand('gps', 1575.42e6)).toBe('L1');
    expect(classifyCarrierBand('galileo', 1575.42e6)).toBe('L1');
    expect(classifyCarrierBand('gps', 1176.45e6)).toBe('L5');
    expect(classifyCarrierBand('galileo', 1176.45e6)).toBe('L5');
    expect(classifyCarrierBand('beidou', 1561.098e6)).toBe('B1I');
    // GLONASS FDMA: canales extremos k = −7 y k = +6.
    expect(classifyCarrierBand('glonass', 1602e6 - 7 * 0.5625e6)).toBe('G1');
    expect(classifyCarrierBand('glonass', 1602e6 + 6 * 0.5625e6)).toBe('G1');
    expect(classifyCarrierBand('gps', 1227.6e6)).toBe('L2');
    expect(classifyCarrierBand('gps', 1400e6)).toBe('unknown');
  });

  it('sin frecuencia asume la banda principal de la constelación', () => {
    expect(classifyCarrierBand('gps', null)).toBe('L1');
    expect(classifyCarrierBand('glonass', null)).toBe('G1');
    expect(classifyCarrierBand('unknown', null)).toBe('unknown');
  });
});

describe('proyección polar', () => {
  const [centerX, centerY, horizonRadius] = [100, 100, 80];

  it('pone el cénit en el centro y el horizonte en el borde', () => {
    expect(projectSkyPosition(90, 123, centerX, centerY, horizonRadius)).toEqual({ x: 100, y: 100 });
    const northHorizon = projectSkyPosition(0, 0, centerX, centerY, horizonRadius);
    expect(northHorizon.x).toBeCloseTo(100);
    expect(northHorizon.y).toBeCloseTo(20);
  });

  it('norte arriba, este a la derecha, sur abajo, oeste a la izquierda', () => {
    const east = projectSkyPosition(0, 90, centerX, centerY, horizonRadius);
    const south = projectSkyPosition(0, 180, centerX, centerY, horizonRadius);
    const west = projectSkyPosition(0, 270, centerX, centerY, horizonRadius);
    expect(east.x).toBeCloseTo(180);
    expect(east.y).toBeCloseTo(100);
    expect(south.y).toBeCloseTo(180);
    expect(west.x).toBeCloseTo(20);
  });

  it('es lineal en la elevación y pega al borde las elevaciones negativas', () => {
    const at45 = projectSkyPosition(45, 90, centerX, centerY, horizonRadius);
    expect(at45.x - centerX).toBeCloseTo(40);
    const belowHorizon = projectSkyPosition(-5, 90, centerX, centerY, horizonRadius);
    expect(belowHorizon.x).toBeCloseTo(180);
    expect(elevationRingRadius(30, 90)).toBeCloseTo(60);
    expect(elevationRingRadius(60, 90)).toBeCloseTo(30);
  });

  it('gradúa la calidad de la señal entre 0 y 1', () => {
    expect(carrierToNoiseQuality(5)).toBe(0);
    expect(carrierToNoiseQuality(27.5)).toBeCloseTo(0.5);
    expect(carrierToNoiseQuality(60)).toBe(1);
  });
});

describe('estadísticas del cielo', () => {
  it('calcula la mediana', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('cuenta por constelación y banda y detecta doble frecuencia', () => {
    const observations = [
      makeObservation({ svid: 1, bandId: 'L1', carrierToNoiseDensityDbHz: 45 }),
      makeObservation({ svid: 1, bandId: 'L5', carrierToNoiseDensityDbHz: 38, isUsedInFix: false }),
      makeObservation({ svid: 7, bandId: 'L1', carrierToNoiseDensityDbHz: 30 }),
      makeObservation({ constellationId: 'galileo', svid: 11, bandId: 'L1', carrierToNoiseDensityDbHz: 35 }),
      makeObservation({ constellationId: 'glonass', svid: 3, bandId: 'G1', carrierToNoiseDensityDbHz: 25 }),
      // Previsto por el almanaque pero sin señal: no cuenta.
      makeObservation({ constellationId: 'beidou', svid: 20, bandId: 'L1', carrierToNoiseDensityDbHz: 0, isUsedInFix: false }),
    ];
    const skySummary = summarizeSky(observations);
    expect(skySummary.listedSignalCount).toBe(6);
    expect(skySummary.trackedSignalCount).toBe(5);
    expect(skySummary.trackedSatelliteCount).toBe(4);
    expect(skySummary.usedInFixSignalCount).toBe(4);
    expect(skySummary.isDualFrequency).toBe(true);
    expect(skySummary.dualFrequencySatelliteCount).toBe(1);
    expect(skySummary.countsByConstellation).toEqual([
      { groupId: 'gps', trackedCount: 3, usedInFixCount: 2 },
      { groupId: 'galileo', trackedCount: 1, usedInFixCount: 1 },
      { groupId: 'glonass', trackedCount: 1, usedInFixCount: 1 },
    ]);
    expect(skySummary.countsByBand.map((bandCount) => bandCount.groupId)).toEqual(['L1', 'G1', 'L5']);
    expect(skySummary.topFourMeanCarrierToNoiseDbHz).toBeCloseTo((45 + 38 + 35 + 30) / 4);
    expect(skySummary.medianCarrierToNoiseDbHz).toBe(35);
  });

  it('un móvil solo L1 no es de doble frecuencia', () => {
    const skySummary = summarizeSky([makeObservation(), makeObservation({ svid: 2, bandId: 'G1' })]);
    expect(skySummary.isDualFrequency).toBe(false);
  });

  it('un cielo vacío no rompe nada', () => {
    const skySummary = summarizeSky([]);
    expect(skySummary.topFourMeanCarrierToNoiseDbHz).toBeNull();
    expect(skySummary.countsByConstellation).toEqual([]);
  });

  it('ordena las barras por constelación, svid y banda y quita las señales sin recibir', () => {
    const sortedObservations = sortForCarrierToNoiseBars([
      makeObservation({ constellationId: 'galileo', svid: 3 }),
      makeObservation({ svid: 9, bandId: 'L5' }),
      makeObservation({ svid: 9, bandId: 'L1' }),
      makeObservation({ svid: 2, carrierToNoiseDensityDbHz: 0 }),
    ]);
    expect(sortedObservations.map((observation) => `${observation.constellationId}${observation.svid}${observation.bandId}`)).toEqual([
      'gps9L1',
      'gps9L5',
      'galileo3L1',
    ]);
  });
});

describe('detector de interferencias', () => {
  const baseCarrierToNoise = (satelliteIndex: number) => 30 + (satelliteIndex % 5) * 3;
  const satelliteCount = 10;
  const agcBaselineLevelDb = 30;

  /** Hace funcionar el detector a 1 Hz y devuelve la última evaluación. */
  function runDetector(
    detector: InterferenceDetector,
    fromSeconds: number,
    toSeconds: number,
    buildEpoch: (timestampSeconds: number) => {
      observations: SatelliteObservation[];
      automaticGainControlReadings?: AutomaticGainControlReading[];
    },
  ): InterferenceAssessment[] {
    const assessments: InterferenceAssessment[] = [];
    for (let timestampSeconds = fromSeconds; timestampSeconds <= toSeconds; timestampSeconds++) {
      const epoch = buildEpoch(timestampSeconds);
      assessments.push(
        detector.update({
          timestampSeconds,
          observations: epoch.observations,
          automaticGainControlReadings: epoch.automaticGainControlReadings ?? [],
        }),
      );
    }
    return assessments;
  }

  /** Ruido determinista pequeño (±1 dB) para que no sea una señal perfecta. */
  function wobble(timestampSeconds: number, satelliteIndex: number): number {
    return Math.sin(timestampSeconds * 1.3 + satelliteIndex * 2.1);
  }

  function quietSky(timestampSeconds: number) {
    return {
      observations: makeSky(satelliteCount, (satelliteIndex) => baseCarrierToNoise(satelliteIndex) + wobble(timestampSeconds, satelliteIndex)),
      automaticGainControlReadings: [{ bandId: 'L1' as const, levelDb: agcBaselineLevelDb + 0.3 * wobble(timestampSeconds, 0) }],
    };
  }

  it('aprende primero y no avisa con un cielo tranquilo', () => {
    const detector = new InterferenceDetector();
    const assessments = runDetector(detector, 0, 60, quietSky);
    expect(assessments[0]?.status).toBe('learning');
    expect(assessments[5]?.learningProgress).toBeCloseTo(5 / 15);
    expect(assessments.at(-1)?.status).toBe('monitoring');
    expect(assessments.every((assessment) => assessment.level === 'none')).toBe(true);
    expect(assessments.at(-1)?.hasAutomaticGainControlData).toBe(true);
    expect(Math.abs(assessments.at(-1)?.medianCarrierToNoiseDropDb ?? 99)).toBeLessThan(1.5);
  });

  it('avisa de posible interferencia si todo el C/N0 cae a la vez sin datos de AGC', () => {
    const detector = new InterferenceDetector();
    const skyWithoutAgc = (timestampSeconds: number, dropDb: number) => ({
      observations: makeSky(
        satelliteCount,
        (satelliteIndex) => baseCarrierToNoise(satelliteIndex) + wobble(timestampSeconds, satelliteIndex) - dropDb,
      ),
    });
    runDetector(detector, 0, 40, (timestampSeconds) => skyWithoutAgc(timestampSeconds, 0));
    const assessments = runDetector(detector, 41, 50, (timestampSeconds) => skyWithoutAgc(timestampSeconds, 10));
    const lastAssessment = assessments.at(-1);
    expect(lastAssessment?.level).toBe('possible');
    expect(lastAssessment?.isCarrierToNoiseDropUniform).toBe(true);
    expect(lastAssessment?.isSkyStable).toBe(true);
    expect(lastAssessment?.hasAutomaticGainControlData).toBe(false);
    expect(lastAssessment?.medianCarrierToNoiseDropDb).toBeGreaterThan(7);
    // Tarda unos segundos (media rápida) pero no demasiados.
    const firstAlertIndex = assessments.findIndex((assessment) => assessment.level !== 'none');
    expect(firstAlertIndex).toBeGreaterThanOrEqual(0);
    expect(firstAlertIndex).toBeLessThanOrEqual(4);
  });

  it('con caída del AGC y del C/N0 la interferencia es probable', () => {
    const detector = new InterferenceDetector();
    runDetector(detector, 0, 40, quietSky);
    const assessments = runDetector(detector, 41, 50, (timestampSeconds) => ({
      observations: makeSky(satelliteCount, (satelliteIndex) => baseCarrierToNoise(satelliteIndex) - 9),
      automaticGainControlReadings: [{ bandId: 'L1', levelDb: agcBaselineLevelDb - 12 + 0.1 * wobble(timestampSeconds, 0) }],
    }));
    const lastAssessment = assessments.at(-1);
    expect(lastAssessment?.level).toBe('likely');
    expect(lastAssessment?.isAutomaticGainControlDropping).toBe(true);
    expect(lastAssessment?.automaticGainControlDrops[0]?.dropDb).toBeGreaterThan(8);
  });

  it('solo la caída del AGC ya es una posible interferencia', () => {
    const detector = new InterferenceDetector();
    runDetector(detector, 0, 40, quietSky);
    const assessments = runDetector(detector, 41, 50, (timestampSeconds) => ({
      observations: quietSky(timestampSeconds).observations,
      automaticGainControlReadings: [{ bandId: 'L1', levelDb: agcBaselineLevelDb - 8 }],
    }));
    expect(assessments.at(-1)?.level).toBe('possible');
  });

  it('no confunde un obstáculo parcial (tapa unos pocos satélites) con una interferencia', () => {
    const detector = new InterferenceDetector();
    runDetector(detector, 0, 40, quietSky);
    const assessments = runDetector(detector, 41, 60, (timestampSeconds) => ({
      ...quietSky(timestampSeconds),
      observations: makeSky(satelliteCount, (satelliteIndex) =>
        baseCarrierToNoise(satelliteIndex) + wobble(timestampSeconds, satelliteIndex) - (satelliteIndex < 4 ? 15 : 0),
      ),
    }));
    expect(assessments.every((assessment) => assessment.level === 'none')).toBe(true);
    expect(assessments.at(-1)?.isCarrierToNoiseDropUniform).toBe(false);
  });

  it('entrar en un edificio (se pierden satélites y el resto baja) sin caída de AGC no es interferencia', () => {
    const detector = new InterferenceDetector();
    runDetector(detector, 0, 40, quietSky);
    const assessments = runDetector(detector, 41, 60, (timestampSeconds) => ({
      ...quietSky(timestampSeconds),
      // Solo quedan 3 de 10 satélites, 10 dB más débiles; el AGC sube (menos potencia en la antena).
      observations: makeSky(satelliteCount, baseCarrierToNoise)
        .slice(0, 3)
        .map((observation) => ({ ...observation, carrierToNoiseDensityDbHz: observation.carrierToNoiseDensityDbHz - 10 })),
      automaticGainControlReadings: [{ bandId: 'L1', levelDb: agcBaselineLevelDb + 3 }],
    }));
    const lastAssessment = assessments.at(-1);
    expect(lastAssessment?.level).toBe('none');
    expect(lastAssessment?.isSkyStable).toBe(false);
    expect(lastAssessment?.isMassSignalLoss).toBe(true);
  });

  it('mantiene la alarma durante una interferencia larga y reaprende pasado el límite', () => {
    const detector = new InterferenceDetector({ maximumFrozenBaselineSeconds: 60 });
    runDetector(detector, 0, 40, quietSky);
    const jammedSky = () => ({
      observations: makeSky(satelliteCount, (satelliteIndex) => baseCarrierToNoise(satelliteIndex) - 10),
      automaticGainControlReadings: [{ bandId: 'L1' as const, levelDb: agcBaselineLevelDb - 10 }],
    });
    const duringJamming = runDetector(detector, 41, 95, jammedSky);
    expect(duringJamming.slice(5).every((assessment) => assessment.level === 'likely')).toBe(true);
    expect(duringJamming.at(-1)?.isBaselineFrozen).toBe(true);
    const afterLimit = runDetector(detector, 96, 140, jammedSky);
    expect(afterLimit.some((assessment) => assessment.status === 'learning')).toBe(true);
    expect(afterLimit.at(-1)?.level).toBe('none');
  });

  it('se recupera cuando desaparece la interferencia', () => {
    const detector = new InterferenceDetector();
    runDetector(detector, 0, 40, quietSky);
    runDetector(detector, 41, 55, () => ({
      observations: makeSky(satelliteCount, (satelliteIndex) => baseCarrierToNoise(satelliteIndex) - 10),
      automaticGainControlReadings: [{ bandId: 'L1', levelDb: agcBaselineLevelDb - 10 }],
    }));
    const afterJamming = runDetector(detector, 56, 75, quietSky);
    expect(afterJamming.at(-1)?.level).toBe('none');
  });

  it('promedia el AGC de varias constelaciones en la misma banda', () => {
    const averagedLevels = averageAutomaticGainControlByBand([
      { bandId: 'L1', levelDb: 30 },
      { bandId: 'L1', levelDb: 32 },
      { bandId: 'L5', levelDb: 20 },
      { bandId: 'L5', levelDb: Number.NaN },
    ]);
    expect(averagedLevels.get('L1')).toBe(31);
    expect(averagedLevels.get('L5')).toBe(20);
  });
});

describe('pseudodistancias', () => {
  const travelTimeNanos = 72e6; // 72 ms ≈ 21 585 km
  const expectedPseudorangeMeters = (travelTimeNanos / 1e9) * speedOfLightMetersPerSecond;
  const towState = measurementStateBits.codeLock | measurementStateBits.towDecoded;

  it('calcula la pseudodistancia GPS a partir del tiempo de la semana', () => {
    const receiverTimeOfWeekNanos = 345_600e9 + 123_456_789;
    const pseudorangeMeters = computePseudorangeMeters(
      {
        constellationId: 'gps',
        state: towState,
        receivedSvTimeNanos: receiverTimeOfWeekNanos - travelTimeNanos,
        receivedSvTimeUncertaintyNanos: 20,
        timeOffsetNanos: 0,
      },
      receiverTimeOfWeekNanos,
    );
    expect(pseudorangeMeters).toBeCloseTo(expectedPseudorangeMeters, 3);
  });

  it('corrige el cambio de semana y el desfase de tiempo de BeiDou', () => {
    const receiverTimeOfWeekNanos = 30e6; // justo después del cambio de semana
    const acrossWeek = computePseudorangeMeters(
      {
        constellationId: 'galileo',
        state: towState,
        receivedSvTimeNanos: nanosecondsPerWeek + receiverTimeOfWeekNanos - travelTimeNanos,
        receivedSvTimeUncertaintyNanos: 20,
        timeOffsetNanos: 0,
      },
      receiverTimeOfWeekNanos,
    );
    expect(acrossWeek).toBeCloseTo(expectedPseudorangeMeters, 3);

    const beidouReceiverTimeNanos = 200_000e9;
    const beidouPseudorange = computePseudorangeMeters(
      {
        constellationId: 'beidou',
        state: towState,
        receivedSvTimeNanos: beidouReceiverTimeNanos - 14e9 - travelTimeNanos,
        receivedSvTimeUncertaintyNanos: 20,
        timeOffsetNanos: 0,
      },
      beidouReceiverTimeNanos,
    );
    expect(beidouPseudorange).toBeCloseTo(expectedPseudorangeMeters, 3);
  });

  it('descarta medidas sin TOW, con mucha incertidumbre, de GLONASS o implausibles', () => {
    const receiverTimeOfWeekNanos = 100_000e9;
    const baseTiming = {
      constellationId: 'gps' as const,
      state: towState,
      receivedSvTimeNanos: receiverTimeOfWeekNanos - travelTimeNanos,
      receivedSvTimeUncertaintyNanos: 20,
      timeOffsetNanos: 0,
    };
    expect(computePseudorangeMeters({ ...baseTiming, state: measurementStateBits.codeLock }, receiverTimeOfWeekNanos)).toBeNull();
    expect(computePseudorangeMeters({ ...baseTiming, receivedSvTimeUncertaintyNanos: 1e6 }, receiverTimeOfWeekNanos)).toBeNull();
    expect(computePseudorangeMeters({ ...baseTiming, constellationId: 'glonass' }, receiverTimeOfWeekNanos)).toBeNull();
    expect(
      computePseudorangeMeters({ ...baseTiming, receivedSvTimeNanos: receiverTimeOfWeekNanos - 1e6 }, receiverTimeOfWeekNanos),
    ).toBeNull();
    expect(computePseudorangeMeters(baseTiming, Number.NaN)).toBeNull();
  });
});

describe('conversión de los datos nativos', () => {
  function makeRawMeasurement(overrides: Partial<RawMeasurement> = {}): RawMeasurement {
    return {
      constellationType: 1,
      svid: 5,
      cn0DbHz: 40,
      carrierFrequencyHz: 1575.42e6,
      state: measurementStateBits.towDecoded,
      receivedSvTimeNanos: 100_000e9 - 70e6,
      receivedSvTimeUncertaintyNanos: 15,
      timeOffsetNanos: 0,
      multipathIndicator: 2,
      automaticGainControlLevelDb: null,
      ...overrides,
    };
  }

  it('convierte el estado de los satélites', () => {
    const [observation] = toSatelliteObservations([
      {
        constellationType: 6,
        svid: 12,
        cn0DbHz: 33.5,
        elevationDegrees: 40,
        azimuthDegrees: 200,
        usedInFix: true,
        carrierFrequencyHz: 1176.45e6,
      },
    ]);
    expect(observation).toEqual({
      constellationId: 'galileo',
      svid: 12,
      bandId: 'L5',
      carrierToNoiseDensityDbHz: 33.5,
      elevationDegrees: 40,
      azimuthDegrees: 200,
      isUsedInFix: true,
    });
  });

  it('prefiere el AGC por banda de Android 14 y si no usa el de cada medida', () => {
    expect(
      toAutomaticGainControlReadings({
        receiverTimeOfWeekNanos: null,
        measurements: [makeRawMeasurement({ automaticGainControlLevelDb: 99 })],
        automaticGainControls: [{ constellationType: 1, carrierFrequencyHz: 1176.45e6, levelDb: 12 }],
      }),
    ).toEqual([{ bandId: 'L5', levelDb: 12 }]);

    expect(
      toAutomaticGainControlReadings({
        receiverTimeOfWeekNanos: null,
        measurements: [
          makeRawMeasurement({ svid: 1, automaticGainControlLevelDb: 10 }),
          makeRawMeasurement({ svid: 2, automaticGainControlLevelDb: 12 }),
          makeRawMeasurement({ svid: 3, automaticGainControlLevelDb: null }),
        ],
        automaticGainControls: [],
      }),
    ).toEqual([{ bandId: 'L1', levelDb: 11 }]);
  });

  it('resume las medidas crudas: pseudodistancias y multitrayecto', () => {
    const rawMeasurementsSummary = summarizeRawMeasurements({
      receiverTimeOfWeekNanos: 100_000e9,
      measurements: [
        makeRawMeasurement({ svid: 5 }),
        makeRawMeasurement({ svid: 6, multipathIndicator: 1, receivedSvTimeNanos: 100_000e9 - 80e6 }),
        makeRawMeasurement({ svid: 7, state: 1 }),
      ],
      automaticGainControls: [],
    });
    expect(rawMeasurementsSummary.measurementCount).toBe(3);
    expect(rawMeasurementsSummary.pseudorangeCount).toBe(2);
    expect(rawMeasurementsSummary.multipathDetectedCount).toBe(1);
    expect(rawMeasurementsSummary.pseudorangeKilometersRange?.minimum).toBeCloseTo(20_985.5, 0);
    expect(rawMeasurementsSummary.pseudorangeMetersBySignal.has('gps-5-L1')).toBe(true);
  });
});
