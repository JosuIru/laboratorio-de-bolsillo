import type { DetectedParticleEvent, FrameDetectionResult, ParticleShape } from './darkFrameEvents';
import {
  analyzedFrameFraction,
  liveObservationMinutes,
  applyFrameDetection,
  createDetectionSession,
  defaultDetectionSessionOptions,
  summarizeDetectionSession,
} from './detectionSession';

function fakeEvent(peakPixelIndex: number, shape: ParticleShape = 'spot'): DetectedParticleEvent {
  return {
    shape,
    pixelCount: 3,
    peakBrightness: 120,
    peakPixelIndex,
    totalExcessBrightness: 200,
    centerX: 0,
    centerY: 0,
    lengthPixels: 2,
    widthPixels: 1,
    perpendicularRmsPixels: 0.3,
    boundingWidth: 2,
    boundingHeight: 1,
    thumbnailPixels: new Uint8Array(16 * 16),
    thumbnailSide: 16,
  };
}

function frameWith(events: DetectedParticleEvent[], overrides: Partial<FrameDetectionResult> = {}): FrameDetectionResult {
  return {
    darkLevel: 4,
    isLightLeak: false,
    isOverflowing: false,
    clusterCount: events.length,
    oversizedClusterCount: 0,
    events,
    ...overrides,
  };
}

describe('sesión de detección', () => {
  it('cuenta los sucesos por forma y da la tasa por minuto', () => {
    const sessionState = createDetectionSession(100, 100, 20, new Int32Array(0));
    applyFrameDetection(sessionState, frameWith([fakeEvent(10, 'track')]), 1000);
    applyFrameDetection(sessionState, frameWith([]), 1100);
    applyFrameDetection(sessionState, frameWith([fakeEvent(5000, 'worm'), fakeEvent(9000, 'spot')]), 1200);
    const summary = summarizeDetectionSession(sessionState, 2);
    expect(summary.eventCount).toBe(3);
    expect(summary.trackCount).toBe(1);
    expect(summary.wormCount).toBe(1);
    expect(summary.spotCount).toBe(1);
    expect(summary.allEventsRate!.ratePerMinute).toBe(1.5);
    expect(summary.meanDarkLevel).toBe(4);
    expect(sessionState.analyzedFrameCount).toBe(3);
  });

  it('no cuenta los fotogramas con luz ni los fogonazos de ruido', () => {
    const sessionState = createDetectionSession(100, 100, 20, new Int32Array(0));
    applyFrameDetection(sessionState, frameWith([], { isLightLeak: true, darkLevel: 90 }), 0);
    applyFrameDetection(sessionState, frameWith([], { isOverflowing: true }), 0);
    const burstEvents = Array.from({ length: 6 }, (_unused, eventIndex) => fakeEvent(eventIndex * 1000));
    applyFrameDetection(sessionState, frameWith(burstEvents, { clusterCount: 12 }), 0);
    expect(sessionState.acceptedEvents).toHaveLength(0);
    expect(sessionState.lightLeakFrameCount).toBe(1);
    expect(sessionState.noisyFrameCount).toBe(2);
    expect(sessionState.analyzedFrameCount).toBe(2);
  });

  it('un píxel que se repite pasa a la máscara y sus sucesos se retiran', () => {
    const sessionState = createDetectionSession(100, 100, 20, Int32Array.from([1]));
    applyFrameDetection(sessionState, frameWith([fakeEvent(505)]), 0);
    applyFrameDetection(sessionState, frameWith([fakeEvent(7777)]), 0);
    applyFrameDetection(sessionState, frameWith([fakeEvent(506)]), 0);
    const outcome = applyFrameDetection(sessionState, frameWith([fakeEvent(505)]), 0);
    expect(outcome.hasDetectionSettingsChanged).toBe(true);
    expect(sessionState.acceptedEvents.map((acceptedEvent) => acceptedEvent.peakPixelIndex)).toEqual([7777]);
    expect(sessionState.discardedHotEventCount).toBe(3);
    expect(Array.from(sessionState.hotPixelIndices)).toContain(505);
    expect(Array.from(sessionState.hotPixelIndices)).toContain(1);
    expect(sessionState.addedHotPixelCount).toBe(9);
  });

  it('sube el umbral si en una tanda salen demasiados sucesos', () => {
    const sessionState = createDetectionSession(1000, 1000, 20, new Int32Array(0));
    let hasChanged = false;
    for (let frameIndex = 0; frameIndex < defaultDetectionSessionOptions.adaptationWindowFrames; frameIndex++) {
      const outcome = applyFrameDetection(sessionState, frameWith([fakeEvent(frameIndex * 997)]), frameIndex);
      hasChanged ||= outcome.hasDetectionSettingsChanged;
    }
    expect(hasChanged).toBe(true);
    expect(sessionState.thresholdOffset).toBe(25);
    expect(sessionState.thresholdRaiseCount).toBe(1);
  });

  it('estima la fracción de fotogramas analizados', () => {
    expect(analyzedFrameFraction(150, 60, 10)).toBe(0.25);
    expect(analyzedFrameFraction(1000, 60, 10)).toBe(1);
    expect(analyzedFrameFraction(10, 60, undefined)).toBeNull();
  });

  it('cuenta como tiempo útil solo el de los fotogramas limpios', () => {
    // 10 min; de 3000 fotogramas analizados, 600 descartados → 8 min útiles.
    expect(
      liveObservationMinutes({ elapsedSeconds: 600, processedFrameCount: 3000, cleanFrameCount: 2400, framesPerSecond: undefined }),
    ).toBeCloseTo(8);
    // Con la cadencia conocida (10/s = 6000 fotogramas), solo se analizó la mitad → 4 min.
    expect(
      liveObservationMinutes({ elapsedSeconds: 600, processedFrameCount: 3000, cleanFrameCount: 2400, framesPerSecond: 10 }),
    ).toBeCloseTo(4);
    expect(
      liveObservationMinutes({ elapsedSeconds: 600, processedFrameCount: 0, cleanFrameCount: 0, framesPerSecond: 10 }),
    ).toBe(0);
  });
});
