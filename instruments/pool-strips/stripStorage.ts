import Storage from 'expo-sqlite/kv-store';

import { hexToRgb8 } from '@/processing/color/colorSpaces';

import type { CalibratedStripScale, CalibratedStripScales } from './stripEngine';
import {
  ignoredPadSlot,
  isStripParameterId,
  isStripPresetId,
  maximumPadCount,
  type StripPadSlot,
  type StripPresetId,
  stripPresets,
  type StripScaleLevel,
} from './stripPresets';

const calibratedScalesStorageKey = 'pool-strips.calibratedScales';
const stripConfigurationStorageKey = 'pool-strips.configuration';

/** Tipo de tira y almohadillas, desde el asa. Se recuerda entre sesiones. */
export interface StripConfiguration {
  presetId: StripPresetId;
  padSlots: StripPadSlot[];
}

export function createDefaultConfiguration(presetId: StripPresetId): StripConfiguration {
  return { presetId, padSlots: [...stripPresets[presetId].parameterIds] };
}

function parseScaleLevels(candidateLevels: unknown): StripScaleLevel[] {
  if (!Array.isArray(candidateLevels)) return [];
  return candidateLevels
    .filter(
      (level: { value?: unknown; hexColor?: unknown }) =>
        typeof level?.value === 'number' &&
        Number.isFinite(level.value) &&
        typeof level?.hexColor === 'string' &&
        hexToRgb8(level.hexColor) !== null,
    )
    .map((level: StripScaleLevel) => ({ value: level.value, hexColor: level.hexColor }))
    .sort((leftLevel, rightLevel) => leftLevel.value - rightLevel.value);
}

/** Descarta escalas corruptas o de parámetros desconocidos: los datos vienen del almacenamiento local. */
export function parseStoredCalibratedScales(storedText: string | null): CalibratedStripScales {
  if (!storedText) return {};
  try {
    const parsedValue: unknown = JSON.parse(storedText);
    if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) return {};
    const calibratedScales: CalibratedStripScales = {};
    for (const [parameterId, candidateScale] of Object.entries(parsedValue)) {
      if (!isStripParameterId(parameterId)) continue;
      const levels = parseScaleLevels((candidateScale as Partial<CalibratedStripScale> | null)?.levels);
      if (levels.length < 2) continue;
      const calibratedAt = (candidateScale as Partial<CalibratedStripScale>).calibratedAt;
      calibratedScales[parameterId] = {
        levels,
        calibratedAt: typeof calibratedAt === 'number' && Number.isFinite(calibratedAt) ? calibratedAt : 0,
      };
    }
    return calibratedScales;
  } catch {
    return {};
  }
}

/**
 * Configuración guardada, o la de piscina por defecto si no es válida. Se quitan los parámetros
 * que no son del tipo de tira y los repetidos.
 */
export function parseStoredConfiguration(storedText: string | null): StripConfiguration {
  const fallbackConfiguration = createDefaultConfiguration('pool');
  if (!storedText) return fallbackConfiguration;
  try {
    const parsedValue = JSON.parse(storedText) as Partial<StripConfiguration> | null;
    const presetId = parsedValue?.presetId;
    if (!isStripPresetId(presetId) || !Array.isArray(parsedValue?.padSlots)) return fallbackConfiguration;
    const presetParameterIds: readonly string[] = stripPresets[presetId].parameterIds;
    const padSlots: StripPadSlot[] = [];
    for (const candidateSlot of parsedValue.padSlots) {
      if (padSlots.length >= maximumPadCount) break;
      if (candidateSlot === ignoredPadSlot) padSlots.push(ignoredPadSlot);
      else if (isStripParameterId(candidateSlot) && presetParameterIds.includes(candidateSlot) && !padSlots.includes(candidateSlot)) {
        padSlots.push(candidateSlot);
      }
    }
    return padSlots.length > 0 ? { presetId, padSlots } : createDefaultConfiguration(presetId);
  } catch {
    return fallbackConfiguration;
  }
}

export function loadCalibratedScales(): CalibratedStripScales {
  try {
    return parseStoredCalibratedScales(Storage.getItemSync(calibratedScalesStorageKey));
  } catch {
    return {};
  }
}

export function saveCalibratedScales(calibratedScales: CalibratedStripScales): void {
  Storage.setItemSync(calibratedScalesStorageKey, JSON.stringify(calibratedScales));
}

export function loadStripConfiguration(): StripConfiguration {
  try {
    return parseStoredConfiguration(Storage.getItemSync(stripConfigurationStorageKey));
  } catch {
    return createDefaultConfiguration('pool');
  }
}

export function saveStripConfiguration(configuration: StripConfiguration): void {
  Storage.setItemSync(stripConfigurationStorageKey, JSON.stringify(configuration));
}
