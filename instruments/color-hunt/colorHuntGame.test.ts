import { deltaE2000 } from '@/processing/color/colorDifference';
import { hexToRgb8, type LinearRgb, srgbToLab, srgbToLinear } from '@/processing/color/colorSpaces';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';

import { evaluateColorimeterFrame } from '@instruments/colorimeter/colorimeterEngine';
import { createCardFromPreset } from '@instruments/colorimeter/referenceCards';

import {
  bestCapturePerRound,
  buildCapture,
  computeScoreboard,
  createHuntGame,
  currentTargetColorId,
  generateGameCode,
  heatBarFraction,
  heatLevelForDeltaE,
  type HuntGame,
  isNewPersonalRecord,
  maximumClosenessPoints,
  maximumTimeBonusPoints,
  minimumDistinctTargetDeltaE,
  parseGameCode,
  parsePersonalRecord,
  recordTurnCapture,
  roundDurationSeconds,
  scoreCapture,
  selectTargetColors,
  shuffleWithSeed,
} from './colorHuntGame';
import { findPaletteColor, huntPalette, huntTargetColors, nearestPaletteColor } from './huntPalette';
import { cardWithoutPatches, isUsableWhiteReference, pickWhiteReferencePatch, whiteBalanceCard } from './whiteBalance';

function playWholeGame(game: HuntGame, deltaEForTurn: (roundIndex: number, playerIndex: number) => number): HuntGame {
  let playedGame = game;
  while (!playedGame.isFinished) {
    const deltaE = deltaEForTurn(playedGame.currentRoundIndex, playedGame.currentPlayerIndex);
    playedGame = recordTurnCapture(playedGame, buildCapture({ hexColor: '#808080', deltaE }, 30));
  }
  return playedGame;
}

describe('puntuación', () => {
  it('da todos los puntos a un color clavado con todo el tiempo', () => {
    expect(scoreCapture(1, roundDurationSeconds)).toEqual({
      closenessPoints: maximumClosenessPoints,
      timeBonusPoints: maximumTimeBonusPoints,
      totalPoints: maximumClosenessPoints + maximumTimeBonusPoints,
    });
  });

  it('baja con la distancia de color y llega a cero con otro color', () => {
    const closeScore = scoreCapture(8, 0).totalPoints;
    const midScore = scoreCapture(18, 0).totalPoints;
    expect(closeScore).toBeGreaterThan(midScore);
    expect(midScore).toBeGreaterThan(0);
    expect(scoreCapture(35, 60).totalPoints).toBe(0);
    expect(scoreCapture(80, 60).totalPoints).toBe(0);
  });

  it('el bonus de tiempo crece con el tiempo restante y no premia disparar a lo loco', () => {
    expect(scoreCapture(10, 45).timeBonusPoints).toBeGreaterThan(scoreCapture(10, 15).timeBonusPoints);
    expect(scoreCapture(10, 0).timeBonusPoints).toBe(0);
    expect(scoreCapture(34, 60).timeBonusPoints).toBeLessThan(scoreCapture(5, 60).timeBonusPoints / 10);
  });

  it('un turno agotado sin lectura vale cero', () => {
    const emptyCapture = buildCapture(null, 0);
    expect(emptyCapture).toMatchObject({ capturedHexColor: null, deltaE: null, wasTimedOut: true, totalPoints: 0 });
    expect(buildCapture({ hexColor: '#112233', deltaE: 4 }, -2)).toMatchObject({ remainingSeconds: 0, wasTimedOut: true });
  });

  it('la pista frío/caliente es monótona', () => {
    expect(heatLevelForDeltaE(1)).toBe('spotOn');
    expect(heatLevelForDeltaE(5)).toBe('burning');
    expect(heatLevelForDeltaE(10)).toBe('hot');
    expect(heatLevelForDeltaE(15)).toBe('warm');
    expect(heatLevelForDeltaE(25)).toBe('cold');
    expect(heatLevelForDeltaE(50)).toBe('freezing');
    expect(heatBarFraction(0)).toBe(1);
    expect(heatBarFraction(20)).toBeCloseTo(0.5);
    expect(heatBarFraction(60)).toBe(0);
  });
});

