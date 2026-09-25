import { blockLevelDecibels, createImpulseCapture } from './impulseCapture';

const sampleRateHz = 8000;
const blockLength = 256;

function constantBlock(amplitude: number): Float32Array {
  // Alterna el signo para que sea audio (media cero) con RMS = amplitud.
  return Float32Array.from({ length: blockLength }, (_, sampleIndex) => (sampleIndex % 2 === 0 ? amplitude : -amplitude));
}

function pushSeconds(capture: ReturnType<typeof createImpulseCapture>, seconds: number, amplitude: number) {
  const blockCount = Math.ceil((seconds * sampleRateHz) / blockLength);
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) capture.pushBlock(constantBlock(amplitude));
}

describe('blockLevelDecibels', () => {
  it('da el nivel RMS en dB', () => {
    expect(blockLevelDecibels(constantBlock(0.1))).toBeCloseTo(-20, 6);
  });
});

describe('createImpulseCapture', () => {
  it('mide el ruido, espera al golpe y graba la cola', () => {
    const capture = createImpulseCapture({ sampleRateHz, noiseSeconds: 0.5, decaySeconds: 1, preImpulseSeconds: 0.05 });
    pushSeconds(capture, 0.5, 0.001);
    expect(capture.phase).toBe('waiting-for-impulse');
    expect(capture.noiseLevelDecibels).toBeCloseTo(-60, 3);

    pushSeconds(capture, 0.3, 0.002);
    expect(capture.phase).toBe('waiting-for-impulse');

    capture.pushBlock(constantBlock(0.5));
    expect(capture.phase).toBe('recording-decay');
    pushSeconds(capture, 1, 0.01);
    expect(capture.phase).toBe('finished');

    const capturedResponse = capture.capturedResponse!;
    expect(capturedResponse.noiseSamples.length).toBeGreaterThanOrEqual(0.5 * sampleRateHz);
    // Un poco de antes del golpe + el golpe + 1 s de cola.
    expect(capturedResponse.responseSamples.length).toBeGreaterThanOrEqual(1 * sampleRateHz + 0.05 * sampleRateHz);
    expect(capturedResponse.responseSamples.length).toBeLessThan(1.2 * sampleRateHz);
    expect(capturedResponse.isClipped).toBe(false);
  });

  it('detecta la saturación del golpe', () => {
    const capture = createImpulseCapture({ sampleRateHz, noiseSeconds: 0.1, decaySeconds: 0.2 });
    pushSeconds(capture, 0.1, 0.001);
    capture.pushBlock(constantBlock(1));
    pushSeconds(capture, 0.2, 0.01);
    expect(capture.capturedResponse!.isClipped).toBe(true);
  });

  it('se rinde si no llega ningún golpe', () => {
    const capture = createImpulseCapture({ sampleRateHz, noiseSeconds: 0.1, maximumWaitSeconds: 1 });
    pushSeconds(capture, 0.1, 0.001);
    pushSeconds(capture, 1.1, 0.001);
    expect(capture.phase).toBe('timed-out');
    expect(capture.capturedResponse).toBeNull();
  });
});
