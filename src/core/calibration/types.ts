import type { ComponentType } from 'react';

export interface CalibrationProfile<TParameters = unknown> {
  id: string;
  instrumentId: string;
  /** Identifica el modelo de móvil: una calibración no sirve para otro dispositivo. */
  deviceFingerprint: string;
  name: string;
  /** Epoch en milisegundos. */
  createdAt: number;
  parametersSchemaVersion: number;
  parameters: TParameters;
  isActive: boolean;
}

export interface CalibrationScreenProps<TParameters = unknown> {
  instrumentId: string;
  /** Perfil activo, por si el instrumento quiere partir de él. */
  activeProfile: CalibrationProfile<TParameters> | null;
  /** Guarda un perfil nuevo y lo deja activo. */
  saveProfile(profileName: string, parameters: TParameters): Promise<void>;
  cancel(): void;
}

export interface CalibrationDefinition<TParameters = unknown> {
  parametersSchemaVersion: number;
  CalibrationScreen: ComponentType<CalibrationScreenProps<TParameters>>;
  /** Parámetros si el usuario no ha calibrado nunca (p. ej. matriz identidad, offset 0 dB). */
  defaultParameters?: TParameters;
  /** Lanza si unos parámetros guardados ya no son válidos (p. ej. tras cambiar de versión). */
  validateParameters?(rawParameters: unknown): TParameters;
}

export interface CalibrationRepository {
  listProfiles(instrumentId: string, deviceFingerprint: string): Promise<CalibrationProfile[]>;
  getActiveProfile(instrumentId: string, deviceFingerprint: string): Promise<CalibrationProfile | null>;
  /** Guarda el perfil; si está activo, desactiva los demás del mismo instrumento y dispositivo. */
  save(profile: CalibrationProfile): Promise<void>;
  setActive(profileId: string): Promise<void>;
  remove(profileId: string): Promise<void>;
}
