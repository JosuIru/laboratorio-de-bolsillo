import { extractArrivalWaveform } from './arrivalWaveform';

describe('extractArrivalWaveform', () => {
  it('recorta la ventana alrededor de la llegada y conserva la sincronización', () => {
    const timestamps = Float64Array.from({ length: 10 }, (_, sampleIndex) => 100 + sampleIndex * 0.5);
    const series = {
      timestamps,
      accelerationX: timestamps.map((timestampSeconds) => timestampSeconds * 2),
      accelerationY: timestamps.map(() => 0),
      accelerationZ: timestamps.map(() => 9.81),
    };
    const waveform = extractArrivalWaveform(series, 101, 102.5, 99);
    expect(Array.from(waveform.timestamps)).toEqual([101, 101.5, 102, 102.5]);
    expect(Array.from(waveform.accelerationX)).toEqual([202, 203, 204, 205]);
    expect(waveform.accelerationZ).toHaveLength(4);
    expect(waveform.syncTimestampSeconds).toBe(99);
  });

  it('es una copia: no cambia si luego cambian las series', () => {
    const timestamps = Float64Array.from([1, 2, 3]);
    const accelerationX = Float64Array.from([5, 6, 7]);
    const waveform = extractArrivalWaveform(
      { timestamps, accelerationX, accelerationY: accelerationX, accelerationZ: accelerationX },
      0,
      10,
      0,
    );
    accelerationX[0] = 99;
    expect(waveform.accelerationX[0]).toBe(5);
  });
});
