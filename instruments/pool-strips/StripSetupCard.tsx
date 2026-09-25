import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppButton, BodyText, Card } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { addPadSlot, movePadSlot, removePadSlot } from './stripEngine';
import {
  ignoredPadSlot,
  maximumPadCount,
  poolStripsInstrumentId,
  type StripPadSlot,
  stripParameters,
  stripPresetIds,
  stripPresets,
} from './stripPresets';
import { createDefaultConfiguration, type StripConfiguration } from './stripStorage';

interface StripSetupCardProps {
  configuration: StripConfiguration;
  onConfigurationChange(updatedConfiguration: StripConfiguration): void;
}

/** Tipo de tira y almohadillas en el orden en que están en la tira, desde el asa. */
export function StripSetupCard({ configuration, onConfigurationChange }: StripSetupCardProps) {
  const { t } = useTranslation(poolStripsInstrumentId);
  const themePalette = useThemePalette();
  const { presetId, padSlots } = configuration;

  const describeSlot = (padSlot: StripPadSlot) =>
    padSlot === ignoredPadSlot ? t('setup.ignoredPad') : t(`quantities.${stripParameters[padSlot].quantity}`);
  const updatePadSlots = (updatedSlots: StripPadSlot[]) => onConfigurationChange({ presetId, padSlots: updatedSlots });
  const addableSlots: StripPadSlot[] = [
    ...stripPresets[presetId].parameterIds.filter((parameterId) => !padSlots.includes(parameterId)),
    ignoredPadSlot,
  ];

  return (
    <Card>
      <BodyText style={styles.title}>{t('setup.title')}</BodyText>
      <View style={styles.chipRow}>
        {stripPresetIds.map((candidatePresetId) => (
          <Chip
            key={candidatePresetId}
            label={t(`presets.${candidatePresetId}`)}
            isSelected={candidatePresetId === presetId}
            onPress={() => {
              if (candidatePresetId !== presetId) onConfigurationChange(createDefaultConfiguration(candidatePresetId));
            }}
          />
        ))}
      </View>
      <BodyText tone="secondary">{t('setup.padsHint')}</BodyText>

      {padSlots.map((padSlot, slotIndex) => {
        const slotName = describeSlot(padSlot);
        return (
          <View key={`${padSlot}-${slotIndex}`} style={[styles.slotRow, { borderColor: themePalette.border }]}>
            <BodyText style={styles.slotNumber}>{String(slotIndex + 1)}</BodyText>
            <BodyText style={styles.slotName} tone={padSlot === ignoredPadSlot ? 'secondary' : 'primary'}>
              {slotName}
            </BodyText>
            <SlotAction
              glyph="↑"
              accessibilityLabel={t('setup.moveTowardsHandle', { parameter: slotName })}
              isDisabled={slotIndex === 0}
              onPress={() => updatePadSlots(movePadSlot(padSlots, slotIndex, -1))}
            />
            <SlotAction
              glyph="↓"
              accessibilityLabel={t('setup.moveAwayFromHandle', { parameter: slotName })}
              isDisabled={slotIndex === padSlots.length - 1}
              onPress={() => updatePadSlots(movePadSlot(padSlots, slotIndex, 1))}
            />
            <SlotAction
              glyph="✕"
              accessibilityLabel={t('setup.remove', { parameter: slotName })}
              isDisabled={padSlots.length <= 1}
              onPress={() => updatePadSlots(removePadSlot(padSlots, slotIndex))}
            />
          </View>
        );
      })}

      {padSlots.length < maximumPadCount ? (
        <>
          <BodyText tone="secondary">{t('setup.add')}</BodyText>
          <View style={styles.chipRow}>
            {addableSlots.map((addableSlot) => (
              <Chip
                key={addableSlot}
                label={`+ ${describeSlot(addableSlot)}`}
                isSelected={false}
                accessibilityRole="button"
                onPress={() => updatePadSlots(addPadSlot(padSlots, addableSlot))}
              />
            ))}
          </View>
        </>
      ) : null}
      <AppButton
        label={t('setup.resetOrder')}
        variant="secondary"
        onPress={() => onConfigurationChange(createDefaultConfiguration(presetId))}
      />
    </Card>
  );
}

function SlotAction({
  glyph,
  accessibilityLabel,
  isDisabled,
  onPress,
}: {
  glyph: string;
  accessibilityLabel: string;
  isDisabled: boolean;
  onPress(): void;
}) {
  const themePalette = useThemePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      hitSlop={4}
      style={[styles.slotAction, { borderColor: themePalette.border, opacity: isDisabled ? 0.35 : 1 }]}>
      <BodyText tone="accent" style={styles.slotActionGlyph}>
        {glyph}
      </BodyText>
    </Pressable>
  );
}

export function Chip({
  label,
  isSelected,
  onPress,
  accessibilityRole = 'radio',
}: {
  label: string;
  isSelected: boolean;
  onPress(): void;
  /** `radio` para elegir una opción; `button` para acciones (p. ej. añadir). */
  accessibilityRole?: 'radio' | 'button';
}) {
  const themePalette = useThemePalette();
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityState={accessibilityRole === 'radio' ? { selected: isSelected } : {}}
      onPress={onPress}
      style={[styles.chip, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
      <BodyText tone={isSelected ? 'accent' : 'primary'}>{label}</BodyText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  slotNumber: { width: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  slotName: { flex: 1 },
  slotAction: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotActionGlyph: { fontSize: 18, fontWeight: '700' },
});
