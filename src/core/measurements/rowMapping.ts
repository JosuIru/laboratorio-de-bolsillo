import type { Attachment, AttachmentKind, Measurement } from './types';

export interface MeasurementRow {
  id: string;
  instrument_id: string;
  schema_version: number;
  timestamp: number;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  location_accuracy: number | null;
  values_json: string;
  calibration_profile_id: string | null;
  note: string | null;
}

export interface AttachmentRow {
  id: string;
  measurement_id: string;
  kind: string;
  file_uri: string;
  file_name: string;
  mime_type: string;
  metadata_json: string | null;
}

const attachmentKinds: readonly AttachmentKind[] = ['photo', 'audio', 'series'];

function toAttachmentKind(storedKind: string): AttachmentKind {
  return (attachmentKinds as readonly string[]).includes(storedKind) ? (storedKind as AttachmentKind) : 'series';
}

export function measurementToRow(measurement: Measurement): MeasurementRow {
  return {
    id: measurement.id,
    instrument_id: measurement.instrumentId,
    schema_version: measurement.schemaVersion,
    timestamp: measurement.timestamp,
    latitude: measurement.location?.latitude ?? null,
    longitude: measurement.location?.longitude ?? null,
    altitude: measurement.location?.altitude ?? null,
    location_accuracy: measurement.location?.accuracyMeters ?? null,
    values_json: JSON.stringify(measurement.values),
    calibration_profile_id: measurement.calibrationProfileId ?? null,
    note: measurement.note ?? null,
  };
}

export function attachmentToRow(measurementId: string, attachment: Attachment): AttachmentRow {
  return {
    id: attachment.id,
    measurement_id: measurementId,
    kind: attachment.kind,
    file_uri: attachment.fileUri,
    file_name: attachment.fileName,
    mime_type: attachment.mimeType,
    metadata_json: attachment.metadata ? JSON.stringify(attachment.metadata) : null,
  };
}

export function rowToAttachment(attachmentRow: AttachmentRow): Attachment {
  return {
    id: attachmentRow.id,
    kind: toAttachmentKind(attachmentRow.kind),
    fileUri: attachmentRow.file_uri,
    fileName: attachmentRow.file_name,
    mimeType: attachmentRow.mime_type,
    ...(attachmentRow.metadata_json ? { metadata: JSON.parse(attachmentRow.metadata_json) } : {}),
  };
}

export function rowToMeasurement(measurementRow: MeasurementRow, attachmentRows: readonly AttachmentRow[]): Measurement {
  const hasLocation = measurementRow.latitude !== null && measurementRow.longitude !== null;
  return {
    id: measurementRow.id,
    instrumentId: measurementRow.instrument_id,
    schemaVersion: measurementRow.schema_version,
    timestamp: measurementRow.timestamp,
    values: JSON.parse(measurementRow.values_json),
    attachments: attachmentRows.map(rowToAttachment),
    ...(hasLocation
      ? {
          location: {
            latitude: measurementRow.latitude!,
            longitude: measurementRow.longitude!,
            ...(measurementRow.altitude !== null ? { altitude: measurementRow.altitude } : {}),
            ...(measurementRow.location_accuracy !== null ? { accuracyMeters: measurementRow.location_accuracy } : {}),
          },
        }
      : {}),
    ...(measurementRow.calibration_profile_id !== null
      ? { calibrationProfileId: measurementRow.calibration_profile_id }
      : {}),
    ...(measurementRow.note !== null ? { note: measurementRow.note } : {}),
  };
}
