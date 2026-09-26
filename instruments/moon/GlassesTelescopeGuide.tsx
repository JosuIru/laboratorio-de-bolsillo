import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { BodyText, Card, SectionTitle } from '@/ui/components';

import { moonInstrumentId } from './instrumentId';

/** Apartados de la guía, en orden; cada uno tiene `title` y `body` en `glassesGuide.<apartado>`. */
const guideSections = ['materials', 'focalLength', 'assembly', 'focusing', 'photographing', 'resolution', 'tips'] as const;

/**
 * Guía para montar un telescopio de cartón con una lente de gafas de presbicia y fotografiar
 * con el móvil la imagen de la Luna en una pantalla de papel (docs/telescopio-gafas-presbicia.md).
 * El aviso de seguridad va el primero y destacado.
 */
export function GlassesTelescopeGuide() {
  const { t } = useTranslation(moonInstrumentId);
  return (
    <Card>
      <SectionTitle>{t('glassesGuide.title')}</SectionTitle>
      <View style={styles.safetyBox} accessibilityRole="alert">
        <BodyText style={styles.safetyTitle}>{t('glassesGuide.safetyTitle')}</BodyText>
        <BodyText style={styles.safetyText}>{t('glassesGuide.safetyBody')}</BodyText>
      </View>
      <BodyText tone="secondary">{t('glassesGuide.intro')}</BodyText>
      {guideSections.map((guideSection) => (
        <View key={guideSection} style={styles.section}>
          <BodyText style={styles.sectionTitle}>{t(`glassesGuide.${guideSection}.title`)}</BodyText>
          <BodyText tone="secondary">{t(`glassesGuide.${guideSection}.body`)}</BodyText>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  safetyBox: {
    borderWidth: 2,
    borderColor: '#DC2626',
    backgroundColor: 'rgba(220, 38, 38, 0.12)',
    borderRadius: 8,
    padding: 12,
    gap: 6,
  },
  safetyTitle: { color: '#DC2626', fontWeight: '800', fontSize: 18 },
  safetyText: { fontWeight: '600' },
  section: { gap: 4 },
  sectionTitle: { fontWeight: '700' },
});
