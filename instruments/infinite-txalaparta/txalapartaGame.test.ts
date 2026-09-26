import {
  addJudgement,
  beatsPerMinuteForBar,
  cleanHitsToForgiveStray,
  detectStrayStroke,
  eighthSeconds,
  emptyTally,
  generateBar,
  judgePlayerSlot,
  levelForBar,
  maximumBeatsPerMinute,
  slotsPerBar,
  startBeatsPerMinute,
  strayJudgement,
  toleranceForTempo,
} from './txalapartaGame';

describe('compases', () => {
  it('los dos primeros alternan móvil y jugador', () => {
    expect(generateBar(0, 1)).toEqual(['machine', 'player', 'machine', 'player', 'machine', 'player', 'machine', 'player']);
    expect(generateBar(1, 99)).toEqual(generateBar(0, 1));
  });

  it('todos tienen 8 corcheas, algo que tocar para el jugador y la misma semilla da lo mismo', () => {
    for (let barIndex = 0; barIndex < 60; barIndex++) {
      const barSlots = generateBar(barIndex, 5);
      expect(barSlots).toHaveLength(slotsPerBar);
      expect(barSlots).toContain('player');
      expect(barSlots[0]).toBe('machine');
    }
    expect(generateBar(20, 3)).toEqual(generateBar(20, 3));
  });

  it('el tempo sube cada 4 compases hasta un máximo y el nivel cada 8', () => {
    expect(beatsPerMinuteForBar(0)).toBe(startBeatsPerMinute);
    expect(beatsPerMinuteForBar(4)).toBe(startBeatsPerMinute + 4);
    expect(beatsPerMinuteForBar(10_000)).toBe(maximumBeatsPerMinute);
    expect([0, 7, 8, 16, 24, 400].map(levelForBar)).toEqual([0, 0, 1, 2, 3, 3]);
  });

  it('una corchea a 120 dura 0,25 s y la tolerancia queda entre 60 y 110 ms', () => {
    expect(eighthSeconds(120)).toBeCloseTo(0.25, 9);
    expect(toleranceForTempo(76)).toBeCloseTo(0.11, 9);
    expect(toleranceForTempo(150)).toBeCloseTo(0.06, 9);
  });
});

describe('judgePlayerSlot', () => {
  it('acierta con una palmada cerca de su sitio y da el error', () => {
    const slotJudgement = judgePlayerSlot(10, [9.2, 10.03, 11], [], 0.08);
    expect(slotJudgement.isHit).toBe(true);
    expect(slotJudgement.errorSeconds).toBeCloseTo(0.03, 9);
  });

  it('un golpe del propio móvil no cuenta como palmada', () => {
    expect(judgePlayerSlot(10, [10.02], [10.01], 0.08).isHit).toBe(false);
    expect(judgePlayerSlot(10, [10.02, 9.95], [10.01], 0.08).errorSeconds).toBeCloseTo(-0.05, 9);
  });

  it('fuera de tolerancia es fallo', () => {
    expect(judgePlayerSlot(10, [10.2], [], 0.08)).toEqual({ isHit: false, errorSeconds: null });
  });
});

describe('detectStrayStroke', () => {
  it('un golpe en un silencio es falta', () => {
    expect(detectStrayStroke(10, [9.97], [], 0.08)).toBe(true);
    expect(detectStrayStroke(10, [9.8, 10.2], [], 0.08)).toBe(false);
  });

  it('el golpe del propio móvil y su cola no son falta', () => {
    expect(detectStrayStroke(10, [10.01], [10], 0.08)).toBe(false);
    expect(detectStrayStroke(10, [10.07], [10], 0.08)).toBe(false);
    expect(detectStrayStroke(10, [9.98], [10.02], 0.08)).toBe(false);
  });

  it('una palmada claramente antes del golpe del móvil, en su hueco, es falta', () => {
    expect(detectStrayStroke(10, [9.93], [10], 0.08)).toBe(true);
  });

  it('palmear todas las corcheas ya no gana: las faltas en los silencios acaban la partida', () => {
    // Patrón «MPMP-PMP» a 0,4 s la corchea, con palmadas en todas las corcheas salvo las del móvil.
    const slotSeconds = 0.4;
    const barOwners = ['machine', 'player', 'machine', 'player', 'rest', 'player', 'machine', 'player'];
    let gameTally = emptyTally;
    for (let barIndex = 0; barIndex < 10 && !gameTally.isOver; barIndex++) {
      barOwners.forEach((slotOwner, slotIndex) => {
        const expectedSeconds = (barIndex * barOwners.length + slotIndex) * slotSeconds;
        const machineTimes = slotOwner === 'machine' ? [expectedSeconds] : [];
        const clapTimes = slotOwner === 'machine' ? [] : [expectedSeconds + 0.01];
        if (slotOwner === 'player') {
          gameTally = addJudgement(gameTally, judgePlayerSlot(expectedSeconds, clapTimes, machineTimes, 0.08));
        } else if (detectStrayStroke(expectedSeconds, clapTimes, machineTimes, 0.08)) {
          gameTally = addJudgement(gameTally, strayJudgement);
        }
      });
    }
    expect(gameTally.isOver).toBe(true);
    expect(gameTally.strayStrokes).toBe(3);
    expect(gameTally.hits).toBe(10);
  });
});

describe('addJudgement', () => {
  it('tres fallos seguidos terminan la partida; un acierto reinicia la racha', () => {
    let gameTally = emptyTally;
    gameTally = addJudgement(gameTally, { isHit: false, errorSeconds: null });
    gameTally = addJudgement(gameTally, { isHit: false, errorSeconds: null });
    gameTally = addJudgement(gameTally, { isHit: true, errorSeconds: -0.02 });
    expect(gameTally.consecutiveMisses).toBe(0);
    for (let missIndex = 0; missIndex < 3; missIndex++) gameTally = addJudgement(gameTally, { isHit: false, errorSeconds: null });
    expect(gameTally).toMatchObject({ hits: 1, misses: 5, isOver: true });
    expect(gameTally.absoluteErrorSumSeconds).toBeCloseTo(0.02, 9);
    expect(addJudgement(gameTally, { isHit: true, errorSeconds: 0 })).toBe(gameTally);
  });

  it('una falta cuesta una vida que solo devuelven varios aciertos limpios seguidos', () => {
    const hitJudgement = { isHit: true, errorSeconds: 0 };
    let gameTally = addJudgement(addJudgement(emptyTally, hitJudgement), strayJudgement);
    expect(gameTally).toMatchObject({ hits: 1, misses: 1, strayStrokes: 1, consecutiveMisses: 1 });
    for (let hitIndex = 0; hitIndex < cleanHitsToForgiveStray - 1; hitIndex++) gameTally = addJudgement(gameTally, hitJudgement);
    expect(gameTally.consecutiveMisses).toBe(1);
    gameTally = addJudgement(gameTally, hitJudgement);
    expect(gameTally.consecutiveMisses).toBe(0);
  });
});
