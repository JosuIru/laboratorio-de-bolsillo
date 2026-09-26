import { bytesToBase64 } from './detectionLog';
import type { SoundClass } from './modelManifest';
import {
  computeClassPenalties,
  gridCellKeyFor,
  occurrenceContextFor,
  OccurrenceFormatError,
  offSeasonPenalty,
  outOfAreaPenalty,
  parseOccurrenceData,
  rankClassesWithPenalties,
  speciesPlausibility,
} from './occurrenceFilter';

/** Bitset con los bits indicados a 1 (LSB primero), en base64. */
function encodedBitset(setBitIndices: number[], byteCount = 2): string {
  const bitsetBytes = new Uint8Array(byteCount);
  for (const bitIndex of setBitIndices) bitsetBytes[bitIndex >> 3]! |= 1 << (bitIndex & 7);
  return bytesToBase64(bitsetBytes);
}

const januaryToDecember = (activityValue: number, lowMonths: number[] = []) =>
  Array.from({ length: 12 }, (_, monthIndex) => (lowMonths.includes(monthIndex) ? 3 : activityValue));

// Bits: 0 mirlo, 1 petirrojo, 8 golondrina (en el segundo byte, para probar el orden de bytes).
const speciesLabels = ['Turdus merula', 'Erithacus rubecula', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'Hirundo rustica'];
const rawOccurrence = {
  formatVersion: 1,
  cellSizeDegrees: 2,
  latitudeMin: 34,
  longitudeMin: -26,
  rows: 19,
  columns: 36,
  speciesLabels,
  cells: {
    // Donostia (43,32 N, −1,98 E) → fila 4, columna 12.
    '4_12': encodedBitset([0, 8]),
  },
  monthlyActivity: {
    'Hirundo rustica': januaryToDecember(80, [0, 1, 10, 11]),
    'Turdus merula': januaryToDecember(100),
    'Mal escrita': [1, 2, 3],
  },
};

const donostiaLatitude = 43.32;
const donostiaLongitude = -1.98;
const januaryIndex = 0;
const juneIndex = 5;

describe('parseOccurrenceData', () => {
  it('lee la rejilla, los bitsets y la actividad mensual, e ignora las actividades mal escritas', () => {
    const occurrenceData = parseOccurrenceData(rawOccurrence);
    expect(occurrenceData.rowCount).toBe(19);
    expect(occurrenceData.bitIndexBySpeciesLabel.get('Hirundo rustica')).toBe(8);
    expect(Array.from(occurrenceData.cellBitsetByKey.get('4_12')!)).toEqual([0b00000001, 0b00000001]);
    expect(occurrenceData.monthlyActivityBySpeciesLabel.has('Mal escrita')).toBe(false);
  });

  it('rechaza formatos desconocidos y celdas mal formadas', () => {
    expect(() => parseOccurrenceData({ ...rawOccurrence, formatVersion: 2 })).toThrow(OccurrenceFormatError);
    expect(() => parseOccurrenceData({ ...rawOccurrence, cells: { '../x': 'AA==' } })).toThrow(OccurrenceFormatError);
    expect(() => parseOccurrenceData({ ...rawOccurrence, cells: { '1_1': '$$' } })).toThrow(OccurrenceFormatError);
    expect(() => parseOccurrenceData({ ...rawOccurrence, rows: 0 })).toThrow(OccurrenceFormatError);
    expect(() => parseOccurrenceData('hola')).toThrow(OccurrenceFormatError);
  });
});

describe('rejilla', () => {
  const occurrenceData = parseOccurrenceData(rawOccurrence);

  it('calcula la celda con floor y devuelve null fuera de la rejilla', () => {
    expect(gridCellKeyFor(occurrenceData, donostiaLatitude, donostiaLongitude)).toBe('4_12');
    expect(gridCellKeyFor(occurrenceData, 34, -26)).toBe('0_0');
    expect(gridCellKeyFor(occurrenceData, 33.99, 0)).toBeNull();
    expect(gridCellKeyFor(occurrenceData, 34 + 19 * 2, 0)).toBeNull();
    expect(gridCellKeyFor(occurrenceData, 40, -26 + 36 * 2)).toBeNull();
  });

  it('distingue fuera de la rejilla, celda sin datos y celda con datos', () => {
    expect(occurrenceContextFor(occurrenceData, 0, 0, juneIndex).status).toBe('outside-grid');
    expect(occurrenceContextFor(occurrenceData, 60, 20, juneIndex).status).toBe('no-cell-data');
    expect(occurrenceContextFor(occurrenceData, donostiaLatitude, donostiaLongitude, juneIndex).status).toBe('active');
  });
});

