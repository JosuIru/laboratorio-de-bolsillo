import { deltaE2000 } from '@/processing/color/colorDifference';
import { createSeededRandom } from '@/processing/dsp/signalGenerator';

import { type HuntPaletteColorWithLab, huntTargetColors } from './huntPalette';

/** Segundos para encontrar cada color. */
export const roundDurationSeconds = 60;
export const defaultRoundCount = 5;
export const minimumPlayerCount = 1;
export const maximumPlayerCount = 4;

/** Con ΔE00 ≤ 2 (apenas perceptible) la captura se lleva todos los puntos de cercanía. */
export const perfectDeltaE = 2;
/** A partir de este ΔE00 ya es otro color: sin puntos. */
export const zeroPointsDeltaE = 35;
export const maximumClosenessPoints = 1000;
export const maximumTimeBonusPoints = 250;
/** Colores de una misma partida al menos así de distintos entre sí, para que haya variedad. */
export const minimumDistinctTargetDeltaE = 15;

function clampToUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 1 = color clavado, 0 = sin parecido. */
export function closenessFraction(deltaE: number): number {
  return clampToUnit((zeroPointsDeltaE - deltaE) / (zeroPointsDeltaE - perfectDeltaE));
}

export interface CaptureScore {
  closenessPoints: number;
  timeBonusPoints: number;
  totalPoints: number;
}

/**
 * Puntos por cercanía (curva que premia afinar: ΔE 10 ≈ 660, ΔE 20 ≈ 300) y bonus por el
 * tiempo que sobra, proporcional también a la cercanía para que disparar deprisa a cualquier
 * cosa no compense.
 */
export function scoreCapture(deltaE: number, remainingSeconds: number, durationSeconds = roundDurationSeconds): CaptureScore {
  const closeness = closenessFraction(deltaE);
  const closenessPoints = Math.round(maximumClosenessPoints * closeness ** 1.5);
  const remainingFraction = clampToUnit(remainingSeconds / durationSeconds);
  const timeBonusPoints = Math.round(maximumTimeBonusPoints * remainingFraction * closeness);
  return { closenessPoints, timeBonusPoints, totalPoints: closenessPoints + timeBonusPoints };
}

export type HeatLevel = 'spotOn' | 'burning' | 'hot' | 'warm' | 'cold' | 'freezing';

const heatLevelUpperDeltaE: readonly [HeatLevel, number][] = [
  ['spotOn', 3],
  ['burning', 6],
  ['hot', 12],
  ['warm', 20],
  ['cold', 30],
];

/** Nivel «frío/caliente» para la pista en vivo. */
export function heatLevelForDeltaE(deltaE: number): HeatLevel {
  for (const [heatLevel, upperDeltaE] of heatLevelUpperDeltaE) {
    if (deltaE <= upperDeltaE) return heatLevel;
  }
  return 'freezing';
}

/** Relleno de la barra «frío/caliente»: 1 = clavado, 0 = helado (ΔE ≥ 40). */
export function heatBarFraction(deltaE: number): number {
  return clampToUnit(1 - deltaE / 40);
}

/** Código de partida de 4 cifras: con el mismo código salen los mismos colores. */
export function generateGameCode(randomSource: () => number = Math.random): number {
  return 1000 + Math.floor(clampToUnit(randomSource()) * 8999.999);
}

export function parseGameCode(typedText: string): number | null {
  const trimmedText = typedText.trim();
  if (!/^\d{4}$/.test(trimmedText)) return null;
  const gameCode = Number(trimmedText);
  return gameCode >= 1000 ? gameCode : null;
}

/** Fisher-Yates con el generador de la semilla: misma semilla, mismo orden. */
export function shuffleWithSeed<TElement>(elements: readonly TElement[], seed: number): TElement[] {
  const nextRandom = createSeededRandom(seed);
  const shuffledElements = [...elements];
  for (let elementIndex = shuffledElements.length - 1; elementIndex > 0; elementIndex--) {
    const swapIndex = Math.floor(nextRandom() * (elementIndex + 1));
    [shuffledElements[elementIndex], shuffledElements[swapIndex]] = [shuffledElements[swapIndex]!, shuffledElements[elementIndex]!];
  }
  return shuffledElements;
}

