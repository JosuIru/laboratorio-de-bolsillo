import type { MeasurementSchema } from '@/core/measurements/schema';
import { type Measurement, readMeasurementField } from '@/core/measurements/types';

const csvLineBreak = '\r\n';
const utf8ByteOrderMark = '﻿';
/** Caracteres con los que una hoja de cálculo interpreta una celda como fórmula. */
const formulaTriggerPattern = /^[=+\-@\t\r]/;

export function escapeCsvCell(cellText: string): string {
  return /[",\r\n]/.test(cellText) || cellText !== cellText.trim()
    ? `"${cellText.replace(/"/g, '""')}"`
    : cellText;
}

/** Evita que un texto escrito por el usuario se ejecute como fórmula al abrir el CSV. */
function neutralizeFormula(userText: string): string {
  return formulaTriggerPattern.test(userText) ? `'${userText}` : userText;
}

function formatCellValue(cellValue: unknown, isUserText: boolean): string {
  if (cellValue === undefined || cellValue === null) return '';
  if (typeof cellValue === 'string') return isUserText ? neutralizeFormula(cellValue) : cellValue;
  if (typeof cellValue === 'number' || typeof cellValue === 'boolean') return String(cellValue);
  return JSON.stringify(cellValue);
}

export interface CsvExportOptions {
  /** Ayuda a Excel a detectar UTF-8 (tildes, eñes, euskera). Por defecto, sí. */
  includeByteOrderMark?: boolean;
}

/**
 * Una fila por medición. Las columnas fijas van primero y después los campos del esquema,
 * con la unidad entre corchetes: `dominantFrequencyHz [Hz]`. Los arrays se escriben como JSON.
 */
export function measurementsToCsv(
  measurements: readonly Measurement[],
  schema: Pick<MeasurementSchema, 'fields'>,
  options: CsvExportOptions = {},
): string {
  const fixedHeaders = [
    'id',
    'timestamp_iso',
    'schema_version',
    'latitude',
    'longitude',
    'altitude_m',
    'location_accuracy_m',
    'calibration_profile_id',
    'note',
    'attachments',
  ];
  const fieldHeaders = schema.fields.map((field) => (field.unit ? `${field.key} [${field.unit}]` : field.key));
  const headerLine = [...fixedHeaders, ...fieldHeaders].map(escapeCsvCell).join(',');

  const dataLines = measurements.map((measurement) => {
    const fixedCells = [
      formatCellValue(measurement.id, false),
      new Date(measurement.timestamp).toISOString(),
      String(measurement.schemaVersion),
      formatCellValue(measurement.location?.latitude, false),
      formatCellValue(measurement.location?.longitude, false),
      formatCellValue(measurement.location?.altitude, false),
      formatCellValue(measurement.location?.accuracyMeters, false),
      formatCellValue(measurement.calibrationProfileId, false),
      formatCellValue(measurement.note, true),
      measurement.attachments.map((attachment) => attachment.fileName).join(';'),
    ];
    const fieldCells = schema.fields.map((field) =>
      formatCellValue(readMeasurementField(measurement.values, field.key), field.type === 'string'),
    );
    return [...fixedCells, ...fieldCells].map(escapeCsvCell).join(',');
  });

  const byteOrderMark = options.includeByteOrderMark === false ? '' : utf8ByteOrderMark;
  return byteOrderMark + [headerLine, ...dataLines].join(csvLineBreak) + csvLineBreak;
}

export const jsonExportFormatName = 'laboratorio-de-bolsillo/measurements';
export const jsonExportFormatVersion = 1;

/**
 * Exportación completa y autodescrita. Las rutas locales de los adjuntos no se incluyen
 * porque solo tienen sentido en este dispositivo.
 */
export function measurementsToJson(
  measurements: readonly Measurement[],
  instrumentId: string,
  schema: Pick<MeasurementSchema, 'fields' | 'version'>,
  exportedAt: Date = new Date(),
): string {
  const exportDocument = {
    format: jsonExportFormatName,
    formatVersion: jsonExportFormatVersion,
    exportedAt: exportedAt.toISOString(),
    instrument: { id: instrumentId, schemaVersion: schema.version, fields: schema.fields },
    measurements: measurements.map((measurement) => ({
      ...measurement,
      timestampIso: new Date(measurement.timestamp).toISOString(),
      attachments: measurement.attachments.map(({ fileUri: _localFileUri, ...portableAttachment }) => portableAttachment),
    })),
  };
  return JSON.stringify(exportDocument, null, 2);
}

/** Nombre de fichero seguro: `seismograph-2026-09-25T18-30-00.csv`. */
export function buildExportFileName(instrumentId: string, fileExtension: 'csv' | 'json', exportedAt: Date): string {
  const compactTimestamp = exportedAt.toISOString().slice(0, 19).replace(/:/g, '-');
  return `${instrumentId}-${compactTimestamp}.${fileExtension}`;
}
