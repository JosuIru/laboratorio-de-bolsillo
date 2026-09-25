import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import { useSensorAvailabilityStore } from '@/core/sensors/availabilityStore';
import type { SensorAvailability } from '@/core/sensors/types';
import { AppButton, BodyText } from '@/ui/components';
import { sensorDisplayName } from '@/ui/sensorText';
import { useThemePalette } from '@/ui/theme';

export function SegmentedChoice<TOption extends string>({
  options,
  selectedOption,
  onSelect,
  labelFor,
  isDisabled = false,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  onSelect(option: NoInfer<TOption>): void;
  labelFor(option: NoInfer<TOption>): string;
  isDisabled?: boolean;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.segmentedRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected, disabled: isDisabled }}
            disabled={isDisabled}
            onPress={() => onSelect(option)}
            style={[
              styles.segment,
              { borderColor: isSelected ? themePalette.accent : themePalette.border, opacity: isDisabled ? 0.5 : 1 },
            ]}>
            <BodyText tone={isSelected ? 'accent' : 'primary'} style={styles.segmentLabel}>
              {labelFor(option)}
            </BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Barra de 0 a 1. */
export function ProgressBar({ fraction }: { fraction: number }) {
  const themePalette = useThemePalette();
  const clampedFraction = Math.min(1, Math.max(0, fraction));
  return (
    <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
      <View
        style={[styles.progressFill, { backgroundColor: themePalette.accent, width: `${clampedFraction * 100}%` }]}
      />
    </View>
  );
}

/** Aviso con botón para pedir un permiso que el instrumento necesita solo en algunos modos. */
export function PermissionNotice({ sensorAvailability }: { sensorAvailability: SensorAvailability }) {
  const { t } = useTranslation();
  const requestSensorPermission = useSensorAvailabilityStore((state) => state.requestSensorPermission);
  const sensorName = sensorDisplayName(t, sensorAvailability.sensorKind);
  if (sensorAvailability.status === 'unavailable') {
    return <BodyText tone="danger">{t('core:sensors.reason.missingHardware', { sensor: sensorName })}</BodyText>;
  }
  const isBlocked = sensorAvailability.status === 'permission-denied' && sensorAvailability.canAskAgain === false;
  return (
    <View style={styles.permissionNotice}>
      <BodyText tone="danger">
        {isBlocked
          ? t('core:sensors.reason.permissionBlocked', { sensor: sensorName })
          : t('core:sensors.reason.permissionUndetermined', { sensor: sensorName })}
      </BodyText>
      {isBlocked ? (
        <AppButton label={t('core:instrument.openSystemSettings')} onPress={() => void Linking.openSettings()} />
      ) : (
        <AppButton
          label={t('core:instrument.grantPermission')}
          onPress={() => void requestSensorPermission(sensorAvailability.sensorKind)}
        />
      )}
    </View>
  );
}

export const modemStyles = StyleSheet.create({
  smallText: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  textInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetChip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});

const styles = StyleSheet.create({
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  segmentLabel: { fontSize: 14, textAlign: 'center' },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4 },
  permissionNotice: { gap: 8 },
});
