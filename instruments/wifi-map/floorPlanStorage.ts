import Storage from 'expo-sqlite/kv-store';

import type { PlanRoom } from '@/processing/wifi/floorPlan';
import { isValidRssi } from '@/processing/wifi/rssiStatistics';

import type { MappedPoint } from './useFloorPlanState';

/** Plano dibujado y puntos medidos, guardados para no perderlos al salir del instrumento. */
export interface StoredFloorPlan {
  rooms: PlanRoom[];
  mappedPoints: MappedPoint[];
}

const floorPlanStorageKey = 'wifiMap.floorPlan';

const emptyFloorPlan: StoredFloorPlan = { rooms: [], mappedPoints: [] };

function isUnitCoordinate(candidateValue: unknown): candidateValue is number {
  return typeof candidateValue === 'number' && Number.isFinite(candidateValue) && candidateValue >= 0 && candidateValue <= 1;
}

function parseRoom(candidateValue: unknown): PlanRoom | null {
  const candidate = candidateValue as Partial<PlanRoom> | null;
  if (
    !candidate ||
    !isUnitCoordinate(candidate.left) ||
    !isUnitCoordinate(candidate.top) ||
    !isUnitCoordinate(candidate.right) ||
    !isUnitCoordinate(candidate.bottom) ||
    candidate.right <= candidate.left ||
    candidate.bottom <= candidate.top
  ) {
    return null;
  }
  return { left: candidate.left, top: candidate.top, right: candidate.right, bottom: candidate.bottom };
}

function parseMappedPoint(candidateValue: unknown): MappedPoint | null {
  const candidate = candidateValue as Partial<MappedPoint> | null;
  if (
    !candidate ||
    !isUnitCoordinate(candidate.x) ||
    !isUnitCoordinate(candidate.y) ||
    typeof candidate.rssiDbm !== 'number' ||
    !isValidRssi(candidate.rssiDbm)
  ) {
    return null;
  }
  return {
    x: candidate.x,
    y: candidate.y,
    rssiDbm: candidate.rssiDbm,
    frequencyMhz: typeof candidate.frequencyMhz === 'number' && Number.isFinite(candidate.frequencyMhz) ? candidate.frequencyMhz : 0,
    sampleCount: typeof candidate.sampleCount === 'number' && Number.isFinite(candidate.sampleCount) ? candidate.sampleCount : 0,
  };
}

function parseEachValid<TParsed>(candidateValues: unknown, parseElement: (candidateValue: unknown) => TParsed | null): TParsed[] {
  if (!Array.isArray(candidateValues)) return [];
  return candidateValues.flatMap((candidateValue) => {
    const parsedElement = parseElement(candidateValue);
    return parsedElement ? [parsedElement] : [];
  });
}

/** Descarta lo corrupto en lugar de fallar: los datos vienen del almacenamiento local. */
export function parseStoredFloorPlan(storedText: string | null): StoredFloorPlan {
  if (!storedText) return emptyFloorPlan;
  try {
    const parsedValue = JSON.parse(storedText) as Partial<Record<keyof StoredFloorPlan, unknown>> | null;
    if (!parsedValue || typeof parsedValue !== 'object') return emptyFloorPlan;
    return {
      rooms: parseEachValid(parsedValue.rooms, parseRoom),
      mappedPoints: parseEachValid(parsedValue.mappedPoints, parseMappedPoint),
    };
  } catch {
    return emptyFloorPlan;
  }
}

export function loadFloorPlan(): StoredFloorPlan {
  try {
    return parseStoredFloorPlan(Storage.getItemSync(floorPlanStorageKey));
  } catch {
    return emptyFloorPlan;
  }
}

export function saveFloorPlan(floorPlan: StoredFloorPlan): void {
  try {
    Storage.setItemSync(floorPlanStorageKey, JSON.stringify(floorPlan));
  } catch {
    // Si no se puede guardar, el plano sigue en memoria mientras dure la sesión.
  }
}
