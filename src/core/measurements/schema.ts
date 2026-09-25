import type { MeasurementValues } from './types';

export type FieldType = 'number' | 'string' | 'boolean' | 'numberArray' | 'color';

export interface MeasurementFieldDescriptor {
  key: string;
  /** Clave i18n en el espacio de nombres del instrumento. */
  labelKey: string;
  type: FieldType;
  /** Unidad para mostrar y para la cabecera del CSV ('Hz', 'dB', 'm/s²', 'ΔE'…). */
  unit?: string;
  optional?: boolean;
}

export interface MeasurementSchema<TValues extends MeasurementValues = MeasurementValues> {
  /** Súbela cuando cambie la forma de `values`, para poder migrar mediciones antiguas. */
  version: number;
  fields: readonly MeasurementFieldDescriptor[];
  /** Lanza `MeasurementValidationError` si los valores no cumplen el esquema. */
  validate(rawValues: unknown): TValues;
}

export class MeasurementValidationError extends Error {
  constructor(
    readonly fieldKey: string,
    readonly expectedType: FieldType | 'object',
  ) {
    super(`Campo "${fieldKey}": se esperaba ${expectedType}`);
    this.name = 'MeasurementValidationError';
  }
}

const hexColorPattern = /^#[0-9a-fA-F]{6}$/;

function matchesFieldType(fieldValue: unknown, fieldType: FieldType): boolean {
  switch (fieldType) {
    case 'number':
      return typeof fieldValue === 'number' && Number.isFinite(fieldValue);
    case 'string':
      return typeof fieldValue === 'string';
    case 'boolean':
      return typeof fieldValue === 'boolean';
    case 'numberArray':
      return (
        (Array.isArray(fieldValue) || fieldValue instanceof Float32Array || fieldValue instanceof Float64Array) &&
        Array.from(fieldValue as ArrayLike<unknown>).every(
          (element) => typeof element === 'number' && Number.isFinite(element),
        )
      );
    case 'color':
      return typeof fieldValue === 'string' && hexColorPattern.test(fieldValue);
  }
}

/**
 * Crea un esquema a partir de la lista de campos. Los campos no declarados se descartan y
 * los arrays tipados se convierten en arrays normales para poder guardarlos como JSON.
 */
export function defineMeasurementSchema<TValues extends MeasurementValues>(
  version: number,
  fields: readonly MeasurementFieldDescriptor[],
): MeasurementSchema<TValues> {
  return {
    version,
    fields,
    validate(rawValues) {
      if (typeof rawValues !== 'object' || rawValues === null || Array.isArray(rawValues)) {
        throw new MeasurementValidationError('(values)', 'object');
      }
      const rawValueRecord = rawValues as Record<string, unknown>;
      const validatedValues: Record<string, unknown> = {};
      for (const field of fields) {
        const fieldValue = rawValueRecord[field.key];
        if (fieldValue === undefined || fieldValue === null) {
          if (field.optional) continue;
          throw new MeasurementValidationError(field.key, field.type);
        }
        if (!matchesFieldType(fieldValue, field.type)) {
          throw new MeasurementValidationError(field.key, field.type);
        }
        validatedValues[field.key] =
          field.type === 'numberArray' ? Array.from(fieldValue as ArrayLike<number>) : fieldValue;
      }
      return validatedValues as TValues;
    },
  };
}
