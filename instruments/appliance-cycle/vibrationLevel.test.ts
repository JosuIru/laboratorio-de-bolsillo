import {
  createWindowLevelMeter,
  levelToDecibels,
  median,
  type SensorLevelWindow,
  summarizeLevelHistory,
} from './vibrationLevel';

const sampleRateHz = 50;

function feedSamples(
  sampleCount: number,
  accelerationAt: (timeSeconds: number) => [number, number, number],
  startSeconds = 0,
) {
  const levelMeter = createWindowLevelMeter();
  const closedWindows: SensorLevelWindow[] = [];
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const timeSeconds = startSeconds + sampleIndex / sampleRateHz;
    const [x, y, z] = accelerationAt(timeSeconds);
    const closedWindow = levelMeter.push(timeSeconds, x, y, z);
    if (closedWindow) closedWindows.push(closedWindow);
  }
  return closedWindows;
}

describe('createWindowLevelMeter', () => {
  it('la gravedad (constante, en cualquier eje) no cuenta como vibración', () => {
    const closedWindows = feedSamples(5 * sampleRateHz, () => [3.2, -1.1, 9.2]);
    expect(closedWindows).toHaveLength(4);
    for (const closedWindow of closedWindows) expect(closedWindow.level).toBeCloseTo(0, 9);
  });

  it('una vibración senoidal da su valor eficaz (amplitud / √2)', () => {
    const vibrationAmplitude = 0.3;
    const closedWindows = feedSamples(3 * sampleRateHz + 1, (timeSeconds) => [
      0,
      vibrationAmplitude * Math.sin(2 * Math.PI * 10 * timeSeconds),
      9.81,
    ]);
    expect(closedWindows.length).toBeGreaterThanOrEqual(2);
    for (const closedWindow of closedWindows) {
      expect(closedWindow.level).toBeCloseTo(vibrationAmplitude / Math.SQRT2, 2);
      expect(closedWindow.sampleCount).toBe(sampleRateHz);
    }
  });

  it('suma la vibración de los tres ejes', () => {
    const closedWindows = feedSamples(2 * sampleRateHz + 1, (timeSeconds) => {
      const wave = Math.sin(2 * Math.PI * 5 * timeSeconds);
      return [0.1 * wave, 0.1 * wave, 9.81 + 0.1 * wave];
    });
    expect(closedWindows[0]!.level).toBeCloseTo(Math.sqrt(3) * (0.1 / Math.SQRT2), 2);
  });

  it('tras un hueco en los datos tira la ventana a medias y empieza otra', () => {
    const levelMeter = createWindowLevelMeter();
    for (let sampleIndex = 0; sampleIndex < 30; sampleIndex++) levelMeter.push(sampleIndex / sampleRateHz, 0, 0, 9.81);
    // Hueco de 5 s: la siguiente ventana empieza en el segundo 5,5 y no se cierra antes de 6,5.
    const firstAfterGap = 5.5;
    let closedWindow: SensorLevelWindow | null = null;
    for (let sampleIndex = 0; sampleIndex <= sampleRateHz && !closedWindow; sampleIndex++) {
      closedWindow = levelMeter.push(firstAfterGap + sampleIndex / sampleRateHz, 0, 0, 9.81);
    }
    expect(closedWindow?.startTimestampSeconds).toBeCloseTo(firstAfterGap);
    expect(closedWindow?.endTimestampSeconds).toBeCloseTo(firstAfterGap + 1);
  });

  it('no da nivel con muy pocas muestras en la ventana (sensor atascado)', () => {
    const levelMeter = createWindowLevelMeter();
    const closedWindows = [0, 0.5, 0.9, 1.0, 1.1].map((timeSeconds) => levelMeter.push(timeSeconds, 0, 0, 9.81));
    expect(closedWindows.every((closedWindow) => closedWindow === null)).toBe(true);
  });
});

describe('levelToDecibels', () => {
  it('0 dB es 1 m/s² y cada factor 10 son 20 dB', () => {
    expect(levelToDecibels(1)).toBeCloseTo(0);
    expect(levelToDecibels(0.1)).toBeCloseTo(-20);
    expect(levelToDecibels(0)).toBeCloseTo(-60);
  });
});

describe('summarizeLevelHistory', () => {
  it('deja igual una historia corta', () => {
    expect(Array.from(summarizeLevelHistory([1, 2, 3], 10))).toEqual([1, 2, 3]);
  });

  it('se queda con el máximo de cada tramo para no perder picos cortos', () => {
    const levels = Array<number>(1000).fill(0.01);
    levels[503] = 2;
    const summary = summarizeLevelHistory(levels, 100);
    expect(summary).toHaveLength(100);
    expect(summary[50]).toBe(2);
    expect(Math.max(...Array.from(summary))).toBe(2);
    expect(summary[0]).toBe(0.01);
  });
});

describe('median', () => {
  it('ordena y toma el centro', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
