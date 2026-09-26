import { createNoiseSessionLog, detectNoiseEpisodes, type SecondLevelSeries, summarizeSecondSeries } from './noiseSession';

/** Una sesión que empieza a las 23:00:00 UTC (minuto de reloj exacto). */
const sessionStartTimestamp = Date.UTC(2026, 8, 26, 23, 0, 0);

function secondSeriesFromLevels(secondLevels: number[], firstTimestamp = sessionStartTimestamp): SecondLevelSeries {
  return {
    startTimestamps: secondLevels.map((_, secondIndex) => firstTimestamp + secondIndex * 1000),
    equivalentLevels: secondLevels,
    maximumLevels: secondLevels.map((secondLevel) => secondLevel + 3),
  };
}

describe('createNoiseSessionLog', () => {
  it('agrupa ventanas cortas en segundos y en minutos de reloj con media energética', () => {
    const sessionLog = createNoiseSessionLog(sessionStartTimestamp);
    // 8 ventanas por segundo durante 90 s: la primera mitad de cada segundo a 70 dB, la otra a 40.
    for (let windowIndex = 0; windowIndex < 90 * 8; windowIndex++) {
      sessionLog.pushShortWindowLevel(sessionStartTimestamp + windowIndex * 125, windowIndex % 8 < 4 ? 70 : 40);
    }
    sessionLog.finish();

    const secondSeries = sessionLog.readSecondSeries();
    expect(secondSeries.equivalentLevels).toHaveLength(90);
    expect(secondSeries.equivalentLevels[0]).toBeCloseTo(67.0, 1);
    expect(secondSeries.maximumLevels[0]).toBe(70);

    const minuteRows = sessionLog.readMinuteRows();
    expect(minuteRows.map((minuteRow) => minuteRow.minuteStartTimestamp)).toEqual([
      sessionStartTimestamp,
      sessionStartTimestamp + 60_000,
    ]);
    expect(minuteRows[0]!.shortWindowCount).toBe(480);
    expect(minuteRows[1]!.shortWindowCount).toBe(240);
    expect(minuteRows[0]!.equivalentLevelDecibels).toBeCloseTo(67.0, 1);
    expect(minuteRows[0]!.maximumLevelDecibels).toBe(70);
    expect(sessionLog.readElapsedSeconds()).toBeCloseTo(89.875, 3);
  });

  it('descarta niveles no finitos y marcas anteriores al inicio', () => {
    const sessionLog = createNoiseSessionLog(sessionStartTimestamp);
    sessionLog.pushShortWindowLevel(sessionStartTimestamp - 500, 50);
    sessionLog.pushShortWindowLevel(sessionStartTimestamp + 100, Number.NaN);
    sessionLog.finish();
    expect(sessionLog.readSecondSeries().equivalentLevels).toEqual([]);
    expect(sessionLog.readMinuteRows()).toEqual([]);
  });
});

describe('summarizeSecondSeries', () => {
  it('calcula Leq, máximo, L10 y L90 del periodo', () => {
    // 90 s de fondo a 35 dB y 10 s de ruido a 65 dB.
    const summary = summarizeSecondSeries(secondSeriesFromLevels([...Array(90).fill(35), ...Array(10).fill(65)]));
    expect(summary).not.toBeNull();
    expect(summary!.equivalentLevelDecibels).toBeCloseTo(55.0, 0);
    expect(summary!.maximumLevelDecibels).toBe(68);
    expect(summary!.level90Decibels).toBe(35);
    expect(summary!.level10Decibels).toBeGreaterThan(35);
    expect(summary!.measuredSeconds).toBe(100);
  });

  it('devuelve null sin datos', () => {
    expect(summarizeSecondSeries(secondSeriesFromLevels([]))).toBeNull();
  });
});

describe('detectNoiseEpisodes', () => {
  const detectionOptions = { thresholdDecibels: 45, minimumDurationSeconds: 5, toleratedGapSeconds: 2 };

  it('anota los tramos por encima del umbral que duran lo suficiente', () => {
    const secondLevels = [
      ...Array(10).fill(30),
      ...Array(8).fill(60), // episodio de 8 s
      ...Array(10).fill(30),
      ...Array(3).fill(70), // demasiado corto
      ...Array(10).fill(30),
    ];
    const detectedEpisodes = detectNoiseEpisodes(secondSeriesFromLevels(secondLevels), detectionOptions);
    expect(detectedEpisodes).toHaveLength(1);
    expect(detectedEpisodes[0]).toEqual({
      startTimestamp: sessionStartTimestamp + 10_000,
      durationSeconds: 8,
      maximumLevelDecibels: 63,
      equivalentLevelDecibels: expect.closeTo(60, 6),
    });
  });

  it('los silencios cortos no parten el episodio, los largos sí', () => {
    const secondLevels = [...Array(3).fill(60), 30, 30, ...Array(3).fill(60), 30, 30, 30, ...Array(5).fill(60)];
    const detectedEpisodes = detectNoiseEpisodes(secondSeriesFromLevels(secondLevels), detectionOptions);
    expect(detectedEpisodes.map((episode) => episode.durationSeconds)).toEqual([8, 5]);
    expect(detectedEpisodes[1]!.startTimestamp).toBe(sessionStartTimestamp + 11_000);
  });

  it('un hueco en los datos corta el episodio', () => {
    const firstStretch = secondSeriesFromLevels(Array(4).fill(60));
    const secondStretch = secondSeriesFromLevels(Array(4).fill(60), sessionStartTimestamp + 60_000);
    const seriesWithGap: SecondLevelSeries = {
      startTimestamps: [...firstStretch.startTimestamps, ...secondStretch.startTimestamps],
      equivalentLevels: [...firstStretch.equivalentLevels, ...secondStretch.equivalentLevels],
      maximumLevels: [...firstStretch.maximumLevels, ...secondStretch.maximumLevels],
    };
    expect(detectNoiseEpisodes(seriesWithGap, { ...detectionOptions, minimumDurationSeconds: 4 })).toHaveLength(2);
  });

  it('cierra un episodio que sigue abierto al final', () => {
    const detectedEpisodes = detectNoiseEpisodes(secondSeriesFromLevels([30, ...Array(6).fill(50)]), detectionOptions);
    expect(detectedEpisodes).toHaveLength(1);
    expect(detectedEpisodes[0]!.durationSeconds).toBe(6);
  });
});
