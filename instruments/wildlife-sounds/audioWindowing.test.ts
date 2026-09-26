import {
  chooseHopSeconds,
  contiguousHopSeconds,
  createAudioWindowCollector,
  overlappedHopSeconds,
  rootMeanSquareDecibels,
} from './audioWindowing';

function rampFrom(startValue: number, sampleCount: number): Float32Array {
  return Float32Array.from({ length: sampleCount }, (_, sampleIndex) => startValue + sampleIndex);
}

describe('createAudioWindowCollector', () => {
  it('no entrega nada hasta tener una ventana completa', () => {
    const windowCollector = createAudioWindowCollector(10);
    windowCollector.pushSamples(rampFrom(0, 6));
    expect(windowCollector.takeWindowIfReady(5)).toBeNull();
    windowCollector.pushSamples(rampFrom(6, 4));
    expect(Array.from(windowCollector.takeWindowIfReady(5)!)).toEqual(Array.from(rampFrom(0, 10)));
  });

  it('solapa según el salto pedido y entrega las muestras en orden', () => {
    const windowCollector = createAudioWindowCollector(10);
    windowCollector.pushSamples(rampFrom(0, 10));
    expect(windowCollector.takeWindowIfReady(5)).not.toBeNull();
    windowCollector.pushSamples(rampFrom(10, 3));
    expect(windowCollector.takeWindowIfReady(5)).toBeNull();
    windowCollector.pushSamples(rampFrom(13, 2));
    expect(Array.from(windowCollector.takeWindowIfReady(5)!)).toEqual(Array.from(rampFrom(5, 10)));
  });

  it('si se ha retrasado, salta a la ventana más reciente', () => {
    const windowCollector = createAudioWindowCollector(4);
    windowCollector.pushSamples(rampFrom(0, 4));
    windowCollector.takeWindowIfReady(2);
    windowCollector.pushSamples(rampFrom(4, 7));
    expect(Array.from(windowCollector.takeWindowIfReady(2)!)).toEqual([7, 8, 9, 10]);
    expect(windowCollector.takeWindowIfReady(2)).toBeNull();
  });

  it('se vacía con reset', () => {
    const windowCollector = createAudioWindowCollector(4);
    windowCollector.pushSamples(rampFrom(0, 4));
    windowCollector.reset();
    expect(windowCollector.takeWindowIfReady(1)).toBeNull();
  });
});

describe('chooseHopSeconds', () => {
  it('solapa mientras el análisis es rápido y deja de hacerlo si es lento', () => {
    expect(chooseHopSeconds(null)).toBe(overlappedHopSeconds);
    expect(chooseHopSeconds(400)).toBe(overlappedHopSeconds);
    expect(chooseHopSeconds(2000)).toBe(contiguousHopSeconds);
  });
});

describe('rootMeanSquareDecibels', () => {
  it('da 0 dBFS para una señal de amplitud 1 constante y un suelo para el silencio', () => {
    expect(rootMeanSquareDecibels([1, -1, 1, -1])).toBeCloseTo(0, 6);
    expect(rootMeanSquareDecibels(new Float32Array(8))).toBe(-200);
  });
});
