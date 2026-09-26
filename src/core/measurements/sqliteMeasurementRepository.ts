import { getDatabase } from '@/core/storage/database';

import { buildImageAttachmentSqlCondition, type MeasurementImage } from './imageAttachments';
import { buildMeasurementFilterSql } from './measurementFilter';
import {
  type AttachmentRow,
  attachmentToRow,
  type MeasurementRow,
  measurementToRow,
  rowToAttachment,
  rowToMeasurement,
} from './rowMapping';
import type { Measurement, MeasurementPage, MeasurementRepository } from './types';

async function attachMeasurementAttachments(measurementRows: MeasurementRow[]): Promise<Measurement[]> {
  if (measurementRows.length === 0) return [];
  const database = await getDatabase();
  const placeholders = measurementRows.map(() => '?').join(', ');
  const attachmentRows = await database.getAllAsync<AttachmentRow>(
    `SELECT * FROM attachments WHERE measurement_id IN (${placeholders})`,
    measurementRows.map((measurementRow) => measurementRow.id),
  );
  const attachmentRowsByMeasurement = new Map<string, AttachmentRow[]>();
  for (const attachmentRow of attachmentRows) {
    const measurementAttachments = attachmentRowsByMeasurement.get(attachmentRow.measurement_id) ?? [];
    measurementAttachments.push(attachmentRow);
    attachmentRowsByMeasurement.set(attachmentRow.measurement_id, measurementAttachments);
  }
  return measurementRows.map((measurementRow) =>
    rowToMeasurement(measurementRow, attachmentRowsByMeasurement.get(measurementRow.id) ?? []),
  );
}

export const sqliteMeasurementRepository: MeasurementRepository = {
  async save(measurement) {
    const database = await getDatabase();
    const measurementRow = measurementToRow(measurement);
    await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.runAsync(
        `INSERT OR REPLACE INTO measurements
          (id, instrument_id, schema_version, timestamp, latitude, longitude, altitude,
           location_accuracy, values_json, calibration_profile_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          measurementRow.id,
          measurementRow.instrument_id,
          measurementRow.schema_version,
          measurementRow.timestamp,
          measurementRow.latitude,
          measurementRow.longitude,
          measurementRow.altitude,
          measurementRow.location_accuracy,
          measurementRow.values_json,
          measurementRow.calibration_profile_id,
          measurementRow.note,
        ],
      );
      await transaction.runAsync('DELETE FROM attachments WHERE measurement_id = ?', [measurement.id]);
      for (const attachment of measurement.attachments) {
        const attachmentRow = attachmentToRow(measurement.id, attachment);
        await transaction.runAsync(
          `INSERT INTO attachments (id, measurement_id, kind, file_uri, file_name, mime_type, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            attachmentRow.id,
            attachmentRow.measurement_id,
            attachmentRow.kind,
            attachmentRow.file_uri,
            attachmentRow.file_name,
            attachmentRow.mime_type,
            attachmentRow.metadata_json,
          ],
        );
      }
    });
  },

  async findById(measurementId) {
    const database = await getDatabase();
    const measurementRow = await database.getFirstAsync<MeasurementRow>(
      'SELECT * FROM measurements WHERE id = ?',
      [measurementId],
    );
    if (!measurementRow) return null;
    const [measurement] = await attachMeasurementAttachments([measurementRow]);
    return measurement ?? null;
  },

  async listByInstrument(instrumentId, page?: MeasurementPage) {
    const database = await getDatabase();
    const measurementRows = await database.getAllAsync<MeasurementRow>(
      'SELECT * FROM measurements WHERE instrument_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
      [instrumentId, page?.limit ?? -1, page?.offset ?? 0],
    );
    return attachMeasurementAttachments(measurementRows);
  },

  async countByInstrument(instrumentId) {
    const database = await getDatabase();
    const countRow = await database.getFirstAsync<{ measurementCount: number }>(
      'SELECT COUNT(*) AS measurementCount FROM measurements WHERE instrument_id = ?',
      [instrumentId],
    );
    return countRow?.measurementCount ?? 0;
  },

  async listFiltered(filter, page?: MeasurementPage) {
    const database = await getDatabase();
    const { whereClause, parameters } = buildMeasurementFilterSql(filter, 'm');
    const measurementRows = await database.getAllAsync<MeasurementRow>(
      `SELECT m.* FROM measurements m ${whereClause} ORDER BY m.timestamp DESC, m.id LIMIT ? OFFSET ?`,
      [...parameters, page?.limit ?? -1, page?.offset ?? 0],
    );
    return attachMeasurementAttachments(measurementRows);
  },

  async countFiltered(filter) {
    const database = await getDatabase();
    const { whereClause, parameters } = buildMeasurementFilterSql(filter, 'm');
    const countRow = await database.getFirstAsync<{ measurementCount: number }>(
      `SELECT COUNT(*) AS measurementCount FROM measurements m ${whereClause}`,
      parameters,
    );
    return countRow?.measurementCount ?? 0;
  },

  async countPerInstrument() {
    const database = await getDatabase();
    const countRows = await database.getAllAsync<{ instrument_id: string; measurementCount: number }>(
      'SELECT instrument_id, COUNT(*) AS measurementCount FROM measurements GROUP BY instrument_id',
    );
    return new Map(countRows.map((countRow) => [countRow.instrument_id, countRow.measurementCount]));
  },

  async listImages(filter, page?: MeasurementPage) {
    const database = await getDatabase();
    const { whereClause, parameters } = buildMeasurementFilterSql(filter, 'm');
    const imageCondition = buildImageAttachmentSqlCondition('a');
    const combinedWhereClause = whereClause ? `${whereClause} AND ${imageCondition}` : `WHERE ${imageCondition}`;
    const imageRows = await database.getAllAsync<AttachmentRow & { instrument_id: string; timestamp: number }>(
      `SELECT a.*, m.instrument_id AS instrument_id, m.timestamp AS timestamp
         FROM attachments a JOIN measurements m ON m.id = a.measurement_id
         ${combinedWhereClause}
         ORDER BY m.timestamp DESC, m.id, a.rowid LIMIT ? OFFSET ?`,
      [...parameters, page?.limit ?? -1, page?.offset ?? 0],
    );
    return imageRows.map(
      (imageRow): MeasurementImage => ({
        attachment: rowToAttachment(imageRow),
        measurementId: imageRow.measurement_id,
        instrumentId: imageRow.instrument_id,
        timestamp: imageRow.timestamp,
      }),
    );
  },

  async remove(measurementId) {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM measurements WHERE id = ?', [measurementId]);
  },
};
