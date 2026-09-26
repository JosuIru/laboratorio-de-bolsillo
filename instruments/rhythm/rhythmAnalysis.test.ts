import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import { analyzeFreeClapping, beatTimeSeconds, findCountInGrid, scoreContinuation } from './rhythmAnalysis';

const periodSeconds = 0.5;
const clickCount = 8;

/** Clics tal como los oye el micrófono: con latencia y un poco de imprecisión de detección. */
function detectedClicks(latencySeconds: number, jitterSeconds = 0.003, seed = 1) {
  const nextRandom = createSeededRandom(seed);
  return Array.from(
    { length: clickCount },
    (_, clickIndex) => 1 + latencySeconds + clickIndex * periodSeconds + (nextRandom() - 0.5) * 2 * jitterSeconds,
  );
}

describe('findCountInGrid', () => {
  it('encuentra los clics y ajusta la rejilla sin conocer la latencia', () => {
    const countIn = findCountInGrid(detectedClicks(0.23), {
      nominalPeriodSeconds: periodSeconds,
      clickCount,
      expectedFirstClickSeconds: 1,
    })!;
    expect(countIn.matchedClickCount).toBe(clickCount);
    expect(countIn.beatGrid.firstBeatSeconds).toBeCloseTo(1.23, 2);
    expect(countIn.beatGrid.periodSeconds).toBeCloseTo(periodSeconds, 3);
    expect(countIn.lastClickSeconds).toBeCloseTo(1.23 + 7 * periodSeconds, 2);
  });

  it('ignora ruidos sueltos y tolera un clic no detectado', () => {
    const clickTimes = detectedClicks(0.1).filter((_, clickIndex) => clickIndex !== 3);
    const onsetTimes = [...clickTimes, 1.05, 2.37, 3.9].sort((leftTime, rightTime) => leftTime - rightTime);
    const countIn = findCountInGrid(onsetTimes, { nominalPeriodSeconds: periodSeconds, clickCount, expectedFirstClickSeconds: 1 })!;
    expect(countIn.matchedClickCount).toBe(clickCount - 1);
    expect(countIn.beatGrid.firstBeatSeconds).toBeCloseTo(1.1, 2);
  });

  it('devuelve null si no se oyen los clics', () => {
    expect(findCountInGrid([1.3, 2.9], { nominalPeriodSeconds: periodSeconds, clickCount, expectedFirstClickSeconds: 1 })).toBeNull();
  });
});