describe('códigos de partida y secuencia con semilla', () => {
  it('genera y valida códigos de 4 cifras', () => {
    expect(generateGameCode(() => 0)).toBe(1000);
    expect(generateGameCode(() => 0.999999)).toBe(9999);
    expect(parseGameCode(' 4821 ')).toBe(4821);
    expect(parseGameCode('0123')).toBeNull();
    expect(parseGameCode('12a4')).toBeNull();
    expect(parseGameCode('12345')).toBeNull();
  });

  it('la misma semilla da siempre el mismo orden, y otra semilla otro', () => {
    const numbers = Array.from({ length: 20 }, (_, index) => index);
    expect(shuffleWithSeed(numbers, 4821)).toEqual(shuffleWithSeed(numbers, 4821));
    expect(shuffleWithSeed(numbers, 4821)).not.toEqual(shuffleWithSeed(numbers, 4822));
    expect([...shuffleWithSeed(numbers, 7)].sort((first, second) => first - second)).toEqual(numbers);
  });

  it('dos jugadores con el mismo código tienen los mismos colores', () => {
    const firstDeviceGame = createHuntGame({ gameCode: 3141, playerCount: 1 });
    const secondDeviceGame = createHuntGame({ gameCode: 3141, playerCount: 3 });
    expect(firstDeviceGame.targetColorIds).toEqual(secondDeviceGame.targetColorIds);
  });
});

describe('selección de la paleta', () => {
  it('elige colores objetivo distintos y bien diferenciados', () => {
    for (const seed of [1000, 2024, 5555, 9999]) {
      const selectedColors = selectTargetColors(seed, 5);
      expect(selectedColors).toHaveLength(5);
      expect(new Set(selectedColors.map((color) => color.id)).size).toBe(5);
      expect(selectedColors.every((color) => color.isTarget)).toBe(true);
      for (const firstColor of selectedColors) {
        for (const secondColor of selectedColors) {
          if (firstColor === secondColor) continue;
          expect(deltaE2000(firstColor.lab, secondColor.lab)).toBeGreaterThanOrEqual(minimumDistinctTargetDeltaE);
        }
      }
    }
  });

  it('completa sin repetir aunque no haya bastantes colores distintos', () => {
    const nearlyEqualColors = huntTargetColors.slice(0, 3).map((color) => ({ ...color, lab: huntTargetColors[0]!.lab }));
    const selectedColors = selectTargetColors(42, 3, nearlyEqualColors);
    expect(new Set(selectedColors.map((color) => color.id)).size).toBe(3);
  });

  it('la paleta objetivo evita colores imposibles de captar', () => {
    for (const targetColor of huntTargetColors) {
      const chroma = Math.hypot(targetColor.lab.greenRed, targetColor.lab.blueYellow);
      expect(chroma).toBeLessThan(75);
      expect(targetColor.lab.lightness).toBeGreaterThan(15);
      expect(targetColor.lab.lightness).toBeLessThan(90);
    }
  });

  it('nombra un color leído con el de la paleta más parecido', () => {
    const limeLikeSample = srgbToLab(hexToRgb8('#90C040')!);
    expect(nearestPaletteColor(limeLikeSample).paletteColor.id).toBe('limeGreen');
    expect(nearestPaletteColor(srgbToLab({ red: 250, green: 250, blue: 250 })).paletteColor.id).toBe('white');
    expect(findPaletteColor('navyBlue')?.hexColor).toBe('#1F2A4D');
    expect(new Set(huntPalette.map((color) => color.id)).size).toBe(huntPalette.length);
  });
});

