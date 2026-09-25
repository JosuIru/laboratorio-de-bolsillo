import type { ComponentType } from 'react';

import type { CalibrationDefinition, CalibrationProfile } from '@/core/calibration/types';
import type { SupportedLocale } from '@/core/i18n';
import type { MeasurementSchema } from '@/core/measurements/schema';
import type { Measurement, MeasurementDraft, MeasurementValues } from '@/core/measurements/types';
import type { SensorAvailabilityMap, SensorKind } from '@/core/sensors/types';

export type InstrumentCategory = 'acoustics' | 'mechanics' | 'optics' | 'electromagnetism' | 'multi';

/** Árbol de traducciones de un instrumento (se registra en su propio espacio de nombres i18n). */
export interface TranslationTree {
  [key: string]: string | TranslationTree;
}

export interface InstrumentIcon {
  /** Símbolo Unicode o emoji. Se sustituirá por iconos propios sin cambiar el contrato. */
  glyph: string;
  /** Color de acento del instrumento. */
  accentColor: string;
}

export interface InstrumentScreenProps<
  TValues extends MeasurementValues = MeasurementValues,
  TCalibrationParameters = unknown,
> {
  instrumentId: string;
  /** Parámetros del perfil activo o, si no hay ninguno, `defaultParameters`. */
  calibrationParameters: TCalibrationParameters | null;
  activeCalibrationProfile: CalibrationProfile<TCalibrationParameters> | null;
  /** Valida contra el esquema, añade ubicación si el usuario lo ha activado y guarda. */
  saveMeasurement(draft: MeasurementDraft<TValues>): Promise<Measurement<TValues>>;
  /** Disponibilidad de todos los sensores, para activar funciones opcionales. */
  sensorAvailability: SensorAvailabilityMap;
}

export interface InstrumentDefinition<
  TValues extends MeasurementValues = MeasurementValues,
  TCalibrationParameters = unknown,
> {
  /** kebab-case, único y estable: se guarda en cada medición. */
  id: string;
  /** Claves i18n dentro de `translations`. */
  nameKey: string;
  descriptionKey: string;
  icon: InstrumentIcon;
  category: InstrumentCategory;
  requiredSensors: readonly SensorKind[];
  optionalSensors?: readonly SensorKind[];
  Screen: ComponentType<InstrumentScreenProps<TValues, TCalibrationParameters>>;
  dataSchema: MeasurementSchema<TValues>;
  calibration?: CalibrationDefinition<TCalibrationParameters>;
  translations: Record<SupportedLocale, TranslationTree>;
  /** Solo se registra en builds de desarrollo. */
  isDevelopmentOnly?: boolean;
}

/** Tipo borrado para listas heterogéneas de instrumentos (el registro). */
export type AnyInstrumentDefinition = InstrumentDefinition<any, any>;

/** Ayuda de tipos: `defineInstrument({...})` infiere valores y parámetros de calibración. */
export function defineInstrument<TValues extends MeasurementValues, TCalibrationParameters = unknown>(
  definition: InstrumentDefinition<TValues, TCalibrationParameters>,
): InstrumentDefinition<TValues, TCalibrationParameters> {
  return definition;
}
