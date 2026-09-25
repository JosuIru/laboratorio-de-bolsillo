import {
  appendTap,
  beatsPerMinuteFromTaps,
  clampBeatsPerMinute,
  maximumBeatsPerMinute,
  minimumBeatsPerMinute,
  scheduleBeatsUntil,
} from './metronomeTiming';

describe('clampBeatsPerMinute', () => {
  it('redondea y se queda dentro de los límites', () => {
    expect(clampBeatsPerMinute(120.4)).toBe(120);
    expect(clampBeatsPerMinute(5)).toBe(minimumBeatsPerMinute);
    expect(clampBeatsPerMinute(900)).toBe(maximumBeatsPerMinute);
  });
});

describe('tempo por toques', () => {
  it('necesita al menos dos toques', () => {
    expect(beatsPerMinuteFromTaps([])).toBeNull();
    expect(beatsPerMinuteFromTaps([1])).toBeNull();
  });

  it('calcula el tempo con la mediana, sin que un toque torpe lo mueva', () => {
    expect(beatsPerMinuteFromTaps([0, 0.5, 1, 1.5])).toBe(120);
    expect(beatsPerMinuteFromTaps([0, 0.5, 1, 1.9, 2.4, 2.9])).toBe(120);
  });

  it('una pausa larga empieza una serie nueva y la serie tiene un máximo', () => {
    expect(appendTap([0, 0.5], 5)).toEqual([5]);
    let tapTimesSeconds: number[] = [];
    for (let tapIndex = 0; tapIndex < 20; tapIndex++) tapTimesSeconds = appendTap(tapTimesSeconds, tapIndex * 0.5);
    expect(tapTimesSeconds).toHaveLength(8);
    expect(tapTimesSeconds[7]).toBe(9.5);
  });
});

describe('scheduleBeatsUntil', () => {
  it('reparte los pulsos y acentúa el primero de cada compás', () => {
    const { scheduledBeats, nextPosition } = scheduleBeatsUntil(
      { nextBeatTimeSeconds: 1, nextBeatInBar: 0 },
      3,
      120,
      3,
    );
    expect(scheduledBeats.map((beat) => beat.timeSeconds)).toEqual([1, 1.5, 2, 2.5]);
    expect(scheduledBeats.map((beat) => beat.beatInBar)).toEqual([0, 1, 2, 0]);
    expect(scheduledBeats.map((beat) => beat.isAccent)).toEqual([true, false, false, true]);
    expect(nextPosition).toEqual({ nextBeatTimeSeconds: 3, nextBeatInBar: 1 });
  });

  it('sin compás no acentúa nada', () => {
    const { scheduledBeats } = scheduleBeatsUntil({ nextBeatTimeSeconds: 0, nextBeatInBar: 0 }, 2, 60, 1);
    expect(scheduledBeats.every((beat) => !beat.isAccent)).toBe(true);
  });

  it('si el compás se acorta, vuelve al primer pulso', () => {
    const { scheduledBeats } = scheduleBeatsUntil({ nextBeatTimeSeconds: 0, nextBeatInBar: 5 }, 0.1, 120, 4);
    expect(scheduledBeats[0]).toEqual({ timeSeconds: 0, beatInBar: 0, isAccent: true });
  });

  it('tras un bloqueo del hilo JS salta los pulsos pasados y mantiene el compás', () => {
    // Tocaba el pulso 1 en t = 1 s, pero el programador no se despertó hasta t = 2,2 s.
    const { scheduledBeats, nextPosition } = scheduleBeatsUntil(
      { nextBeatTimeSeconds: 1, nextBeatInBar: 1 },
      2.6,
      120,
      4,
      2.2,
    );
    // Se saltan 1, 1,5 y 2 s (pulsos 1, 2 y 3): el siguiente es el 0 en 2,5 s, con acento.
    expect(scheduledBeats).toEqual([{ timeSeconds: 2.5, beatInBar: 0, isAccent: true }]);
    expect(nextPosition).toEqual({ nextBeatTimeSeconds: 3, nextBeatInBar: 1 });
  });

  it('un pulso que cae justo ahora no se salta', () => {
    const { scheduledBeats } = scheduleBeatsUntil({ nextBeatTimeSeconds: 2, nextBeatInBar: 0 }, 2.1, 120, 4, 2);
    expect(scheduledBeats.map((beat) => beat.timeSeconds)).toEqual([2]);
  });

  it('no programa nada si el siguiente pulso cae después del horizonte', () => {
    const { scheduledBeats, nextPosition } = scheduleBeatsUntil({ nextBeatTimeSeconds: 5, nextBeatInBar: 2 }, 4, 120, 4);
    expect(scheduledBeats).toEqual([]);
    expect(nextPosition).toEqual({ nextBeatTimeSeconds: 5, nextBeatInBar: 2 });
  });
});
