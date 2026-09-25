import { randomUUID } from 'expo-crypto';

import type { AnyInstrumentDefinition } from '@/core/instruments/types';
import { getLocationForMeasurement } from '@/core/sensors/adapters/location';
import { useAppSettingsStore } from '@/core/settings/settingsStore';

import { deleteMeasurementFiles, persistAttachmentDrafts } from './attachmentFiles';
import { sqliteMeasurementRepository } from './sqliteMeasurementRepository';
import type { Measurement, MeasurementDraft, MeasurementRepository, MeasurementValues } from './types';

interface SaveMeasurementContext {
  instrument: AnyInstrumentDefinition;
  calibrationProfileId?: string;
  repository?: MeasurementRepository;
}

export async function saveMeasurementDraft<TValues extends MeasurementValues>(
  draft: MeasurementDraft<TValues>,
  { instrument, calibrationProfileId, repository = sqliteMeasurementRepository }: SaveMeasurementContext,
): Promise<Measurement<TValues>> {
  // Se valida antes de tocar ficheros o base de datos.
  const validatedValues = instrument.dataSchema.validate(draft.values) as TValues;
  const measurementId = randomUUID();
  const shouldAttachLocation = useAppSettingsStore.getState().attachLocationToMeasurements;
  const location = shouldAttachLocation ? await getLocationForMeasurement() : undefined;

  const attachments = persistAttachmentDrafts(measurementId, draft.attachments ?? []);
  const measurement: Measurement<TValues> = {
    id: measurementId,
    instrumentId: instrument.id,
    schemaVersion: instrument.dataSchema.version,
    timestamp: Date.now(),
    values: validatedValues,
    attachments,
    ...(location ? { location } : {}),
    ...(calibrationProfileId ? { calibrationProfileId } : {}),
    ...(draft.note?.trim() ? { note: draft.note.trim() } : {}),
  };

  try {
    await repository.save(measurement);
  } catch (saveError) {
    deleteMeasurementFiles(measurementId);
    throw saveError;
  }
  return measurement;
}

export async function deleteMeasurement(
  measurementId: string,
  repository: MeasurementRepository = sqliteMeasurementRepository,
): Promise<void> {
  await repository.remove(measurementId);
  deleteMeasurementFiles(measurementId);
}
