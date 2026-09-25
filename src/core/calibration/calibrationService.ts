import { randomUUID } from 'expo-crypto';

import type { AnyInstrumentDefinition } from '@/core/instruments/types';

import { getDeviceFingerprint } from './deviceFingerprint';
import { sqliteCalibrationRepository } from './sqliteCalibrationRepository';
import type { CalibrationProfile, CalibrationRepository } from './types';

export interface ResolvedCalibration<TParameters = unknown> {
  activeProfile: CalibrationProfile<TParameters> | null;
  /** Parámetros a usar: los del perfil activo válido o, si no, los de por defecto. */
  parameters: TParameters | null;
}

/**
 * Busca el perfil activo de este dispositivo. Si sus parámetros son de otra versión o ya no
 * son válidos, se ignora y se usan los de por defecto (el perfil sigue en el historial).
 */
export async function resolveActiveCalibration(
  instrument: AnyInstrumentDefinition,
  repository: CalibrationRepository = sqliteCalibrationRepository,
): Promise<ResolvedCalibration> {
  const calibrationDefinition = instrument.calibration;
  if (!calibrationDefinition) return { activeProfile: null, parameters: null };

  const defaultParameters = calibrationDefinition.defaultParameters ?? null;
  const activeProfile = await repository.getActiveProfile(instrument.id, getDeviceFingerprint());
  if (!activeProfile || activeProfile.parametersSchemaVersion !== calibrationDefinition.parametersSchemaVersion) {
    return { activeProfile: null, parameters: defaultParameters };
  }
  try {
    const parameters = calibrationDefinition.validateParameters
      ? calibrationDefinition.validateParameters(activeProfile.parameters)
      : activeProfile.parameters;
    return { activeProfile: { ...activeProfile, parameters }, parameters };
  } catch {
    return { activeProfile: null, parameters: defaultParameters };
  }
}

export async function createActiveCalibrationProfile(
  instrument: AnyInstrumentDefinition,
  profileName: string,
  parameters: unknown,
  repository: CalibrationRepository = sqliteCalibrationRepository,
): Promise<CalibrationProfile> {
  const calibrationDefinition = instrument.calibration;
  if (!calibrationDefinition) throw new Error(`El instrumento ${instrument.id} no admite calibración`);
  const validatedParameters = calibrationDefinition.validateParameters
    ? calibrationDefinition.validateParameters(parameters)
    : parameters;
  const profile: CalibrationProfile = {
    id: randomUUID(),
    instrumentId: instrument.id,
    deviceFingerprint: getDeviceFingerprint(),
    name: profileName.trim() || new Date().toLocaleString(),
    createdAt: Date.now(),
    parametersSchemaVersion: calibrationDefinition.parametersSchemaVersion,
    parameters: validatedParameters,
    isActive: true,
  };
  await repository.save(profile);
  return profile;
}

export function listCalibrationProfiles(
  instrument: AnyInstrumentDefinition,
  repository: CalibrationRepository = sqliteCalibrationRepository,
): Promise<CalibrationProfile[]> {
  return repository.listProfiles(instrument.id, getDeviceFingerprint());
}
