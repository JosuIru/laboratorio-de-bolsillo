import type { SoundClass } from './modelManifest';
import {
  aggregateSessionSpecies,
  appendSessionDetections,
  buildSessionTimeline,
  maximumSessionDetections,
  type SessionDetection,
  sessionDetectionsForWindow,
} from './sessionTimeline';

const sessionStart = Date.UTC(2026, 8, 26, 6, 0, 0);
const minute = 60_000;

function detectionAt(label: string, minutesFromStart: number, score: number, isCustomClass = false): SessionDetection {
  return { label, isCustomClass, timestamp: sessionStart + minutesFromStart * minute, score };
}

const detections: SessionDetection[] = [
  detectionAt('Erithacus rubecula', 1, 8),
  detectionAt('Turdus merula', 2, 9),
  detectionAt('Turdus merula', 3, 12),
  detectionAt('Turdus merula', 9, 7.5),
  detectionAt('Erithacus rubecula', 5, 10),
  detectionAt('Mi perro', 4, 0.9, true),
  // Una clase propia con el mismo nombre que una especie va en otra fila.
  detectionAt('Turdus merula', 6, 0.88, true),
];

describe('aggregateSessionSpecies', () => {
  it('cuenta detecciones, primera y última hora y mejor puntuación por especie', () => {
    const entries = aggregateSessionSpecies(detections, 'by-count');
    expect(entries[0]).toEqual({
      key: 'species:Turdus merula',
      label: 'Turdus merula',
      isCustomClass: false,
      detectionCount: 3,
      firstTimestamp: sessionStart + 2 * minute,
      lastTimestamp: sessionStart + 9 * minute,
      bestScore: 12,
    });
    expect(entries.map((entry) => entry.key)).toEqual([
      'species:Turdus merula',
      'species:Erithacus rubecula',
      'custom:Mi perro',
      'custom:Turdus merula',
    ]);
  });

  it('por hora: en el orden en que se oyó cada especie por primera vez', () => {
    expect(aggregateSessionSpecies(detections, 'by-time').map((entry) => entry.label)).toEqual([
      'Erithacus rubecula',
      'Turdus merula',
      'Mi perro',
      'Turdus merula',
    ]);
    expect(aggregateSessionSpecies([], 'by-time')).toEqual([]);
  });
});

describe('buildSessionTimeline', () => {
  it('una fila por especie frecuente, con marcas en su tramo', () => {
    const timeline = buildSessionTimeline(detections, sessionStart, sessionStart + 10 * minute, 2, 10);
    expect(timeline.rows.map((row) => row.key)).toEqual(['species:Turdus merula', 'species:Erithacus rubecula']);
    expect(timeline.hiddenSpeciesCount).toBe(2);
    expect(timeline.rows[0]!.marks).toEqual([
      { positionFraction: 0.25, detectionCount: 1 },
      { positionFraction: 0.35, detectionCount: 1 },
      { positionFraction: 0.95, detectionCount: 1 },
    ]);
  });

  it('agrupa en el mismo tramo y recorta lo que cae fuera', () => {
    const closeDetections = [detectionAt('A', 0.1, 8), detectionAt('A', 0.2, 8), detectionAt('A', 30, 8), detectionAt('A', -5, 8)];
    const timeline = buildSessionTimeline(closeDetections, sessionStart, sessionStart + 10 * minute, 5, 10);
    expect(timeline.rows[0]!.marks).toEqual([
      { positionFraction: 0.05, detectionCount: 3 },
      { positionFraction: 0.95, detectionCount: 1 },
    ]);
  });

  it('no divide por cero con una sesión instantánea', () => {
    const timeline = buildSessionTimeline([detectionAt('A', 0, 8)], sessionStart, sessionStart, 5, 10);
    expect(timeline.rows[0]!.marks).toHaveLength(1);
  });
});

describe('detecciones de una ventana', () => {
  const classes: SoundClass[] = [
    { label: 'Turdus merula', kind: 'species', names: { es: null, eu: null, en: null } },
    { label: 'Erithacus rubecula', kind: 'species', names: { es: null, eu: null, en: null } },
    { label: 'Dog', kind: 'sound', names: { es: null, eu: null, en: null } },
  ];

  it('toma las especies que llegan a «posible» y las clases propias reconocidas', () => {
    const topClasses = [
      { classIndex: 2, score: 14 },
      { classIndex: 0, score: 11 },
      { classIndex: 1, score: 6 },
    ];
    expect(sessionDetectionsForWindow(topClasses, classes, [{ name: 'Mi perro', similarity: 0.91 }], sessionStart, false)).toEqual([
      { label: 'Turdus merula', isCustomClass: false, timestamp: sessionStart, score: 11 },
      { label: 'Mi perro', isCustomClass: true, timestamp: sessionStart, score: 0.91 },
    ]);
    expect(sessionDetectionsForWindow(topClasses, classes, [], sessionStart, true)).toEqual([]);
  });

  it('no pasa del tope de detecciones en memoria', () => {
    const manyDetections = Array.from({ length: maximumSessionDetections }, (_, detectionIndex) => detectionAt('A', detectionIndex, 8));
    const appended = appendSessionDetections(manyDetections, [detectionAt('B', 0, 8)]);
    expect(appended).toHaveLength(maximumSessionDetections);
    expect(appended[appended.length - 1]!.label).toBe('B');
    expect(appendSessionDetections(manyDetections, [])).toBe(manyDetections);
  });
});
