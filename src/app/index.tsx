import { Link } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useThemePalette } from '@/ui/theme';

export default function HomeScreen() {
  const { t } = useTranslation();
  const themePalette = useThemePalette();

  return (
    <View style={styles.container}>
      <Text style={[styles.tagline, { color: themePalette.textSecondary }]}>{t('app.tagline')}</Text>
      <Text style={[styles.sectionTitle, { color: themePalette.textPrimary }]}>{t('home.title')}</Text>
      <View style={[styles.emptyCard, { backgroundColor: themePalette.surface, borderColor: themePalette.border }]}>
        <Text style={{ color: themePalette.textSecondary }}>{t('home.empty')}</Text>
      </View>
      <Link href="/settings" asChild>
        <Pressable accessibilityRole="button" style={styles.settingsButton}>
          <Text style={{ color: themePalette.accent }}>{t('settings.title')}</Text>
        </Pressable>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  tagline: { fontSize: 15 },
  sectionTitle: { fontSize: 20, fontWeight: '600', marginTop: 8 },
  emptyCard: { padding: 16, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  settingsButton: { paddingVertical: 12, alignSelf: 'flex-start' },
});
