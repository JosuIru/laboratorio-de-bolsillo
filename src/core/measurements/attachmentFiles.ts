import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import type { Attachment, AttachmentDraft } from './types';

function measurementDirectory(measurementId: string): Directory {
  return new Directory(Paths.document, 'measurements', measurementId);
}

/** Copia los adjuntos temporales a la carpeta permanente de la medición. */
export function persistAttachmentDrafts(measurementId: string, attachmentDrafts: readonly AttachmentDraft[]): Attachment[] {
  if (attachmentDrafts.length === 0) return [];
  const targetDirectory = measurementDirectory(measurementId);
  targetDirectory.create({ intermediates: true, idempotent: true });

  return attachmentDrafts.map((attachmentDraft) => {
    const attachmentId = randomUUID();
    const safeFileName = `${attachmentId.slice(0, 8)}-${attachmentDraft.fileName.replace(/[^\w.-]+/g, '_')}`;
    const permanentFile = new File(targetDirectory, safeFileName);
    new File(attachmentDraft.sourceUri).copy(permanentFile);
    return {
      id: attachmentId,
      kind: attachmentDraft.kind,
      fileUri: permanentFile.uri,
      fileName: safeFileName,
      mimeType: attachmentDraft.mimeType,
      ...(attachmentDraft.metadata ? { metadata: attachmentDraft.metadata } : {}),
    };
  });
}

export function deleteMeasurementFiles(measurementId: string): void {
  const targetDirectory = measurementDirectory(measurementId);
  if (targetDirectory.exists) targetDirectory.delete();
}
