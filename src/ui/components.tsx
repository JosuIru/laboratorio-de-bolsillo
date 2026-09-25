import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemePalette } from './theme';

export function ScreenContainer({ children, isScrollable = true }: { children: ReactNode; isScrollable?: boolean }) {
  // Android dibuja la app de borde a borde: sin este margen, lo último de la pantalla queda
  // debajo de la barra de navegación y no se puede tocar.
  const { bottom: bottomInset } = useSafeAreaInsets();
  const contentStyle = [styles.screenContent, { paddingBottom: screenPadding + bottomInset }];
  if (!isScrollable) return <View style={contentStyle}>{children}</View>;
  return (
    <ScrollView contentContainerStyle={contentStyle} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const themePalette = useThemePalette();
  return (
    <View style={[styles.card, { backgroundColor: themePalette.surface, borderColor: themePalette.border }, style]}>
      {children}
    </View>
  );
}

type TextTone = 'primary' | 'secondary' | 'accent' | 'danger';

export function BodyText({
  children,
  tone = 'primary',
  style,
  numberOfLines,
}: {
  children: ReactNode;
  tone?: TextTone;
  style?: TextStyle;
  numberOfLines?: number;
}) {
  const themePalette = useThemePalette();
  const colorByTone: Record<TextTone, string> = {
    primary: themePalette.textPrimary,
    secondary: themePalette.textSecondary,
    accent: themePalette.accent,
    danger: themePalette.danger,
  };
  return (
    <Text numberOfLines={numberOfLines} style={[styles.bodyText, { color: colorByTone[tone] }, style]}>
      {children}
    </Text>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <BodyText style={styles.sectionTitle}>{children}</BodyText>;
}

type ButtonVariant = 'primary' | 'secondary' | 'danger';

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  isDisabled = false,
  isBusy = false,
}: {
  label: string;
  onPress(): void;
  variant?: ButtonVariant;
  isDisabled?: boolean;
  isBusy?: boolean;
}) {
  const themePalette = useThemePalette();
  const isPrimary = variant === 'primary';
  const variantColor = variant === 'danger' ? themePalette.danger : themePalette.accent;
  const isInactive = isDisabled || isBusy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isInactive, busy: isBusy }}
      disabled={isInactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: isPrimary ? variantColor : 'transparent',
          borderColor: variantColor,
          opacity: isInactive ? 0.5 : pressed ? 0.75 : 1,
        },
      ]}>
      {isBusy ? (
        <ActivityIndicator color={isPrimary ? themePalette.onAccent : variantColor} />
      ) : (
        <Text style={[styles.buttonLabel, { color: isPrimary ? themePalette.onAccent : variantColor }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function LoadingState({ label }: { label: string }) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={themePalette.accent} />
      <BodyText tone="secondary">{label}</BodyText>
    </View>
  );
}

const screenPadding = 16;

const styles = StyleSheet.create({
  screenContent: { padding: screenPadding, gap: 12, flexGrow: 1 },
  card: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 8 },
  bodyText: { fontSize: 15, lineHeight: 21 },
  sectionTitle: { fontSize: 17, fontWeight: '600', marginTop: 8 },
  button: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 15, fontWeight: '600' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
});
