import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { CentralPanel } from './CentralPanel';
import type { SeismicNetworkMeasurementValues } from './schema';
import { seismicNetworkInstrumentId } from './seismicNetworkConfiguration';
import { StationPanel } from './StationPanel';

export { seismicNetworkInstrumentId };

type ScreenMode = 'station' | 'central' | 'guide';
const screenModes: readonly ScreenMode[] = ['station', 'central', 'guide'];
const guideStepKeys = ['step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7'] as const;
const guideQuestionKeys = ['question1', 'question2', 'question3', 'question4'] as const;

export function SeismicNetworkScreen({ saveMeasurement }: InstrumentScreenProps<SeismicNetworkMeasurementValues>) {
  const { t } = useTranslation(seismicNetworkInstrumentId);
  const themePalette = useThemePalette();
  const [screenMode, setScreenMode] = useState<ScreenMode>('station');

  return (
    <ScreenContainer>
      <View style={styles.segmentedRow}>
        {screenModes.map((mode) => {
          const isSelectedMode = mode === screenMode;
          return (
            <Pressable
              key={mode}
              accessibilityRole="tab"
              accessibilityState={{ selected: isSelectedMode }}
              onPress={() => setScreenMode(mode)}
              style={[
                styles.segment,
                {
                  borderColor: isSelectedMode ? themePalette.accent : themePalette.border,
                  backgroundColor: isSelectedMode ? themePalette.accent : 'transparent',
                },
              ]}>
              <BodyText style={{ ...styles.segmentLabel, color: isSelectedMode ? themePalette.onAccent : themePalette.textPrimary }}>
                {t(`modes.${mode}`)}
              </BodyText>
            </Pressable>
          );
        })}
      </View>

      {/* La estación sigue montada aunque se mire la central: así no se pierde la sincronización. */}
      <View style={screenMode === 'station' ? styles.visiblePanel : styles.hiddenPanel}>
        <StationPanel saveMeasurement={saveMeasurement} />
      </View>
      {screenMode === 'central' ? (
        <View style={styles.visiblePanel}>
          <CentralPanel saveMeasurement={saveMeasurement} />
        </View>
      ) : null}
      {screenMode === 'guide' ? <ActivityGuide /> : null}
    </ScreenContainer>
  );
}

function ActivityGuide() {
  const { t } = useTranslation(seismicNetworkInstrumentId);
  return (
    <View style={styles.visiblePanel}>
      <BodyText>{t('guide.intro')}</BodyText>
      <SectionTitle>{t('guide.materialsTitle')}</SectionTitle>
      <BodyText tone="secondary">{t('guide.materials')}</BodyText>
      <SectionTitle>{t('guide.stepsTitle')}</SectionTitle>
      {guideStepKeys.map((stepKey, stepIndex) => (
        <BodyText key={stepKey}>
          {stepIndex + 1}. {t(`guide.${stepKey}`)}
        </BodyText>
      ))}
      <SectionTitle>{t('guide.syncTitle')}</SectionTitle>
      <BodyText tone="secondary">{t('guide.syncExplanation')}</BodyText>
      <SectionTitle>{t('guide.questionsTitle')}</SectionTitle>
      {guideQuestionKeys.map((questionKey) => (
        <BodyText key={questionKey}>• {t(`guide.${questionKey}`)}</BodyText>
      ))}
      <Card>
        <BodyText style={styles.limitsTitle}>{t('guide.limitsTitle')}</BodyText>
        <BodyText tone="secondary">{t('guide.limits')}</BodyText>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  segmentedRow: { flexDirection: 'row', gap: 6 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  segmentLabel: { fontWeight: '600' },
  visiblePanel: { gap: 12 },
  hiddenPanel: { display: 'none' },
  limitsTitle: { fontWeight: '600' },
});
