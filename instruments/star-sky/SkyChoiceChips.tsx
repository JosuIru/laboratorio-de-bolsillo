import { Pressable, StyleSheet, View } from 'react-native';

import { BodyText } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

/** Fila de opciones excluyentes («chips»). */
export function SkyChoiceChips<TOption extends string | number>({
  options,
  selectedOption,
  labelFor,
  onSelect,
  isDisabled = false,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  labelFor(option: TOption): string;
  onSelect(option: TOption): void;
  isDisabled?: boolean;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected, disabled: isDisabled }}
            disabled={isDisabled}
            onPress={() => onSelect(option)}
            style={[
              styles.chip,
              { borderColor: isSelected ? themePalette.accent : themePalette.border, opacity: isDisabled ? 0.5 : 1 },
            ]}>
            <BodyText tone={isSelected ? 'accent' : 'secondary'}>{labelFor(option)}</BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
});