describe('scoreContinuation', () => {
  const beatGrid = { firstBeatSeconds: 1, periodSeconds };
  const continuationOptions = { firstBeatIndex: clickCount, beatCount: 16 };
  const beatIndices = Array.from({ length: 16 }, (_, beatOffset) => clickCount + beatOffset);

  it('una persona perfecta saca 100', () => {
    const perfectClaps = beatIndices.map((beatIndex) => beatTimeSeconds(beatGrid, beatIndex));
    const continuationScore = scoreContinuation(perfectClaps, beatGrid, continuationOptions);
    expect(continuationScore.hitBeatCount).toBe(16);
    expect(continuationScore.intervalVariabilityMilliseconds).toBeCloseTo(0, 6);
    expect(continuationScore.score).toBe(100);
  });

  it('mide el adelanto medio y la variabilidad', () => {
    const nextRandom = createSeededRandom(8);
    const earlyClaps = beatIndices.map(
      (beatIndex) => beatTimeSeconds(beatGrid, beatIndex) - 0.03 + (nextRandom() - 0.5) * 0.04,
    );
    const continuationScore = scoreContinuation(earlyClaps, beatGrid, continuationOptions);
    expect(continuationScore.meanAsynchronyMilliseconds).toBeGreaterThan(-40);
    expect(continuationScore.meanAsynchronyMilliseconds).toBeLessThan(-20);
    expect(continuationScore.intervalVariabilityMilliseconds).toBeGreaterThan(5);
    expect(continuationScore.intervalVariabilityMilliseconds).toBeLessThan(25);
    expect(continuationScore.score).toBeLessThan(100);
  });

  it('sigue la cuenta aunque la persona frene mucho, y mide la deriva', () => {
    // Frena un 4 %: al final va casi un tercio de pulso tarde, pero cada palmada sigue en su pulso.
    const slowingClaps = beatIndices.map(
      (_, beatOffset) => beatTimeSeconds(beatGrid, clickCount) + beatOffset * periodSeconds * 1.04,
    );
    const continuationScore = scoreContinuation(slowingClaps, beatGrid, continuationOptions);
    expect(continuationScore.hitBeatCount).toBe(16);
    expect(continuationScore.missedBeatCount).toBe(0);
    expect(continuationScore.tempoDriftPercent).toBeCloseTo(4, 6);
    expect(continuationScore.beatOffsetsMilliseconds.at(-1)).toBeCloseTo(15 * 0.04 * 500, 6);
  });

  it('un eco espurio no desplaza las palmadas siguientes, aunque la persona frene', () => {
    // Frena un 4 % y, tras la segunda palmada, un eco suena algo más de medio pulso después.
    const slowingClaps = beatIndices.map(
      (_, beatOffset) => beatTimeSeconds(beatGrid, clickCount) + beatOffset * periodSeconds * 1.04,
    );
    const echoTimeSeconds = slowingClaps[1]! + 0.26;
    const continuationScore = scoreContinuation([...slowingClaps, echoTimeSeconds], beatGrid, continuationOptions);
    expect(continuationScore.hitBeatCount).toBe(16);
    expect(continuationScore.extraClapCount).toBe(1);
    expect(continuationScore.tempoDriftPercent).toBeCloseTo(4, 6);
    expect(continuationScore.beatOffsetsMilliseconds[2]).toBeCloseTo(2 * 0.04 * 500, 6);
  });

  it('los ecos justo detrás de cada palmada cuentan como palmadas de más', () => {
    const claps = beatIndices.map((beatIndex) => beatTimeSeconds(beatGrid, beatIndex));
    const echoes = claps.filter((_, clapIndex) => clapIndex % 4 === 0).map((clapTime) => clapTime + 0.12);
    const continuationScore = scoreContinuation([...claps, ...echoes], beatGrid, continuationOptions);
    expect(continuationScore.hitBeatCount).toBe(16);
    expect(continuationScore.extraClapCount).toBe(echoes.length);
    expect(continuationScore.intervalVariabilityMilliseconds).toBeCloseTo(0, 6);
  });

  it('cuenta pulsos perdidos y palmadas de más', () => {
    const claps = beatIndices
      .filter((beatIndex) => beatIndex !== 12 && beatIndex !== 13)
      .map((beatIndex) => beatTimeSeconds(beatGrid, beatIndex));
    claps.push(beatTimeSeconds(beatGrid, 10) + 0.05);
    const continuationScore = scoreContinuation(claps, beatGrid, continuationOptions);
    expect(continuationScore.missedBeatCount).toBe(2);
    expect(continuationScore.extraClapCount).toBe(1);
    expect(continuationScore.beatOffsetsMilliseconds[4]).toBeNull();
    expect(continuationScore.intervalVariabilityMilliseconds).toBeCloseTo(0, 6);
  });

  it('sin palmadas saca 0', () => {
    const continuationScore = scoreContinuation([], beatGrid, continuationOptions);
    expect(continuationScore.score).toBe(0);
    expect(continuationScore.missedBeatCount).toBe(16);
  });
});

describe('analyzeFreeClapping', () => {
  it('da el tempo y lo regular que es el pulso', () => {
    const nextRandom = createSeededRandom(5);
    const clapTimes = Array.from({ length: 12 }, (_, clapIndex) => clapIndex * 0.6 + (nextRandom() - 0.5) * 0.02);
    const freeClapping = analyzeFreeClapping(clapTimes)!;
    expect(freeClapping.beatsPerMinute).toBeGreaterThan(98);
    expect(freeClapping.beatsPerMinute).toBeLessThan(102);
    expect(freeClapping.intervalVariationPercent).toBeLessThan(3);
    expect(freeClapping.clapCount).toBe(12);
  });

  it('una pausa no cuenta como irregularidad', () => {
    const clapTimes = [0, 0.5, 1, 1.5, 3, 3.5, 4, 4.5];
    expect(analyzeFreeClapping(clapTimes)!.intervalVariationPercent).toBeCloseTo(0, 6);
  });

  it('con menos de 4 palmadas no hay análisis', () => {
    expect(analyzeFreeClapping([0, 0.5, 1])).toBeNull();
  });
});
