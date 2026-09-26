import { createSeededRandom } from '@/processing/dsp/signalGenerator';

/**
 * Generador de ritmos: un compás de 16 semicorcheas por vez, con bombo, caja, charles, bajo y un
 * arpegio. La energía decide cuántas capas suenan; cada cuatro compases hay un redoble y la
 * progresión de acordes avanza, para que no suene siempre igual. Con la misma semilla sale la
 * misma música (útil para los tests y para repetir una sesión).
 */

export const stepsPerBar = 16;

export type DrumVoice = 'kick' | 'snare' | 'hat';

export interface GrooveEvent {
  /** Posición dentro del compás, en semicorcheas (0–15). */
  stepIndex: number;
  voice: DrumVoice | 'bass' | 'lead';
  /** Nota MIDI para bajo y arpegio. */
  midiNote?: number;
  /** Intensidad relativa (0–1). */
  velocity: number;
}

/** Progresión I–V–vi–IV en La menor/Do mayor: raíces del bajo (MIDI) y arpegios. */
const chordProgression = [
  { bassRoot: 45, arpeggio: [69, 72, 76] }, // Lam
  { bassRoot: 41, arpeggio: [65, 69, 72] }, // Fa
  { bassRoot: 48, arpeggio: [67, 72, 76] }, // Do
  { bassRoot: 43, arpeggio: [67, 71, 74] }, // Sol
];

/** Bombo y caja base (4/4): bombo en 1 y 3, caja en 2 y 4. */
const baseKickSteps = [0, 8];
const baseSnareSteps = [4, 12];

export function generateBar(barIndex: number, energy: 0 | 1 | 2 | 3, seed: number): GrooveEvent[] {
  const nextRandom = createSeededRandom(seed * 1000 + barIndex);
  const chord = chordProgression[Math.floor(barIndex / 2) % chordProgression.length]!;
  const isFillBar = barIndex % 4 === 3;
  const grooveEvents: GrooveEvent[] = [];

  // Bombo: con más energía, algún golpe extra en las semicorcheas débiles.
  const kickSteps = new Set(baseKickSteps);
  if (energy >= 2) kickSteps.add(nextRandom() < 0.5 ? 10 : 6);
  if (energy >= 3) kickSteps.add(nextRandom() < 0.5 ? 14 : 3);
  for (const stepIndex of kickSteps)
    grooveEvents.push({ stepIndex, voice: 'kick', velocity: stepIndex % 4 === 0 ? 1 : 0.7 });

  // Caja desde energía 1; en el compás de redoble, semicorcheas al final.
  if (energy >= 1) {
    for (const stepIndex of baseSnareSteps) grooveEvents.push({ stepIndex, voice: 'snare', velocity: 0.9 });
    if (isFillBar) {
      for (const stepIndex of [13, 14, 15])
        grooveEvents.push({ stepIndex, voice: 'snare', velocity: 0.5 + 0.15 * (stepIndex - 13) });
    }
  }

  // Charles: corcheas; semicorcheas con mucha energía.
  const hatStride = energy >= 3 ? 1 : 2;
  for (let stepIndex = 0; stepIndex < stepsPerBar; stepIndex += hatStride) {
    grooveEvents.push({ stepIndex, voice: 'hat', velocity: stepIndex % 4 === 2 ? 0.8 : 0.45 });
  }

  // Bajo: la raíz en cada tiempo, con alguna octava por encima para moverlo.
  for (let stepIndex = 0; stepIndex < stepsPerBar; stepIndex += 4) {
    const isOctaveUp = energy >= 2 && nextRandom() < 0.3;
    grooveEvents.push({ stepIndex, voice: 'bass', midiNote: chord.bassRoot + (isOctaveUp ? 12 : 0), velocity: 0.8 });
  }

  // Arpegio desde energía 2: notas del acorde en corcheas, en un orden que cambia.
  if (energy >= 2) {
    for (let stepIndex = 0; stepIndex < stepsPerBar; stepIndex += 2) {
      if (nextRandom() < 0.25) continue;
      const arpeggioNote = chord.arpeggio[Math.floor(nextRandom() * chord.arpeggio.length)]!;
      grooveEvents.push({ stepIndex, voice: 'lead', midiNote: arpeggioNote, velocity: 0.5 });
    }
  }

  return grooveEvents.sort((leftEvent, rightEvent) => leftEvent.stepIndex - rightEvent.stepIndex);
}

/** Duración de una semicorchea a un tempo dado (negras por minuto). */
export function sixteenthSeconds(musicBpm: number): number {
  return 60 / musicBpm / 4;
}
