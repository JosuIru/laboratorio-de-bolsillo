import type { GeoLocation } from '@/core/sensors/adapters/location';

export type { GeoLocation };

/** Cualquier objeto serializable a JSON; su forma la define el esquema del instrumento. */
export type MeasurementValues = object;

export function readMeasurementField(values: MeasurementValues, fieldKey: string): unknown {
  return (values as Record<string, unknown>)[fieldKey];
}

export type AttachmentKind = 'photo' | 'audio' | 'series';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** URI permanente dentro del directorio de documentos de la app. */
  fileUri: string;
  fileName: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

export interface Measurement<TValues extends MeasurementValues = MeasurementValues> {
  id: string;
  instrumentId: string;
  schemaVersion: number;
  /** Epoch en milisegundos. */
  timestamp: number;
  location?: GeoLocation;
  values: TValues;
  attachments: Attachment[];
  calibrationProfileId?: string;
  note?: string;
}

/** Adjunto recién capturado; el núcleo lo copia a almacenamiento permanente al guardar. */
export interface AttachmentDraft {
  kind: AttachmentKind;
  /** URI temporal (caché, cámara, grabadora…). */
  sourceUri: string;
  fileName: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

/** Lo que un instrumento entrega para guardar; el núcleo añade id, fecha, versión y ubicación. */
export interface MeasurementDraft<TValues extends MeasurementValues = MeasurementValues> {
  values: TValues;
  attachments?: AttachmentDraft[];
  note?: string;
}

export interface MeasurementPage {
  limit: number;
  offset: number;
}

export interface MeasurementRepository {
  save(measurement: Measurement): Promise<void>;
  findById(measurementId: string): Promise<Measurement | null>;
  listByInstrument(instrumentId: string, page?: MeasurementPage): Promise<Measurement[]>;
  countByInstrument(instrumentId: string): Promise<number>;
  remove(measurementId: string): Promise<void>;
}
