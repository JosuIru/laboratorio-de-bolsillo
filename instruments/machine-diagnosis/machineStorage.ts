import Storage from 'expo-sqlite/kv-store';

import type { DomainFingerprint, MachineFingerprint } from '@/processing/diagnostics/machineFingerprint';

export interface MonitoredMachine {
  id: string;
  name: string;
  /** Huella de la máquina sana, o null si todavía no se ha grabado. */
  baseline: MachineFingerprint | null;
}

const machinesStorageKey = 'machineDiagnosis.machines';

function isNumberArray(candidateValue: unknown): candidateValue is number[] {
  return Array.isArray(candidateValue) && candidateValue.every((element) => typeof element === 'number' && Number.isFinite(element));
}

function parseDomainFingerprint(candidateValue: unknown): DomainFingerprint | null {
  const candidate = candidateValue as Partial<DomainFingerprint> | null;
  if (
    !candidate ||
    !isNumberArray(candidate.bandCentersHz) ||
    !isNumberArray(candidate.bandLevelsDecibels) ||
    candidate.bandCentersHz.length !== candidate.bandLevelsDecibels.length ||
    typeof candidate.overallLevelDecibels !== 'number'
  ) {
    return null;
  }
  return {
    bandCentersHz: candidate.bandCentersHz,
    bandLevelsDecibels: candidate.bandLevelsDecibels,
    overallLevelDecibels: candidate.overallLevelDecibels,
    frameCount: typeof candidate.frameCount === 'number' ? candidate.frameCount : 0,
  };
}

function parseFingerprint(candidateValue: unknown): MachineFingerprint | null {
  const candidate = candidateValue as Partial<MachineFingerprint> | null;
  if (!candidate || typeof candidate.capturedAt !== 'number') return null;
  const audio = parseDomainFingerprint(candidate.audio);
  const vibration = parseDomainFingerprint(candidate.vibration);
  if (!audio && !vibration) return null;
  return {
    audio,
    vibration,
    capturedAt: candidate.capturedAt,
    durationSeconds: typeof candidate.durationSeconds === 'number' ? candidate.durationSeconds : 0,
  };
}

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredMachines(storedText: string | null): MonitoredMachine[] {
  if (!storedText) return [];
  try {
    const parsedValue: unknown = JSON.parse(storedText);
    if (!Array.isArray(parsedValue)) return [];
    return parsedValue.flatMap((candidateMachine): MonitoredMachine[] =>
      typeof candidateMachine?.id === 'string' && typeof candidateMachine?.name === 'string'
        ? [{ id: candidateMachine.id, name: candidateMachine.name, baseline: parseFingerprint(candidateMachine.baseline) }]
        : [],
    );
  } catch {
    return [];
  }
}

export function loadMachines(): MonitoredMachine[] {
  try {
    return parseStoredMachines(Storage.getItemSync(machinesStorageKey));
  } catch {
    return [];
  }
}

export function saveMachines(machines: readonly MonitoredMachine[]): void {
  Storage.setItemSync(machinesStorageKey, JSON.stringify(machines));
}
