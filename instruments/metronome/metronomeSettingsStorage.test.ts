import { defaultMetronomeSettings, parseStoredMetronomeSettings } from './metronomeSettingsStorage';
import { maximumBeatsPerMinute, minimumBeatsPerMinute } from './metronomeTiming';

describe('parseStoredMetronomeSettings', () => {
  it('lee el tempo y el compás guardados', () => {
    expect(parseStoredMetronomeSettings(JSON.stringify({ beatsPerMinute: 72, beatsPerBar: 3 }))).toEqual({
      beatsPerMinute: 72,
      beatsPerBar: 3,
    });
  });

  it('ajusta el tempo al rango permitido y a un entero', () => {
    expect(parseStoredMetronomeSettings(JSON.stringify({ beatsPerMinute: 999, beatsPerBar: 4 })).beatsPerMinute).toBe(
      maximumBeatsPerMinute,
    );
    expect(parseStoredMetronomeSettings(JSON.stringify({ beatsPerMinute: 1, beatsPerBar: 4 })).beatsPerMinute).toBe(
      minimumBeatsPerMinute,
    );
    expect(parseStoredMetronomeSettings(JSON.stringify({ beatsPerMinute: 88.6, beatsPerBar: 4 })).beatsPerMinute).toBe(89);
  });

  it('usa los valores por defecto para lo que falte o no valga', () => {
    expect(parseStoredMetronomeSettings(JSON.stringify({ beatsPerMinute: 'rápido', beatsPerBar: 5 }))).toEqual(
      defaultMetronomeSettings,
    );
    expect(parseStoredMetronomeSettings(JSON.stringify({ beatsPerBar: 6 }))).toEqual({
      beatsPerMinute: defaultMetronomeSettings.beatsPerMinute,
      beatsPerBar: 6,
    });
  });

  it('devuelve los valores por defecto con JSON roto o vacío', () => {
    expect(parseStoredMetronomeSettings('{roto')).toEqual(defaultMetronomeSettings);
    expect(parseStoredMetronomeSettings(null)).toEqual(defaultMetronomeSettings);
    expect(parseStoredMetronomeSettings('null')).toEqual(defaultMetronomeSettings);
  });
});
