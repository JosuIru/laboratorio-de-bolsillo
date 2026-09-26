import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export type DetectionExportKind = 'jsonl' | 'csv';

const fileDescriptionByKind: Record<DetectionExportKind, { mimeType: string; uniformType: string }> = {
  jsonl: { mimeType: 'application/x-ndjson', uniformType: 'public.json' },
  csv: { mimeType: 'text/csv', uniformType: 'public.comma-separated-values-text' },
};

const utf8ByteOrderMark = '﻿';

function exportDirectory(): Directory {
  return new Directory(Paths.cache, 'wildlife-sounds');
}

/** Vacía la carpeta temporal para no acumular copias del registro en la caché. */
export function clearTemporaryDetectionExports(): void {
  const temporaryDirectory = exportDirectory();
  if (temporaryDirectory.exists) temporaryDirectory.delete();
}

/** Escribe el fichero en la caché y abre la hoja de compartir del sistema. */
export async function shareDetectionExport(
  fileName: string,
  fileContents: string,
  exportKind: DetectionExportKind,
  dialogTitle: string,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('La hoja de compartir no está disponible');
  clearTemporaryDetectionExports();
  const temporaryDirectory = exportDirectory();
  temporaryDirectory.create({ intermediates: true, idempotent: true });
  const exportFile = new File(temporaryDirectory, fileName);
  exportFile.create({ overwrite: true });
  // La marca BOM ayuda a Excel con las tildes; en JSONL estorbaría a los lectores de JSON.
  exportFile.write(exportKind === 'csv' ? utf8ByteOrderMark + fileContents : fileContents);
  const { mimeType, uniformType } = fileDescriptionByKind[exportKind];
  await Sharing.shareAsync(exportFile.uri, { mimeType, UTI: uniformType, dialogTitle });
}
