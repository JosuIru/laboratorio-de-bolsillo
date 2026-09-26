import Storage from 'expo-sqlite/kv-store';

import {
  combineBaselineRecordings,
  type DomainFingerprint,
  type MachineFingerprint,
  maximumBaselineRecordingCount,
} from '@/processing/diagnostics/machineFingerprint';

export interface MonitoredMachine {
  id: string;
  name: string;
  /** Grabaciones de la máquina sana (hasta `maximumBaselineRecordingCount`). */
  baselineRecordings: MachineFingerprint[];
  /** Huella base: las grabaciones combinadas, o null si todavía no hay ninguna. */
  baseline: MachineFingerprint | null;
}

/** Máquina con sus grabaciones de la huella base y la huella combinada a partir de ellas. */
export function machineWithBaselineRecordings(
  machine: Pick<MonitoredMachine, 'id' | 'name'>,
  baselineRecordings: readonly MachineFingerprint[],
): MonitoredMachine {
  const keptRecordings = baselineRecordings.slice(-maximumBaselineRecordingCount);
  return { id: machine.id, name: machine.name, baselineRecordings: keptRecordings, baseline: combineBaselineRecordings(keptRecordings) };
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
    return parsedValue.flatMap((candidateMachine): MonitoredMachine[] => {
      if (typeof candidateMachine?.id !== 'string' || typeof candidateMachine?.name !== 'string') return [];
      // Las máquinas guardadas antes de las huellas de varias grabaciones solo tienen `baseline`.
      const storedRecordings: unknown[] = Array.isArray(candidateMachine.baselineRecordings)
        ? candidateMachine.baselineRecordings
        : [candidateMachine.baseline];
      const baselineRecordings = storedRecordings.flatMap((storedRecording) => {
        const recording = parseFingerprint(storedRecording);
        return recording ? [recording] : [];
      });
      return [machineWithBaselineRecordings(candidateMachine, baselineRecordings)];
    });
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
  // La huella combinada se recalcula al leer: basta con guardar las grabaciones.
  Storage.setItemSync(
    machinesStorageKey,
    JSON.stringify(machines.map(({ id, name, baselineRecordings }) => ({ id, name, baselineRecordings }))),
  );
}
