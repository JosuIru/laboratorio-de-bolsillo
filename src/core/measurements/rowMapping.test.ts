import { attachmentToRow, measurementToRow, rowToMeasurement } from './rowMapping';
import type { Measurement } from './types';

const completeMeasurement: Measurement = {
  id: 'measurement-1',
  instrumentId: 'seismograph',
  schemaVersion: 2,
  timestamp: 1_758_000_000_000,
  location: { latitude: 43.26, longitude: -2.93, altitude: 19, accuracyMeters: 12 },
  values: { peakAcceleration: 0.42, axes: [1, 2, 3] },
  attachments: [
    {
      id: 'attachment-1',
      kind: 'series',
      fileUri: 'file:///documents/measurements/measurement-1/series.bin',
      fileName: 'series.bin',
      mimeType: 'application/octet-stream',
      metadata: { sampleRateHz: 100 },
    },
  ],
  calibrationProfileId: 'profile-1',
  note: 'Mesa del laboratorio',
};

describe('conversión entre mediciones y filas de SQLite', () => {
  it('ida y vuelta sin perder datos', () => {
    const measurementRow = measurementToRow(completeMeasurement);
    const attachmentRows = completeMeasurement.attachments.map((attachment) =>
      attachmentToRow(completeMeasurement.id, attachment),
    );
    expect(rowToMeasurement(measurementRow, attachmentRows)).toEqual(completeMeasurement);
  });

  it('ida y vuelta de una medición mínima sin campos opcionales', () => {
    const minimalMeasurement: Measurement = {
      id: 'measurement-2',
      instrumentId: 'colorimeter',
      schemaVersion: 1,
      timestamp: 0,
      values: {},
      attachments: [],
    };
    const measurementRow = measurementToRow(minimalMeasurement);
    expect(measurementRow.latitude).toBeNull();
    expect(rowToMeasurement(measurementRow, [])).toEqual(minimalMeasurement);
  });
});
