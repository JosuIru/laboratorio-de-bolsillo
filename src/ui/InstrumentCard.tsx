import { useTranslation } from 'react-i18next';
import { Linking, Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentReadiness } from '@/core/instruments/availability';
import type { AnyInstrumentDefinition } from '@/core/instruments/types';

import { AppButton, BodyText } from './components';
import { describeSensorAvailability, sensorListDisplayText } from './sensorText';
import { useThemePalette } from './theme';

interface InstrumentCardProps {
  instrument: AnyInstrumentDefinition;
  readiness: InstrumentReadiness;
  onOpen(): void;
  onRequestPermissions(): void;
}

export function InstrumentCard({ instrument, readiness, onOpen, onRequestPermissions }: InstrumentCardProps) {
  const { t } = useTranslation();
  const themePalette = useThemePalette();
  const isReady = readiness.status === 'ready';
  const instrumentName = t(instrument.nameKey, { ns: instrument.id });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !isReady }}
      accessibilityLabel={instrumentName}
      disabled={!isReady}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: themePalette.surface,
          borderColor: themePalette.border,
          opacity: readiness.status === 'unavailable' ? 0.6 : pressed ? 0.8 : 1,
        },
      ]}>
      <View style={styles.headerRow}>
        <View style={[styles.iconBadge, { backgroundColor: instrument.icon.accentColor }]}>
          <BodyText style={styles.iconGlyph}>{instrument.icon.glyph}</BodyText>
        </View>
        <View style={styles.titleColumn}>
          <BodyText style={styles.instrumentName}>
            {instrumentName}
            {instrument.isDevelopmentOnly ? ` · ${t('home.developmentBadge')}` : ''}
          </BodyText>
          <BodyText tone="secondary">{t(instrument.descriptionKey, { ns: instrument.id })}</BodyText>
        </View>
      </View>

      {readiness.status === 'unavailable' ? (
        <View style={styles.statusBlock}>
          <BodyText tone="danger" style={styles.statusTitle}>
            {t('instrument.unavailableTitle')}
          </BodyText>
          {readiness.unavailableSensors.map((availability) => (
            <BodyText key={availability.sensorKind} tone="secondary">
              {`• ${describeSensorAvailability(t, availability)}`}
            </BodyText>
          ))}
        </View>
      ) : null}

      {readiness.status === 'needs-permission' ? (
        <View style={styles.statusBlock}>
          <BodyText tone="secondary">
            {t('instrument.needsPermission', { sensors: sensorListDisplayText(t, readiness.sensorsNeedingPermission) })}
          </BodyText>
          <AppButton label={t('instrument.grantPermission')} onPress={onRequestPermissions} variant="secondary" />
        </View>
      ) : null}

      {readiness.status === 'blocked-permission' ? (
        <View style={styles.statusBlock}>
          <BodyText tone="secondary">
            {t('instrument.blockedPermission', { sensors: sensorListDisplayText(t, readiness.sensorsNeedingPermission) })}
          </BodyText>
          <AppButton
            label={t('instrument.openSystemSettings')}
            onPress={() => void Linking.openSettings()}
            variant="secondary"
          />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 12 },
  headerRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  iconBadge: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  iconGlyph: { fontSize: 22, color: '#FFFFFF' },
  titleColumn: { flex: 1, gap: 2 },
  instrumentName: { fontSize: 17, fontWeight: '600' },
  statusBlock: { gap: 8 },
  statusTitle: { fontWeight: '600' },
});