/**
 * Elige `roundCount` colores objetivo sin repetir: baraja la paleta con la semilla y toma, en
 * ese orden, los que se distinguen bien de los ya elegidos. Si no hay bastantes, completa con
 * los restantes.
 */
export function selectTargetColors(
  seed: number,
  roundCount: number,
  candidateColors: readonly HuntPaletteColorWithLab[] = huntTargetColors,
): HuntPaletteColorWithLab[] {
  const shuffledColors = shuffleWithSeed(candidateColors, seed);
  const selectedColors: HuntPaletteColorWithLab[] = [];
  for (const candidateColor of shuffledColors) {
    if (selectedColors.length >= roundCount) break;
    const isDistinct = selectedColors.every(
      (selectedColor) => deltaE2000(selectedColor.lab, candidateColor.lab) >= minimumDistinctTargetDeltaE,
    );
    if (isDistinct) selectedColors.push(candidateColor);
  }
  for (const candidateColor of shuffledColors) {
    if (selectedColors.length >= roundCount) break;
    if (!selectedColors.includes(candidateColor)) selectedColors.push(candidateColor);
  }
  return selectedColors;
}

/** Resultado de un turno: lo que un jugador cazó para el color de la ronda. */
export interface HuntCapture {
  /** `null` si se acabó el tiempo sin ninguna lectura de la cámara. */
  capturedHexColor: string | null;
  deltaE: number | null;
  remainingSeconds: number;
  wasTimedOut: boolean;
  closenessPoints: number;
  timeBonusPoints: number;
  totalPoints: number;
}

export function buildCapture(
  capturedColor: { hexColor: string; deltaE: number } | null,
  remainingSeconds: number,
): HuntCapture {
  const wasTimedOut = remainingSeconds <= 0;
  const boundedRemainingSeconds = Math.max(0, remainingSeconds);
  if (!capturedColor) {
    return {
      capturedHexColor: null,
      deltaE: null,
      remainingSeconds: boundedRemainingSeconds,
      wasTimedOut,
      closenessPoints: 0,
      timeBonusPoints: 0,
      totalPoints: 0,
    };
  }
  return {
    capturedHexColor: capturedColor.hexColor,
    deltaE: capturedColor.deltaE,
    remainingSeconds: boundedRemainingSeconds,
    wasTimedOut,
    ...scoreCapture(capturedColor.deltaE, boundedRemainingSeconds),
  };
}

/** Partida por turnos: en cada ronda juegan todos los jugadores con el mismo color. */
export interface HuntGame {
  gameCode: number;
  playerCount: number;
  targetColorIds: string[];
  /** `capturesByRound[ronda][jugador]`, `null` = turno sin jugar. */
  capturesByRound: (HuntCapture | null)[][];
  currentRoundIndex: number;
  currentPlayerIndex: number;
  isFinished: boolean;
}

export function createHuntGame({
  gameCode,
  playerCount,
  roundCount = defaultRoundCount,
}: {
  gameCode: number;
  playerCount: number;
  roundCount?: number;
}): HuntGame {
  const boundedPlayerCount = Math.min(maximumPlayerCount, Math.max(minimumPlayerCount, Math.round(playerCount)));
  const targetColors = selectTargetColors(gameCode, roundCount);
  return {
    gameCode,
    playerCount: boundedPlayerCount,
    targetColorIds: targetColors.map((targetColor) => targetColor.id),
    capturesByRound: targetColors.map(() => new Array<HuntCapture | null>(boundedPlayerCount).fill(null)),
    currentRoundIndex: 0,
    currentPlayerIndex: 0,
    isFinished: targetColors.length === 0,
  };
}

export function currentTargetColorId(game: HuntGame): string | null {
  return game.isFinished ? null : (game.targetColorIds[game.currentRoundIndex] ?? null);
}

