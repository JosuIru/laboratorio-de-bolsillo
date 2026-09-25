import { analyzeNetwork, buildDemoReadings } from './networkAnalysis';

const timingUncertaintySeconds = 0.004;

describe('analyzeNetwork', () => {
  it('con los datos de ejemplo encuentra el golpe cerca de (2,2; 0,4) y unos 300 m/s', () => {
    const networkAnalysis = analyzeNetwork({ stations: buildDemoReadings(), method: 'free', timingUncertaintySeconds });
    if (networkAnalysis.status !== 'solved') throw new Error(networkAnalysis.status);
    expect(Math.hypot(networkAnalysis.source.xMeters - 2.2, networkAnalysis.source.yMeters - 0.4)).toBeLessThan(0.3);
    expect(Math.abs(networkAnalysis.apparentSpeedMetersPerSecond - 300)).toBeLessThan(90);
    expect(networkAnalysis.compatibleRegion.length).toBeGreaterThan(0);
    expect(networkAnalysis.hasNoRedundancy).toBe(false);
    expect(networkAnalysis.hasLargeResidual).toBe(false);
  });

  it('pide más estaciones según el método', () => {
    const threeStations = buildDemoReadings().slice(0, 3);
    expect(analyzeNetwork({ stations: threeStations, method: 'free', timingUncertaintySeconds })).toMatchObject({
      status: 'not-enough-stations',
      requiredStationCount: 4,
    });
    const knownSpeedAnalysis = analyzeNetwork({
      stations: [...threeStations, buildDemoReadings()[4]!],
      method: 'known-speed',
      knownSpeedMetersPerSecond: 300,
      timingUncertaintySeconds,
    });
    expect(knownSpeedAnalysis.status).toBe('solved');
  });

  it('no cuenta dos veces estaciones en el mismo sitio', () => {
    const [firstReading] = buildDemoReadings();
    const duplicatedStations = [0, 1, 2, 3].map((copyIndex) => ({ ...firstReading!, stationName: `copia ${copyIndex}` }));
    expect(analyzeNetwork({ stations: duplicatedStations, method: 'free', timingUncertaintySeconds }).status).toBe(
      'not-enough-stations',
    );
  });

  it('con el foco conocido mide la velocidad y avisa si falta el foco', () => {
    const demoReadings = buildDemoReadings();
    expect(analyzeNetwork({ stations: demoReadings, method: 'known-source', timingUncertaintySeconds }).status).toBe(
      'missing-parameter',
    );
    const networkAnalysis = analyzeNetwork({
      stations: demoReadings,
      method: 'known-source',
      knownSource: { xMeters: 2.2, yMeters: 0.4 },
      timingUncertaintySeconds,
    });
    if (networkAnalysis.status !== 'solved') throw new Error(networkAnalysis.status);
    expect(Math.abs(networkAnalysis.apparentSpeedMetersPerSecond - 300)).toBeLessThan(60);
    expect(networkAnalysis.residualsSeconds).toHaveLength(demoReadings.length);
  });

  it('marca un residuo grande cuando una llegada está mal apuntada', () => {
    const demoReadings = buildDemoReadings();
    demoReadings[2] = { ...demoReadings[2]!, arrivalSeconds: demoReadings[2]!.arrivalSeconds + 0.05 };
    const networkAnalysis = analyzeNetwork({ stations: demoReadings, method: 'free', timingUncertaintySeconds: 0.002 });
    expect(networkAnalysis.status === 'solved' && networkAnalysis.hasLargeResidual).toBe(true);
  });
});
