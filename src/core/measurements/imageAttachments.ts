import type { Attachment, Measurement } from './types';

/** Extensiones de imagen que la app sabe mostrar (en minúsculas y sin punto). */
export const imageFileExtensions: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'heif'];

function fileExtensionOf(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');
  return lastDotIndex < 0 ? '' : fileName.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Un adjunto es una imagen si su tipo MIME es `image/*` o, si el tipo es genérico o falta,
 * si la extensión del fichero es de imagen. Las SVG se excluyen: `Image` no las pinta.
 */
export function isImageAttachment(attachment: Pick<Attachment, 'mimeType' | 'fileName'>): boolean {
  const normalizedMimeType = attachment.mimeType.trim().toLowerCase();
  if (normalizedMimeType === 'image/svg+xml') return false;
  if (normalizedMimeType.startsWith('image/')) return true;
  const isGenericMimeType = normalizedMimeType === '' || normalizedMimeType === 'application/octet-stream';
  return isGenericMimeType && imageFileExtensions.includes(fileExtensionOf(attachment.fileName));
}

export interface PartitionedAttachments {
  imageAttachments: Attachment[];
  otherAttachments: Attachment[];
}

export function partitionAttachments(attachments: readonly Attachment[]): PartitionedAttachments {
  const imageAttachments: Attachment[] = [];
  const otherAttachments: Attachment[] = [];
  for (const attachment of attachments) {
    (isImageAttachment(attachment) ? imageAttachments : otherAttachments).push(attachment);
  }
  return { imageAttachments, otherAttachments };
}

/** Imagen de una medición, con lo necesario para mostrarla en el visor o en la galería. */
export interface MeasurementImage {
  attachment: Attachment;
  measurementId: string;
  instrumentId: string;
  timestamp: number;
}

/** Todas las imágenes de una lista de mediciones, en el mismo orden que las mediciones. */
export function collectMeasurementImages(measurements: readonly Measurement[]): MeasurementImage[] {
  return measurements.flatMap((measurement) =>
    measurement.attachments.filter(isImageAttachment).map((attachment) => ({
      attachment,
      measurementId: measurement.id,
      instrumentId: measurement.instrumentId,
      timestamp: measurement.timestamp,
    })),
  );
}

/** Condición SQL equivalente a `isImageAttachment` sobre la tabla de adjuntos con el alias dado. */
export function buildImageAttachmentSqlCondition(tableAlias: string): string {
  const mimeTypeColumn = `lower(${tableAlias}.mime_type)`;
  const fileNameColumn = `lower(${tableAlias}.file_name)`;
  const extensionConditions = imageFileExtensions.map((extension) => `${fileNameColumn} LIKE '%.${extension}'`);
  return (
    `((${mimeTypeColumn} LIKE 'image/%' AND ${mimeTypeColumn} <> 'image/svg+xml')` +
    ` OR (${mimeTypeColumn} IN ('', 'application/octet-stream') AND (${extensionConditions.join(' OR ')})))`
  );
}
