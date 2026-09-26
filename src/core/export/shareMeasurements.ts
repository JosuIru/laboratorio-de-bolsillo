import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import type { AnyInstrumentDefinition } from '@/core/instruments/types';
import type { Attachment, Measurement } from '@/core/measurements/types';

import {
  buildExportFileName,
  groupMeasurementsByInstrument,
  type InstrumentMeasurementGroup,
  measurementGroupsToJson,
  measurementsToCsv,
  measurementsToJson,
} from './formatMeasurements';

export type ExportFormat = 'csv' | 'json';

const mimeTypeByFormat: Record<ExportFormat, string> = {
  csv: 'text/csv',
  json: 'application/json',
};

const uniformTypeByFormat: Record<ExportFormat, string> = {
  csv: 'public.comma-separated-values-text',
  json: 'public.json',
};

/** Escribe el contenido en la caché (vaciándola antes) y abre la hoja de compartir del sistema. */
async function writeAndShareExportFile(
  fileName: string,
  fileContents: string,
  exportFormat: ExportFormat,
  dialogTitle: string,
): Promise<void> {
  const exportDirectory = new Directory(Paths.cache, 'exports');
  // Se vacía en cada exportación para no acumular copias de datos en la caché.
  if (exportDirectory.exists) exportDirectory.delete();
  exportDirectory.create({ intermediates: true });

  const exportFile = new File(exportDirectory, fileName);
  exportFile.create();
  exportFile.write(fileContents);

  await Sharing.shareAsync(exportFile.uri, {
    mimeType: mimeTypeByFormat[exportFormat],
    UTI: uniformTypeByFormat[exportFormat],
    dialogTitle,
  });
}

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
  await writeAndShareExportFile(
    buildExportFileName(instrument.id, exportFormat, exportedAt),
    fileContents,
    exportFormat,
    dialogTitle,
  );
}

/** Nombre base de la exportación conjunta de varios instrumentos. */
export const allInstrumentsExportName = 'laboratorio-de-bolsillo';

/** Exporta en un solo JSON las mediciones de varios instrumentos (cada una con su esquema). */
export async function shareMeasurementsOfSeveralInstruments(
  measurements: readonly Measurement[],
  findInstrumentDefinition: (instrumentId: string) => AnyInstrumentDefinition | undefined,
  dialogTitle: string,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('La hoja de compartir no está disponible');

  const exportedAt = new Date();
  const measurementGroups: InstrumentMeasurementGroup[] = [];
  for (const [instrumentId, instrumentMeasurements] of groupMeasurementsByInstrument(measurements)) {
    const instrument = findInstrumentDefinition(instrumentId);
    // Mediciones de instrumentos que ya no están en esta build: sin esquema, se exportan tal cual.
    measurementGroups.push({
      instrumentId,
      schema: instrument?.dataSchema ?? { version: instrumentMeasurements[0]?.schemaVersion ?? 0, fields: [] },
      measurements: instrumentMeasurements,
    });
  }
  await writeAndShareExportFile(
    buildExportFileName(allInstrumentsExportName, 'json', exportedAt),
    measurementGroupsToJson(measurementGroups, exportedAt),
    'json',
    dialogTitle,
  );
}

/** Comparte un adjunto de una medición (p. ej. la serie cruda en CSV) con la hoja del sistema. */
export async function shareAttachment(attachment: Attachment, dialogTitle: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('La hoja de compartir no está disponible');
  if (!new File(attachment.fileUri).exists) throw new Error('El fichero adjunto ya no existe');
  await Sharing.shareAsync(attachment.fileUri, { mimeType: attachment.mimeType, dialogTitle });
}