describe('partida por turnos y marcador', () => {
  it('reparte los turnos: todos los jugadores juegan cada ronda antes de pasar a la siguiente', () => {
    let game = createHuntGame({ gameCode: 1234, playerCount: 2, roundCount: 2 });
    const visitedTurns: string[] = [];
    while (!game.isFinished) {
      visitedTurns.push(`${game.currentRoundIndex}:${game.currentPlayerIndex}:${currentTargetColorId(game)}`);
      game = recordTurnCapture(game, buildCapture({ hexColor: '#808080', deltaE: 10 }, 20));
    }
    const [firstColorId, secondColorId] = game.targetColorIds;
    expect(visitedTurns).toEqual([`0:0:${firstColorId}`, `0:1:${firstColorId}`, `1:0:${secondColorId}`, `1:1:${secondColorId}`]);
    expect(currentTargetColorId(game)).toBeNull();
    expect(recordTurnCapture(game, buildCapture(null, 0))).toBe(game);
  });

  it('limita el número de jugadores entre 1 y 4', () => {
    expect(createHuntGame({ gameCode: 1000, playerCount: 9 }).playerCount).toBe(4);
    expect(createHuntGame({ gameCode: 1000, playerCount: 0 }).playerCount).toBe(1);
  });

  it('suma, ordena y comparte puesto en los empates', () => {
    const playedGame = playWholeGame(createHuntGame({ gameCode: 2222, playerCount: 3, roundCount: 3 }), (_, playerIndex) =>
      playerIndex === 1 ? 4 : 12,
    );
    const scoreboard = computeScoreboard(playedGame);
    expect(scoreboard.map((entry) => entry.playerIndex)).toEqual([1, 0, 2]);
    expect(scoreboard.map((entry) => entry.rank)).toEqual([1, 2, 2]);
    expect(scoreboard[0]!.totalPoints).toBe(3 * scoreCapture(4, 30).totalPoints);
  });

  it('elige la captura más fiel de cada ronda', () => {
    const playedGame = playWholeGame(createHuntGame({ gameCode: 7777, playerCount: 2, roundCount: 2 }), (roundIndex, playerIndex) =>
      roundIndex === 0 ? (playerIndex === 0 ? 3 : 9) : playerIndex === 0 ? 20 : 6,
    );
    const bestCaptures = bestCapturePerRound(playedGame);
    expect(bestCaptures.map((roundBest) => roundBest.playerIndex)).toEqual([0, 1]);
    expect(bestCaptures.map((roundBest) => roundBest.capture?.deltaE)).toEqual([3, 6]);
  });

  it('una ronda sin ninguna lectura no tiene mejor captura', () => {
    let game = createHuntGame({ gameCode: 1111, playerCount: 1, roundCount: 1 });
    game = recordTurnCapture(game, buildCapture(null, 0));
    expect(bestCapturePerRound(game)[0]).toMatchObject({ playerIndex: null, capture: null });
  });
});

describe('récord personal', () => {
  it('lee el récord guardado y descarta datos corruptos', () => {
    expect(parsePersonalRecord('{"bestTotalPoints":4200,"achievedAt":1700000000000}')).toEqual({
      bestTotalPoints: 4200,
      achievedAt: 1700000000000,
    });
    expect(parsePersonalRecord(null)).toBeNull();
    expect(parsePersonalRecord('no es json')).toBeNull();
    expect(parsePersonalRecord('{"bestTotalPoints":"mucho"}')).toBeNull();
  });

  it('solo cuenta como récord si supera al anterior', () => {
    expect(isNewPersonalRecord(null, 100)).toBe(true);
    expect(isNewPersonalRecord(null, 0)).toBe(false);
    expect(isNewPersonalRecord({ bestTotalPoints: 3000, achievedAt: 0 }, 3000)).toBe(false);
    expect(isNewPersonalRecord({ bestTotalPoints: 3000, achievedAt: 0 }, 3001)).toBe(true);
  });
});

describe('balance de blancos', () => {
  it('usa el parche más claro de la tarjeta del colorímetro, o el folio si no hay tarjeta', () => {
    expect(pickWhiteReferencePatch(createCardFromPreset('colorchecker-six')).id).toBe('white');
    expect(pickWhiteReferencePatch(null).hexColor).toBe('#F2F2F2');
    expect(pickWhiteReferencePatch({ presetId: 'custom', patches: [] }).hexColor).toBe('#F2F2F2');
  });

  it('corrige un tinte de la cámara con la referencia blanca', () => {
    const whitePatch = pickWhiteReferencePatch(null);
    const cameraTint = { red: 1.25, green: 1, blue: 0.7 };
    const tintedRegion = (trueColor: LinearRgb): RegionColorStatistics => ({
      meanLinear: { red: trueColor.red * cameraTint.red, green: trueColor.green * cameraTint.green, blue: trueColor.blue * cameraTint.blue },
      standardDeviationLinear: { red: 0, green: 0, blue: 0 },
      sampledPixelCount: 100,
    });
    const whiteRegion = tintedRegion(srgbToLinear(hexToRgb8(whitePatch.hexColor)!));
    expect(isUsableWhiteReference(whiteRegion)).toBe(true);
    const target = findPaletteColor('skyBlue')!;
    const targetRegion = tintedRegion(srgbToLinear(hexToRgb8(target.hexColor)!));
    const uncorrected = evaluateColorimeterFrame(targetRegion, [], cardWithoutPatches, null);
    const corrected = evaluateColorimeterFrame(targetRegion, [whiteRegion], whiteBalanceCard(whitePatch), null);
    expect(deltaE2000(corrected.sampleLab, target.lab)).toBeLessThan(1);
    expect(deltaE2000(uncorrected.sampleLab, target.lab)).toBeGreaterThan(5);
    expect(isUsableWhiteReference(tintedRegion({ red: 0.02, green: 0.02, blue: 0.02 }))).toBe(false);
  });
});
