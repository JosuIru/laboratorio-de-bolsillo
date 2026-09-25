import { frequencyToMusicalNote } from './musicalNotes';
import {
  colormapColor,
  columnFractionToFrequency,
  createColumnBinMapping,
  createSpectrogramHistory,
  pushSpectrumRow,
  renderSpectrogramPixels,
} from './spectrogram';

describe('createColumnBinMapping', () => {
  it('escala lineal: reparte los bins por igual', () => {
    const columnMapping = createColumnBinMapping(4, 1024, 1024, 0, 512, 'linear');
    expect(Array.from(columnMapping.firstBinByColumn)).toEqual([0, 128, 256, 384]);
    expect(Array.from(columnMapping.lastBinByColumn)).toEqual([127, 255, 383, 511]);
  });

  it('escala logarítmica: cada columna cubre el mismo número de octavas', () => {
    expect(columnFractionToFrequency(0, 20, 20_480, 'logarithmic')).toBeCloseTo(20);
    expect(columnFractionToFrequency(0.5, 20, 20_480, 'logarithmic')).toBeCloseTo(640);
    expect(columnFractionToFrequency(1, 20, 20_480, 'logarithmic')).toBeCloseTo(20_480);
    const columnMapping = createColumnBinMapping(64, 48_000, 4096, 20, 20_000, 'logarithmic');
    // Las columnas de graves no quedan vacías: repiten el bin más cercano.
    for (let columnIndex = 0; columnIndex < 64; columnIndex++) {
      expect(columnMapping.lastBinByColumn[columnIndex]!).toBeGreaterThanOrEqual(columnMapping.firstBinByColumn[columnIndex]!);
    }
  });

  it('rechaza escala logarítmica desde 0 Hz', () => {
    expect(() => createColumnBinMapping(8, 48_000, 1024, 0, 20_000, 'logarithmic')).toThrow(RangeError);
  });
});

describe('historial y renderizado', () => {
  const columnMapping = createColumnBinMapping(2, 8, 8, 0, 4, 'linear');

  it('cada columna toma el máximo de sus bins y la fila nueva sale arriba', () => {
    const history = createSpectrogramHistory(3, 2);
    pushSpectrumRow(history, [-100, -20, -90, -80, -160], columnMapping);
    pushSpectrumRow(history, [-10, -10, -10, -10, -10], columnMapping);
    expect(Array.from(history.decibelRows.subarray(0, 2))).toEqual([-20, -80]);
    expect(history.storedRowCount).toBe(2);

    const pixels = new Uint8Array(3 * 2 * 4);
    renderSpectrogramPixels(history, pixels, -100, 0);
    // −10 dB en un rango de −100 a 0 dB: el 90 % de la escala de 256 niveles.
    const expectedLevel = Math.round((-10 + 100) * (255 / 100));
    const expectedNewestColor = colormapColor(expectedLevel / 255);
    expect(Array.from(pixels.subarray(0, 4))).toEqual([...expectedNewestColor, 255]);
    // La tercera fila todavía no tiene datos: color más oscuro.
    expect(Array.from(pixels.subarray(16, 20))).toEqual([...colormapColor(0), 255]);
  });

  it('da la vuelta al llenarse', () => {
    const history = createSpectrogramHistory(2, 2);
    for (const rowDecibels of [-90, -60, -30]) pushSpectrumRow(history, [rowDecibels, rowDecibels, rowDecibels, rowDecibels], columnMapping);
    expect(history.storedRowCount).toBe(2);
    expect(history.decibelRows[history.newestRowIndex * 2]).toBe(-30);
  });
});

describe('colormapColor', () => {
  it('va de casi negro a amarillo claro y acota fuera de rango', () => {
    expect(colormapColor(0)).toEqual([0, 0, 4]);
    expect(colormapColor(1)).toEqual([252, 255, 164]);
    expect(colormapColor(-3)).toEqual(colormapColor(0));
    expect(colormapColor(Number.NaN)).toEqual(colormapColor(0));
  });

  it('la luminosidad crece de forma monótona', () => {
    let previousLuminance = -1;
    for (let stepIndex = 0; stepIndex <= 20; stepIndex++) {
      const [red, green, blue] = colormapColor(stepIndex / 20);
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      expect(luminance).toBeGreaterThan(previousLuminance);
      previousLuminance = luminance;
    }
  });
});

describe('frequencyToMusicalNote', () => {
  it.each([
    [440, { noteIndex: 9, octave: 4, centsOffset: 0 }],
    [261.63, { noteIndex: 0, octave: 4, centsOffset: 0 }],
    [27.5, { noteIndex: 9, octave: 0, centsOffset: 0 }],
    [446, { noteIndex: 9, octave: 4, centsOffset: 23 }],
    [123.47, { noteIndex: 11, octave: 2, centsOffset: 0 }],
  ])('%p Hz', (frequencyHz, expectedNote) => {
    expect(frequencyToMusicalNote(frequencyHz)).toMatchObject(expectedNote);
  });

  it('devuelve null para frecuencias no válidas', () => {
    expect(frequencyToMusicalNote(0)).toBeNull();
    expect(frequencyToMusicalNote(Number.NaN)).toBeNull();
  });
});
