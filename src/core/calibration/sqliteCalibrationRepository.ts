import { getDatabase } from '@/core/storage/database';

import type { CalibrationProfile, CalibrationRepository } from './types';

interface CalibrationProfileRow {
  id: string;
  instrument_id: string;
  device_fingerprint: string;
  name: string;
  created_at: number;
  parameters_schema_version: number;
  parameters_json: string;
  is_active: number;
}

function rowToProfile(profileRow: CalibrationProfileRow): CalibrationProfile {
  return {
    id: profileRow.id,
    instrumentId: profileRow.instrument_id,
    deviceFingerprint: profileRow.device_fingerprint,
    name: profileRow.name,
    createdAt: profileRow.created_at,
    parametersSchemaVersion: profileRow.parameters_schema_version,
    parameters: JSON.parse(profileRow.parameters_json),
    isActive: profileRow.is_active === 1,
  };
}

export const sqliteCalibrationRepository: CalibrationRepository = {
  async listProfiles(instrumentId, deviceFingerprint) {
    const database = await getDatabase();
    const profileRows = await database.getAllAsync<CalibrationProfileRow>(
      `SELECT * FROM calibration_profiles
       WHERE instrument_id = ? AND device_fingerprint = ?
       ORDER BY created_at DESC`,
      [instrumentId, deviceFingerprint],
    );
    return profileRows.map(rowToProfile);
  },

  async getActiveProfile(instrumentId, deviceFingerprint) {
    const database = await getDatabase();
    const profileRow = await database.getFirstAsync<CalibrationProfileRow>(
      `SELECT * FROM calibration_profiles
       WHERE instrument_id = ? AND device_fingerprint = ? AND is_active = 1
       LIMIT 1`,
      [instrumentId, deviceFingerprint],
    );
    return profileRow ? rowToProfile(profileRow) : null;
  },

  async save(profile) {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      if (profile.isActive) {
        await transaction.runAsync(
          'UPDATE calibration_profiles SET is_active = 0 WHERE instrument_id = ? AND device_fingerprint = ?',
          [profile.instrumentId, profile.deviceFingerprint],
        );
      }
      await transaction.runAsync(
        `INSERT OR REPLACE INTO calibration_profiles
          (id, instrument_id, device_fingerprint, name, created_at, parameters_schema_version, parameters_json, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profile.id,
          profile.instrumentId,
          profile.deviceFingerprint,
          profile.name,
          profile.createdAt,
          profile.parametersSchemaVersion,
          JSON.stringify(profile.parameters),
          profile.isActive ? 1 : 0,
        ],
      );
    });
  },

  async setActive(profileId) {
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const profileRow = await transaction.getFirstAsync<CalibrationProfileRow>(
        'SELECT * FROM calibration_profiles WHERE id = ?',
        [profileId],
      );
      if (!profileRow) return;
      await transaction.runAsync(
        'UPDATE calibration_profiles SET is_active = (id = ?) WHERE instrument_id = ? AND device_fingerprint = ?',
        [profileId, profileRow.instrument_id, profileRow.device_fingerprint],
      );
    });
  },

  async remove(profileId) {
    const database = await getDatabase();
    await database.runAsync('DELETE FROM calibration_profiles WHERE id = ?', [profileId]);
  },
};
