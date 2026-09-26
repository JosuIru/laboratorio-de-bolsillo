import { meteorsPerHour, type MeteorEvent, MeteorWatcher } from './meteorDetection';
import { createGaussianRandom, randomStars, renderStarField } from './syntheticStarField.testHelpers';

const width = 160;
const height = 120;
const frameIntervalMilliseconds = 200;
const stars = randomStars(60, width, height, 4, 200, 2500);
const hotPixels = [
  { x: 20, y: 30, excess: 150 },
  { x: 90, y: 100, excess: 200 },
];

/** Fotograma de 8 bits del cielo con ruido; `drawExtras` añade objetos al fotograma. */
function skyFrame(frameIndex: number, drawExtras?: (values: Float32Array) => void): Uint8Array {
  const frame = renderStarField({ width, height, stars, backgroundLevel: 25, noiseSigma: 3, seed: 1000 + frameIndex, hotPixels });
  drawExtras?.(frame.values);
  const bytes = new Uint8Array(frame.values.length);
  for (let pixelIndex = 0; pixelIndex < bytes.length; pixelIndex++) {
    bytes[pixelIndex] = Math.max(0, Math.min(255, Math.round(frame.values[pixelIndex]!)));
  }
  return bytes;
}

/** Trazo recto de 1 px de ancho con brillo `excess`. */
function drawStreak(values: Float32Array, startX: number, startY: number, endX: number, endY: number, excess: number) {
  const stepCount = Math.ceil(Math.hypot(endX - startX, endY - startY) * 2);
  const paintedPixels = new Set<number>();
  for (let stepIndex = 0; stepIndex <= stepCount; stepIndex++) {
    const fraction = stepIndex / stepCount;
    const pixelIndex = Math.round(startY + fraction * (endY - startY)) * width + Math.round(startX + fraction * (endX - startX));
    if (paintedPixels.has(pixelIndex)) continue;
    paintedPixels.add(pixelIndex);
    values[pixelIndex] = values[pixelIndex]! + excess;
  }
}

function watchSequence(frameCount: number, drawExtrasForFrame: (frameIndex: number, values: Float32Array) => void) {
  const watcher = new MeteorWatcher(width, height);
  const meteorEvents: MeteorEvent[] = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    const frameBytes = skyFrame(frameIndex, (values) => drawExtrasForFrame(frameIndex, values));
    meteorEvents.push(...watcher.addFrame(frameBytes, frameIndex * frameIntervalMilliseconds).confirmedMeteors);
  }
  meteorEvents.push(...watcher.flush());
  return { meteorEvents, statistics: watcher.statistics() };
}

describe('MeteorWatcher', () => {
  it('detecta un meteoro de un solo fotograma, con su hora y su trazo', () => {
    const { meteorEvents, statistics } = watchSequence(20, (frameIndex, values) => {
      if (frameIndex === 11) drawStreak(values, 30, 20, 110, 70, 60);
    });
    expect(meteorEvents).toHaveLength(1);
    const meteorEvent = meteorEvents[0]!;
    expect(meteorEvent.frameIndex).toBe(11);
    expect(meteorEvent.timestampMilliseconds).toBe(11 * frameIntervalMilliseconds);
    expect(meteorEvent.segment.lengthPixels).toBeGreaterThan(85);
    expect(meteorEvent.segment.lengthPixels).toBeLessThan(100);
    const segmentEnds = [
      { x: meteorEvent.segment.startX, y: meteorEvent.segment.startY },
      { x: meteorEvent.segment.endX, y: meteorEvent.segment.endY },
    ].sort((first, second) => first.x - second.x);
    expect(Math.hypot(segmentEnds[0]!.x - 30, segmentEnds[0]!.y - 20)).toBeLessThan(3);
    expect(Math.hypot(segmentEnds[1]!.x - 110, segmentEnds[1]!.y - 70)).toBeLessThan(3);
    expect(meteorEvent.frameBytes).toHaveLength(width * height);
    expect(statistics.meteorCount).toBe(1);
    expect(statistics.rejectedSlowMoverCount).toBe(0);
  });

  it('un meteoro que cae en dos fotogramas cuenta una vez', () => {
    const { meteorEvents } = watchSequence(20, (frameIndex, values) => {
      if (frameIndex === 8) drawStreak(values, 20, 100, 70, 70, 50);
      if (frameIndex === 9) drawStreak(values, 75, 67, 130, 34, 40);
    });
    expect(meteorEvents).toHaveLength(1);
  });

  it('descarta un objeto lento (satélite, avión) presente en varios fotogramas', () => {
    // Trazos de 18 px que avanzan 20 px por fotograma durante 7 fotogramas.
    const { meteorEvents, statistics } = watchSequence(22, (frameIndex, values) => {
      const stepIndex = frameIndex - 8;
      if (stepIndex < 0 || stepIndex >= 7) return;
      drawStreak(values, 10 + stepIndex * 20, 60 + stepIndex * 4, 28 + stepIndex * 20, 60 + stepIndex * 4 + 3.6, 70);
    });
    expect(meteorEvents).toHaveLength(0);
    expect(statistics.rejectedSlowMoverCount).toBeGreaterThan(0);
  });

  it('no da falsas alarmas con ruido, estrellas fijas y píxeles calientes', () => {
    const { meteorEvents, statistics } = watchSequence(30, () => undefined);
    expect(meteorEvents).toHaveLength(0);
    expect(statistics.processedFrameCount).toBe(25);
    expect(statistics.watchedMilliseconds).toBe(24 * frameIntervalMilliseconds);
  });

  it('salta los fotogramas que cambian enteros (faros, nubes)', () => {
    const noiseRandom = createGaussianRandom(9);
    const { meteorEvents, statistics } = watchSequence(15, (frameIndex, values) => {
      if (frameIndex !== 10) return;
      for (let pixelIndex = 0; pixelIndex < values.length; pixelIndex++) values[pixelIndex] = values[pixelIndex]! + 40 + noiseRandom();
    });
    expect(meteorEvents).toHaveLength(0);
    expect(statistics.skippedFrameCount).toBe(1);
  });
});

describe('meteorsPerHour', () => {
  it('da la tasa horaria y nada con menos de un minuto', () => {
    expect(meteorsPerHour(5, 30 * 60_000)).toBeCloseTo(10, 9);
    expect(meteorsPerHour(1, 30_000)).toBeNull();
  });
});