describe('plausibilidad', () => {
  const occurrenceData = parseOccurrenceData(rawOccurrence);
  const juneInDonostia = occurrenceContextFor(occurrenceData, donostiaLatitude, donostiaLongitude, juneIndex);
  const januaryInDonostia = occurrenceContextFor(occurrenceData, donostiaLatitude, donostiaLongitude, januaryIndex);

  it('marca «improbable aquí» si el bit está a 0 y «rara en esta época» si la actividad < 10', () => {
    expect(speciesPlausibility(occurrenceData, juneInDonostia, 'Turdus merula')).toEqual({
      isUnlikelyHere: false,
      isOffSeason: false,
    });
    expect(speciesPlausibility(occurrenceData, juneInDonostia, 'Erithacus rubecula').isUnlikelyHere).toBe(true);
    expect(speciesPlausibility(occurrenceData, juneInDonostia, 'Hirundo rustica').isOffSeason).toBe(false);
    expect(speciesPlausibility(occurrenceData, januaryInDonostia, 'Hirundo rustica')).toEqual({
      isUnlikelyHere: false,
      isOffSeason: true,
    });
  });

  it('no juzga especies que no están en el fichero ni lugares sin datos', () => {
    expect(speciesPlausibility(occurrenceData, juneInDonostia, 'Bubo bubo')).toEqual({ isUnlikelyHere: false, isOffSeason: false });
    const withoutData = occurrenceContextFor(occurrenceData, 60, 20, januaryIndex);
    expect(speciesPlausibility(occurrenceData, withoutData, 'Hirundo rustica')).toEqual({
      isUnlikelyHere: false,
      isOffSeason: false,
    });
  });
});

describe('penalizaciones y reordenación', () => {
  const occurrenceData = parseOccurrenceData(rawOccurrence);
  const classes: SoundClass[] = [
    { label: 'Turdus merula', kind: 'species', names: { es: null, eu: null, en: null } },
    { label: 'Erithacus rubecula', kind: 'species', names: { es: null, eu: null, en: null } },
    { label: 'Hirundo rustica', kind: 'species', names: { es: null, eu: null, en: null } },
    // Un sonido general con la misma etiqueta que una especie ausente no se penaliza.
    { label: 'b2', kind: 'sound', names: { es: null, eu: null, en: null } },
  ];

  it('penaliza solo especies y suma lugar y época', () => {
    const januaryInDonostia = occurrenceContextFor(occurrenceData, donostiaLatitude, donostiaLongitude, januaryIndex);
    const classPenalties = computeClassPenalties(occurrenceData, januaryInDonostia, classes);
    expect(Array.from(classPenalties.penaltyByClassIndex)).toEqual([0, outOfAreaPenalty, offSeasonPenalty, 0]);
    expect(classPenalties.penalizedClassCount).toBe(2);
  });

  it('reordena el top con las puntuaciones corregidas y conserva la del modelo', () => {
    const juneInDonostia = occurrenceContextFor(occurrenceData, donostiaLatitude, donostiaLongitude, juneIndex);
    const classPenalties = computeClassPenalties(occurrenceData, juneInDonostia, classes);
    const logits = [9, 11, 5, 8];
    expect(rankClassesWithPenalties(logits, null, 2).map((rankedClass) => rankedClass.classIndex)).toEqual([1, 0]);
    const adjustedTop = rankClassesWithPenalties(logits, classPenalties, 3);
    expect(adjustedTop.map((rankedClass) => rankedClass.classIndex)).toEqual([0, 3, 1]);
    expect(adjustedTop[2]).toEqual({
      classIndex: 1,
      score: 11 - outOfAreaPenalty,
      rawScore: 11,
      plausibility: { isUnlikelyHere: true, isOffSeason: false },
    });
    expect(adjustedTop[0]!.plausibility).toBeUndefined();
    expect(rankClassesWithPenalties(logits, classPenalties, 0)).toEqual([]);
  });
});
