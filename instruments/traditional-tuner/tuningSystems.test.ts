import {
  builtInTuningSystems,
  clampReferenceA4Hz,
  createPitchStabilizer,
  findTuningTarget,
  measureDegreeDeviation,
} from './tuningSystems';

const equalContext = { referenceA4Hz: 440, tonicNoteIndex: 0, centsByDegree: builtInTuningSystems.equal } as const;

describe('sistemas de afinación', () => {
  it('la tónica no se mueve en ninguno', () => {
    for (const centsByDegree of Object.values(builtInTuningSystems)) {
      expect(centsByDegree[0]).toBeCloseTo(0, 6);
      expect(centsByDegree).toHaveLength(12);
    }
  });

  it('justa: tercera mayor 13,7 centésimas baja y quinta 2 alta', () => {
    expect(builtInTuningSystems.just[4]).toBeCloseTo(-13.69, 2);
    expect(builtInTuningSystems.just[7]).toBeCloseTo(1.96, 2);
  });

  it('pitagórica: tercera mayor 7,8 centésimas alta', () => {
    expect(builtInTuningSystems.pythagorean[4]).toBeCloseTo(7.82, 2);
  });

  it('mesotónica de 1/4 de coma: tercera mayor pura y quinta 3,4 centésimas baja', () => {
    expect(builtInTuningSystems['quarter-comma-meantone'][4]).toBeCloseTo(-13.69, 2);
    expect(builtInTuningSystems['quarter-comma-meantone'][7]).toBeCloseTo(-3.42, 2);
  });
});

describe('findTuningTarget', () => {
  it('La4 a 440 Hz está afinado en temperamento igual', () => {
    const tuningTarget = findTuningTarget(440, equalContext)!;
    expect(tuningTarget.noteIndex).toBe(9);
    expect(tuningTarget.octave).toBe(4);
    expect(tuningTarget.centsOffset).toBeCloseTo(0, 6);
  });

  it('respeta el La de referencia', () => {
    const tuningTarget = findTuningTarget(442, { ...equalContext, referenceA4Hz: 442 })!;
    expect(tuningTarget.centsOffset).toBeCloseTo(0, 6);
    expect(findTuningTarget(442, equalContext)!.centsOffset).toBeCloseTo(7.85, 2);
  });

  it('en justa con tónica Do, un Mi temperado sale 13,7 centésimas alto', () => {
    const temperedE4Hz = 440 * 2 ** (-5 / 12);
    const tuningTarget = findTuningTarget(temperedE4Hz, { ...equalContext, centsByDegree: builtInTuningSystems.just })!;
    expect(tuningTarget.noteIndex).toBe(4);
    expect(tuningTarget.degree).toBe(4);
    expect(tuningTarget.centsOffset).toBeCloseTo(13.69, 2);
  });

  it('el grado depende de la tónica', () => {
    // Con tónica La (9), el Do♯ es la tercera mayor (grado 4).
    const cSharp5Hz = 440 * 2 ** (4 / 12);
    expect(findTuningTarget(cSharp5Hz, { ...equalContext, tonicNoteIndex: 9 })!.degree).toBe(4);
  });

  it('busca en la nota vecina si una tabla propia desvía más de medio semitono', () => {
    const skewedTable = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -70];
    // Tónica Do con el Si 70 ct bajo: un tono 30 ct por encima de La♯4 es un Si afinado.
    const measuredHz = 440 * 2 ** (1.3 / 12);
    const tuningTarget = findTuningTarget(measuredHz, { ...equalContext, centsByDegree: skewedTable })!;
    expect(tuningTarget.noteIndex).toBe(11);
    expect(tuningTarget.centsOffset).toBeCloseTo(0, 4);
  });

  it('rechaza frecuencias no válidas', () => {
    expect(findTuningTarget(0, equalContext)).toBeNull();
    expect(findTuningTarget(Number.NaN, equalContext)).toBeNull();
  });
});

describe('measureDegreeDeviation', () => {
  it('da el grado y la desviación respecto al temperamento igual', () => {
    const slightlySharpG4Hz = 440 * 2 ** ((-2 + 0.12) / 12);
    const degreeDeviation = measureDegreeDeviation(slightlySharpG4Hz, 440, 0)!;
    expect(degreeDeviation.degree).toBe(7);
    expect(degreeDeviation.centsFromEqual).toBeCloseTo(12, 4);
  });
});

describe('createPitchStabilizer', () => {
  it('quita un salto suelto con la mediana', () => {
    const pitchStabilizer = createPitchStabilizer(5);
    pitchStabilizer.push(440);
    pitchStabilizer.push(441);
    pitchStabilizer.push(439);
    expect(pitchStabilizer.push(452)).toBeCloseTo(440.5, 0);
  });

  it('empieza de cero al cambiar de nota y se vacía en silencio', () => {
    const pitchStabilizer = createPitchStabilizer(5);
    pitchStabilizer.push(440);
    pitchStabilizer.push(440);
    expect(pitchStabilizer.push(330)).toBe(330);
    expect(pitchStabilizer.push(null)).toBeNull();
  });
});

describe('clampReferenceA4Hz', () => {
  it('limita entre 400 y 480 Hz', () => {
    expect(clampReferenceA4Hz(390)).toBe(400);
    expect(clampReferenceA4Hz(442)).toBe(442);
    expect(clampReferenceA4Hz(500)).toBe(480);
  });
});
