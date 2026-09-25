import { Pressable, StyleSheet, View } from 'react-native';

import { BodyText } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

export function SegmentedChoice<TOption extends string>({
  options,
  selectedOption,
  onSelect,
  labelFor,
}: {
  options: readonly TOption[];
  selectedOption: TOption;
  onSelect(option: NoInfer<TOption>): void;
  labelFor(option: NoInfer<TOption>): string;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.segmentedRow} accessibilityRole="radiogroup">
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[styles.segment, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
            <BodyText tone={isSelected ? 'accent' : 'primary'} style={styles.segmentLabel}>
              {labelFor(option)}
            </BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  segmentLabel: { fontSize: 14, textAlign: 'center' },
});
