import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { AnyInstrumentDefinition } from '@/core/instruments/types';
import type { Measurement } from '@/core/measurements/types';

import { buildExportFileName, measurementsToCsv, measurementsToJson } from './formatMeasurements';

export type ExportFormat = 'csv' | 'json';

const mimeTypeByFormat: Record<ExportFormat, string> = {
  csv: 'text/csv',
  json: 'application/json',
};

const uniformTypeByFormat: Record<ExportFormat, string> = {
  csv: 'public.comma-separated-values-text',
  json: 'public.json',
};

/** Escribe el fichero en la caché y abre la hoja de compartir del sistema. */
export async function shareMeasurements(
  instrument: AnyInstrumentDefinition,
  measurements: readonly Measurement[],
  exportFormat: ExportFormat,
  dialogTitle: string,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('La hoja de compartir no está disponible');

  const exportedAt = new Date();
  const fileContents =
    exportFormat === 'csv'
      ? measurementsToCsv(measurements, instrument.dataSchema)
      : measurementsToJson(measurements, instrument.id, instrument.dataSchema, exportedAt);

  const exportDirectory = new Directory(Paths.cache, 'exports');
  // Se vacía en cada exportación para no acumular copias de datos en la caché.
  if (exportDirectory.exists) exportDirectory.delete();
  exportDirectory.create({ intermediates: true });

  const exportFile = new File(exportDirectory, buildExportFileName(instrument.id, exportFormat, exportedAt));
  exportFile.create();
  exportFile.write(fileContents);

  await Sharing.shareAsync(exportFile.uri, {
    mimeType: mimeTypeByFormat[exportFormat],
    UTI: uniformTypeByFormat[exportFormat],
    dialogTitle,
  });
}
