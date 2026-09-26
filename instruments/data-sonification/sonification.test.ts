import {
  createValueSmoother,
  melodyNotes,
  midiNoteToFrequencyHz,
  normalizeSourceValue,
  normalizedValueToMidiNote,
  normalizedValueToThereminFrequencyHz,
  tiltDegreesFromGravity,
} from './sonification';

describe('normalizeSourceValue', () => {
  it('reparte el rango lineal y satura fuera de él', () => {
    expect(normalizeSourceValue('tilt', 45)).toBeCloseTo(0.5, 6);
    expect(normalizeSourceValue('tilt', -10)).toBe(0);
    expect(normalizeSourceValue('tilt', 120)).toBe(1);
  });

  it('usa escala logarítmica en vibración y luz', () => {
    // De 0,02 a 20 m/s² son 3 décadas: 0,2 m/s² queda a un tercio.
    expect(normalizeSourceValue('vibration', 0.2)).toBeCloseTo(1 / 3, 6);
    expect(normalizeSourceValue('light', 0)).toBe(0);
    expect(normalizeSourceValue('light', 1e6)).toBe(1);
  });

  it('un valor no finito cuenta como el mínimo', () => {
    expect(normalizeSourceValue('magnetic', Number.NaN)).toBe(0);
  });
});

describe('notas', () => {
  it('la pentatónica mayor de tres octavas tiene 16 notas de Do3 a Do6', () => {
    const availableNotes = melodyNotes('major-pentatonic');
    expect(availableNotes).toHaveLength(16);
    expect(availableNotes[0]).toBe(48);
    expect(availableNotes[availableNotes.length - 1]).toBe(84);
  });

  it('los extremos del valor dan la nota más grave y la más aguda', () => {
    expect(normalizedValueToMidiNote(0, 'major')).toBe(48);
    expect(normalizedValueToMidiNote(1, 'major')).toBe(84);
    expect(melodyNotes('major')).toContain(normalizedValueToMidiNote(0.5, 'major'));
  });

  it('La4 = 440 Hz y el theremin cubre tres octavas', () => {
    expect(midiNoteToFrequencyHz(69)).toBeCloseTo(440, 6);
    expect(normalizedValueToThereminFrequencyHz(1) / normalizedValueToThereminFrequencyHz(0)).toBeCloseTo(8, 6);
  });
});

describe('tiltDegreesFromGravity', () => {
  it('0° tumbado, 90° de pie, 45° a medias', () => {
    expect(tiltDegreesFromGravity(0, 0, 9.81)).toBeCloseTo(0, 6);
    expect(tiltDegreesFromGravity(0, 9.81, 0)).toBeCloseTo(90, 6);
    expect(tiltDegreesFromGravity(0, 1, 1)).toBeCloseTo(45, 6);
    expect(tiltDegreesFromGravity(0, 0, -9.81)).toBeCloseTo(0, 6);
  });
});

describe('createValueSmoother', () => {
  it('se acerca al nuevo valor según la constante de tiempo', () => {
    const valueSmoother = createValueSmoother(0.1);
    expect(valueSmoother.push(0, 0)).toBe(0);
    // Tras una constante de tiempo llega al 63 %.
    expect(valueSmoother.push(1, 0.1)).toBeCloseTo(1 - Math.exp(-1), 6);
    valueSmoother.reset();
    expect(valueSmoother.push(5, 3)).toBe(5);
  });
});
