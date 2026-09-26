import {
  addWindowToSession,
  averageAnalysisMilliseconds,
  createListeningSessionSummary,
  formatSpeciesSummary,
} from './listeningSession';

describe('resumen de la sesión de escucha', () => {
  it('cuenta ventanas, detecciones, voz humana y especies', () => {
    let summary = createListeningSessionSummary(1000);
    summary = addWindowToSession(summary, { kind: 'logged', speciesLabel: 'Erithacus rubecula', speciesScore: 8 }, 300);
    summary = addWindowToSession(summary, { kind: 'logged', speciesLabel: 'Turdus merula', speciesScore: 9 }, 500);
    summary = addWindowToSession(summary, { kind: 'logged', speciesLabel: 'Turdus merula', speciesScore: 12 }, 400);
    summary = addWindowToSession(summary, { kind: 'human-voice' }, 400);
    summary = addWindowToSession(summary, { kind: 'below-threshold' }, 400);
    expect(summary.analyzedWindowCount).toBe(5);
    expect(summary.loggedDetectionCount).toBe(3);
    expect(summary.humanVoiceWindowCount).toBe(1);
    expect(summary.speciesTallies).toEqual([
      { label: 'Turdus merula', detectionCount: 2, bestScore: 12 },
      { label: 'Erithacus rubecula', detectionCount: 1, bestScore: 8 },
    ]);
    expect(averageAnalysisMilliseconds(summary)).toBe(400);
  });

  it('no modifica el resumen anterior', () => {
    const emptySummary = createListeningSessionSummary(0);
    addWindowToSession(emptySummary, { kind: 'logged', speciesLabel: 'Bufo bufo', speciesScore: 8 }, 10);
    expect(emptySummary.speciesTallies).toEqual([]);
    expect(averageAnalysisMilliseconds(emptySummary)).toBe(0);
  });

  it('escribe la lista de especies con el nombre común si lo hay', () => {
    const speciesText = formatSpeciesSummary(
      [
        { label: 'Turdus merula', detectionCount: 2, bestScore: 12 },
        { label: 'Zoothera aurea', detectionCount: 1, bestScore: 8 },
      ],
      (label) => (label === 'Turdus merula' ? 'Mirlo común' : label),
    );
    expect(speciesText).toBe('Mirlo común (Turdus merula) ×2; Zoothera aurea ×1');
  });
});
