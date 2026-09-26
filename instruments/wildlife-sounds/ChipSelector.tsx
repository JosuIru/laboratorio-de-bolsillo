import { Pressable, StyleSheet, View } from 'react-native';

import { BodyText } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

/** Fila de «chips» para elegir una opción (pestañas, orden, sensibilidad), como en superzoom. */
export function ChipSelector<TOption extends string>({
  options,
  selectedOption,
  labelFor,
  onSelect,
  accessibilityRole = 'radio',
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  labelFor(option: NoInfer<TOption>): string;
  onSelect(option: NoInfer<TOption>): void;
  accessibilityRole?: 'radio' | 'tab';
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.chipRow} accessibilityRole={accessibilityRole === 'tab' ? 'tablist' : 'radiogroup'}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={option}
            accessibilityRole={accessibilityRole}
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[
              styles.chip,
              {
                borderColor: isSelected ? themePalette.accent : themePalette.border,
                backgroundColor: isSelected ? themePalette.surface : 'transparent',
              },
            ]}>
            <BodyText tone={isSelected ? 'accent' : 'secondary'} style={isSelected ? styles.selectedLabel : undefined}>
              {labelFor(option)}
            </BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1.5 },
  selectedLabel: { fontWeight: '600' },
});
