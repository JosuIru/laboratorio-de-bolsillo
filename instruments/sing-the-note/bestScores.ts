import Storage from 'expo-sqlite/kv-store';

import type { SingDifficulty } from './singGame';

export type BestScores = Partial<Record<SingDifficulty, number>>;

const bestScoresStorageKey = 'sing-the-note.bestScores';
const difficulties: readonly SingDifficulty[] = ['easy', 'medium', 'hard'];

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredBestScores(storedText: string | null): BestScores {
  if (!storedText) return {};
  try {
    const parsedValue = JSON.parse(storedText) as Record<string, unknown>;
    return Object.fromEntries(
      difficulties.flatMap((difficulty) => {
        const storedScore = parsedValue[difficulty];
        return typeof storedScore === 'number' && Number.isFinite(storedScore) && storedScore >= 0
          ? [[difficulty, storedScore]]
          : [];
      }),
    );
  } catch {
    return {};
  }
}

export function loadBestScores(): BestScores {
  try {
    return parseStoredBestScores(Storage.getItemSync(bestScoresStorageKey));
  } catch {
    return {};
  }
}

/** Guarda la puntuación si mejora el récord de esa dificultad; devuelve los récords resultantes. */
export function recordScore(bestScores: BestScores, difficulty: SingDifficulty, totalPoints: number): BestScores {
  if ((bestScores[difficulty] ?? -1) >= totalPoints) return bestScores;
  const updatedScores = { ...bestScores, [difficulty]: totalPoints };
  try {
    Storage.setItemSync(bestScoresStorageKey, JSON.stringify(updatedScores));
  } catch {
    // Sin almacenamiento, el récord vale solo mientras la pantalla esté abierta.
  }
  return updatedScores;
}
