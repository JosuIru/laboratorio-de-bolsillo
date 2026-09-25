import { defaultTunerSettings, parseStoredTunerSettings, setCustomTuningDegree } from './tunerStorage';

const albokaTuning = { id: 'alboka', name: 'Mi alboka', centsByDegree: new Array<number>(12).fill(0) };

describe('parseStoredTunerSettings', () => {
  it('sin datos o con datos rotos, usa los ajustes por defecto', () => {
    expect(parseStoredTunerSettings(null)).toEqual(defaultTunerSettings);
    expect(parseStoredTunerSettings('{no es json')).toEqual(defaultTunerSettings);
  });

  it('recupera los ajustes y descarta tablas mal formadas', () => {
    const storedSettings = parseStoredTunerSettings(
      JSON.stringify({
        referenceA4Hz: 442,
        tonicNoteIndex: 5,
        selectedTuningId: 'alboka',
        customTunings: [albokaTuning, { id: 'rota', name: 'Rota', centsByDegree: [1, 2] }],
      }),
    );
    expect(storedSettings.referenceA4Hz).toBe(442);
    expect(storedSettings.tonicNoteIndex).toBe(5);
    expect(storedSettings.selectedTuningId).toBe('alboka');
    expect(storedSettings.customTunings).toEqual([albokaTuning]);
  });

  it('vuelve al temperamento igual si la tabla elegida ya no existe, y limita el La', () => {
    const storedSettings = parseStoredTunerSettings(
      JSON.stringify({ referenceA4Hz: 900, tonicNoteIndex: 14, selectedTuningId: 'borrada', customTunings: [] }),
    );
    expect(storedSettings.selectedTuningId).toBe('equal');
    expect(storedSettings.referenceA4Hz).toBe(480);
    expect(storedSettings.tonicNoteIndex).toBe(0);
  });
});

describe('setCustomTuningDegree', () => {
  it('guarda la desviación redondeada en su grado y limita a un semitono', () => {
    const updatedTuning = setCustomTuningDegree(albokaTuning, 4, -13.7);
    expect(updatedTuning.centsByDegree[4]).toBe(-14);
    expect(updatedTuning.centsByDegree[3]).toBe(0);
    expect(setCustomTuningDegree(albokaTuning, 2, 180).centsByDegree[2]).toBe(100);
  });
});
