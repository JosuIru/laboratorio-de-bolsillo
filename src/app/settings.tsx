import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { supportedLocales } from '@/core/i18n';
import { useThemePalette } from '@/ui/theme';

export default function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const themePalette = useThemePalette();

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: themePalette.textPrimary }]}>{t('settings.language')}</Text>
      <View style={styles.localeOptions}>
        {supportedLocales.map((locale) => {
          const isSelectedLocale = i18n.language === locale;
          return (
            <Pressable
              key={locale}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelectedLocale }}
              onPress={() => void i18n.changeLanguage(locale)}
              style={[
                styles.localeOption,
                {
                  borderColor: isSelectedLocale ? themePalette.accent : themePalette.border,
                  backgroundColor: themePalette.surface,
                },
              ]}>
              <Text style={{ color: isSelectedLocale ? themePalette.accent : themePalette.textPrimary }}>
                {t(`language.${locale}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.privacyNote, { color: themePalette.textSecondary }]}>{t('settings.privacy')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  label: { fontSize: 16, fontWeight: '600' },
  localeOptions: { flexDirection: 'row', gap: 8 },
  localeOption: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1.5 },
  privacyNote: { fontSize: 13, marginTop: 16 },
});
