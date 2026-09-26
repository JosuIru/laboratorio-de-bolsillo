import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export type NoiseExportKind = 'csv' | 'html';

const fileDescriptionByKind: Record<NoiseExportKind, { mimeType: string; uniformType: string }> = {
  csv: { mimeType: 'text/csv', uniformType: 'public.comma-separated-values-text' },
  html: { mimeType: 'text/html', uniformType: 'public.html' },
};

const utf8ByteOrderMark = '﻿';

/** Escribe un fichero temporal en la caché (para compartir o adjuntar) y devuelve su URI. */
export function writeTemporaryExportFile(fileName: string, fileContents: string, exportKind: NoiseExportKind): string {
  const exportDirectory = new Directory(Paths.cache, 'noise-log');
  exportDirectory.create({ intermediates: true, idempotent: true });
  const exportFile = new File(exportDirectory, fileName);
  exportFile.create({ overwrite: true });
  // La marca BOM ayuda a Excel a leer bien las tildes del CSV.
  exportFile.write(exportKind === 'csv' ? utf8ByteOrderMark + fileContents : fileContents);
  return exportFile.uri;
}

/** Vacía la carpeta temporal para no acumular copias de los informes en la caché. */
export function clearTemporaryExportFiles(): void {
  const exportDirectory = new Directory(Paths.cache, 'noise-log');
  if (exportDirectory.exists) exportDirectory.delete();
}

/** Escribe el fichero y abre la hoja de compartir del sistema. */
export async function shareNoiseExport(
  fileName: string,
  fileContents: string,
  exportKind: NoiseExportKind,
  dialogTitle: string,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('La hoja de compartir no está disponible');
  clearTemporaryExportFiles();
  const exportFileUri = writeTemporaryExportFile(fileName, fileContents, exportKind);
  const { mimeType, uniformType } = fileDescriptionByKind[exportKind];
  await Sharing.shareAsync(exportFileUri, { mimeType, UTI: uniformType, dialogTitle });
}
