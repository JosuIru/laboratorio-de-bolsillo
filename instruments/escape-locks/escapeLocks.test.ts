import {
  advanceLock,
  createKnockDetector,
  detectPhonePose,
  type LockDefinition,
  lockCompletion,
  type LockReading,
  parseStoredPuzzles,
  startLockProgress,
} from './escapeLocks';

function reading(overrides: Partial<LockReading>): LockReading {
  return {
    noteCentsError: null,
    pose: null,
    magneticDeviationMicrotesla: null,
    newKnockTimesSeconds: [],
    nowSeconds: 0,
    ...overrides,
  };
}

function holdFor(lockDefinition: LockDefinition, lockReading: LockReading, seconds: number) {
  let lockProgress = startLockProgress();
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += 0.1) {
    lockProgress = advanceLock(lockDefinition, lockProgress, lockReading, 0.1);
  }
  return lockProgress;
}

describe('detectPhonePose', () => {
  it('reconoce cada posición por la gravedad', () => {
    expect(detectPhonePose(0, 0, -9.8)).toBe('face-down');
    expect(detectPhonePose(0, 0, 9.8)).toBe('face-up');
    expect(detectPhonePose(0, 9.8, 0)).toBe('upright');
    expect(detectPhonePose(0, -9.8, 0)).toBe('upside-down');
    expect(detectPhonePose(9.8, 0, 0)).toBe('left-side');
    expect(detectPhonePose(-9.8, 0, 0)).toBe('right-side');
  });

  it('a medias entre dos posiciones no decide', () => {
    expect(detectPhonePose(0, 6.9, 6.9)).toBeNull();
    expect(detectPhonePose(0, 0, 0)).toBeNull();
  });
});

describe('cerraduras de sostener', () => {
  it('la nota se abre al sostenerla afinada 1,5 s', () => {
    const noteLock: LockDefinition = { kind: 'note', noteIndex: 9 };
    expect(holdFor(noteLock, reading({ noteCentsError: 12 }), 1.6).isOpen).toBe(true);
    expect(holdFor(noteLock, reading({ noteCentsError: 60 }), 3).isOpen).toBe(false);
  });

  it('la posición y el imán también, y soltar pierde lo acumulado', () => {
    expect(holdFor({ kind: 'pose', pose: 'face-down' }, reading({ pose: 'face-down' }), 2.1).isOpen).toBe(true);
    expect(holdFor({ kind: 'magnet' }, reading({ magneticDeviationMicrotesla: 300 }), 1.1).isOpen).toBe(true);
    const halfway = holdFor({ kind: 'pose', pose: 'upright' }, reading({ pose: 'upright' }), 1);
    expect(advanceLock({ kind: 'pose', pose: 'upright' }, halfway, reading({ pose: 'face-up' }), 0.1).heldSeconds).toBe(0);
  });

  it('la barra de progreso va de 0 a 1', () => {
    const noteLock: LockDefinition = { kind: 'note', noteIndex: 0 };
    expect(lockCompletion(noteLock, holdFor(noteLock, reading({ noteCentsError: 0 }), 0.75))).toBeCloseTo(0.5, 6);
  });
});

describe('cerradura de golpes', () => {
  const knockLock: LockDefinition = { kind: 'knocks', knockCount: 3 };

  it('se abre con tres golpes seguidos, al terminar la serie', () => {
    let lockProgress = advanceLock(knockLock, startLockProgress(), reading({ newKnockTimesSeconds: [0, 0.4, 0.8], nowSeconds: 0.9 }), 0.1);
    expect(lockProgress.isOpen).toBe(false);
    lockProgress = advanceLock(knockLock, lockProgress, reading({ nowSeconds: 2.4 }), 0.1);
    expect(lockProgress.isOpen).toBe(true);
  });

  it('cuatro golpes no valen, y lo dice', () => {
    let lockProgress = advanceLock(knockLock, startLockProgress(), reading({ newKnockTimesSeconds: [0, 0.3, 0.6, 0.9], nowSeconds: 1 }), 0.1);
    lockProgress = advanceLock(knockLock, lockProgress, reading({ nowSeconds: 2.5 }), 0.1);
    expect(lockProgress.isOpen).toBe(false);
    expect(lockProgress.lastWrongKnockCount).toBe(4);
  });

  it('una pausa larga empieza la cuenta de nuevo', () => {
    let lockProgress = advanceLock(knockLock, startLockProgress(), reading({ newKnockTimesSeconds: [0, 0.4], nowSeconds: 0.5 }), 0.1);
    lockProgress = advanceLock(knockLock, lockProgress, reading({ newKnockTimesSeconds: [1.4, 1.8, 2.2], nowSeconds: 2.3 }), 0.1);
    lockProgress = advanceLock(knockLock, lockProgress, reading({ nowSeconds: 3.9 }), 0.1);
    expect(lockProgress.isOpen).toBe(true);
  });
});

describe('createKnockDetector', () => {
  it('detecta subidas bruscas y no cuenta el eco inmediato', () => {
    const knockDetector = createKnockDetector();
    const knockTimes: number[] = [];
    const levels = [-60, -61, -59, -60, -30, -35, -60, -60, -61, -28, -60];
    levels.forEach((levelDecibels, frameIndex) => {
      if (knockDetector.push(levelDecibels, frameIndex * 0.05)) knockTimes.push(frameIndex);
    });
    expect(knockTimes).toEqual([4, 9]);
  });
});

describe('parseStoredPuzzles', () => {
  it('conserva los puzles válidos y descarta cerraduras rotas', () => {
    const storedPuzzles = parseStoredPuzzles(
      JSON.stringify([
        {
          id: 'a',
          name: 'Sótano',
          secret: '4721',
          locks: [{ kind: 'note', noteIndex: 9 }, { kind: 'pose', pose: 'volando' }, { kind: 'knocks', knockCount: 3 }],
        },
        { id: 'b', name: 'Vacío', secret: 'x', locks: [{ kind: 'nada' }] },
      ]),
    );
    expect(storedPuzzles).toHaveLength(1);
    expect(storedPuzzles[0]!.locks).toEqual([{ kind: 'note', noteIndex: 9 }, { kind: 'knocks', knockCount: 3 }]);
    expect(parseStoredPuzzles('roto')).toEqual([]);
  });
});