/** Guarda la captura del turno actual y pasa al siguiente jugador (o a la siguiente ronda). */
export function recordTurnCapture(game: HuntGame, capture: HuntCapture): HuntGame {
  if (game.isFinished) return game;
  const capturesByRound = game.capturesByRound.map((roundCaptures, roundIndex) =>
    roundIndex === game.currentRoundIndex
      ? roundCaptures.map((previousCapture, playerIndex) => (playerIndex === game.currentPlayerIndex ? capture : previousCapture))
      : roundCaptures,
  );
  const isLastPlayerOfRound = game.currentPlayerIndex >= game.playerCount - 1;
  const nextRoundIndex = isLastPlayerOfRound ? game.currentRoundIndex + 1 : game.currentRoundIndex;
  const isFinished = nextRoundIndex >= game.targetColorIds.length;
  return {
    ...game,
    capturesByRound,
    currentRoundIndex: isFinished ? game.currentRoundIndex : nextRoundIndex,
    currentPlayerIndex: isFinished ? game.currentPlayerIndex : isLastPlayerOfRound ? 0 : game.currentPlayerIndex + 1,
    isFinished,
  };
}

export interface ScoreboardEntry {
  playerIndex: number;
  totalPoints: number;
  /** 1 = primero; los empatados comparten puesto. */
  rank: number;
}

/** Marcador ordenado de mayor a menor puntuación. */
export function computeScoreboard(game: HuntGame): ScoreboardEntry[] {
  const playerTotals = Array.from({ length: game.playerCount }, (_, playerIndex) => ({
    playerIndex,
    totalPoints: game.capturesByRound.reduce(
      (pointsSum, roundCaptures) => pointsSum + (roundCaptures[playerIndex]?.totalPoints ?? 0),
      0,
    ),
  }));
  const sortedTotals = [...playerTotals].sort(
    (firstPlayer, secondPlayer) =>
      secondPlayer.totalPoints - firstPlayer.totalPoints || firstPlayer.playerIndex - secondPlayer.playerIndex,
  );
  return sortedTotals.map((playerTotal) => ({
    ...playerTotal,
    rank: 1 + sortedTotals.filter((otherPlayer) => otherPlayer.totalPoints > playerTotal.totalPoints).length,
  }));
}

export interface RoundBestCapture {
  roundIndex: number;
  targetColorId: string;
  /** Jugador de la mejor captura, o `null` si nadie cazó nada en la ronda. */
  playerIndex: number | null;
  capture: HuntCapture | null;
}

/** La captura más fiel (menor ΔE; a igualdad, más puntos) de cada ronda. */
export function bestCapturePerRound(game: HuntGame): RoundBestCapture[] {
  return game.targetColorIds.map((targetColorId, roundIndex) => {
    let bestPlayerIndex: number | null = null;
    let bestCapture: HuntCapture | null = null;
    const roundCaptures = game.capturesByRound[roundIndex] ?? [];
    for (let playerIndex = 0; playerIndex < roundCaptures.length; playerIndex++) {
      const capture = roundCaptures[playerIndex];
      if (!capture || capture.deltaE === null) continue;
      const isBetter =
        !bestCapture ||
        bestCapture.deltaE === null ||
        capture.deltaE < bestCapture.deltaE ||
        (capture.deltaE === bestCapture.deltaE && capture.totalPoints > bestCapture.totalPoints);
      if (isBetter) {
        bestPlayerIndex = playerIndex;
        bestCapture = capture;
      }
    }
    return { roundIndex, targetColorId, playerIndex: bestPlayerIndex, capture: bestCapture };
  });
}

/** Récord personal guardado en el móvil: la mejor puntuación total de una partida. */
export interface PersonalRecord {
  bestTotalPoints: number;
  /** Epoch en milisegundos. */
  achievedAt: number;
}

/** Descarta datos corruptos en lugar de fallar: vienen del almacenamiento local. */
export function parsePersonalRecord(storedText: string | null): PersonalRecord | null {
  if (!storedText) return null;
  try {
    const parsedValue = JSON.parse(storedText) as Partial<PersonalRecord> | null;
    if (
      typeof parsedValue?.bestTotalPoints !== 'number' ||
      !Number.isFinite(parsedValue.bestTotalPoints) ||
      typeof parsedValue.achievedAt !== 'number'
    ) {
      return null;
    }
    return { bestTotalPoints: parsedValue.bestTotalPoints, achievedAt: parsedValue.achievedAt };
  } catch {
    return null;
  }
}

export function isNewPersonalRecord(previousRecord: PersonalRecord | null, totalPoints: number): boolean {
  return totalPoints > 0 && (!previousRecord || totalPoints > previousRecord.bestTotalPoints);
}
