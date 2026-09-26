import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, TextInput, View } from 'react-native';

import { AppButton, BodyText, Card, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { ChipSelector } from './ChipSelector';
import {
  type CustomSoundClass,
  type CustomSoundSensitivity,
  maximumClassNameLength,
  maximumExamplesPerClass,
  minimumExamplesForMatching,
  sanitizeClassName,
  similarityText,
  similarityThresholdBySensitivity,
} from './customSounds';

const wildlifeSoundsNamespace = 'wildlife-sounds';
const sensitivityOptions: readonly CustomSoundSensitivity[] = ['strict', 'normal', 'sensitive'];

export interface CustomSoundsPanelProps {
  targetClasses: readonly CustomSoundClass[];
  backgroundClass: CustomSoundClass | null;
  exampleCountByClassId: ReadonlyMap<number, number>;
  sensitivity: CustomSoundSensitivity;
  onSensitivityChange(sensitivity: CustomSoundSensitivity): void;
  /** Clase para la que se está grabando un ejemplo (el fondo incluido), o `null`. */
  enrollingClassId: number | null;
  isModelReady: boolean;
  onCreateClass(name: string): void;
  onRecordExample(classId: number): void;
  onRecordBackground(): void;
  onCancelRecording(): void;
  onRemoveLatestExample(classId: number): void;
  onRenameClass(classId: number, newName: string): void;
  onDeleteClass(classId: number): void;
  onExport(): void;
}

/** Pestaña «Tus sonidos»: crear clases, grabar ejemplos, fondo, sensibilidad y exportación. */
export function CustomSoundsPanel({
  targetClasses,
  backgroundClass,
  exampleCountByClassId,
  sensitivity,
  onSensitivityChange,
  enrollingClassId,
  isModelReady,
  onCreateClass,
  onRecordExample,
  onRecordBackground,
  onCancelRecording,
  onRemoveLatestExample,
  onRenameClass,
  onDeleteClass,
  onExport,
}: CustomSoundsPanelProps) {
  const { t } = useTranslation(wildlifeSoundsNamespace);
  const themePalette = useThemePalette();
  const [newClassName, setNewClassName] = useState('');
  const [renamingClassId, setRenamingClassId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');
  const isRecording = enrollingClassId !== null;
  const inputStyle = [styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }];
  const backgroundExampleCount = backgroundClass ? (exampleCountByClassId.get(backgroundClass.id) ?? 0) : 0;
  const isRecordingBackground = enrollingClassId !== null && enrollingClassId === backgroundClass?.id;
  const hasAnyExample = [...exampleCountByClassId.values()].some((exampleCount) => exampleCount > 0);

  function handleCreatePress() {
    const cleanName = sanitizeClassName(newClassName);
    if (!cleanName) return;
    onCreateClass(cleanName);
    setNewClassName('');
  }

  function handleRenameConfirm(classId: number) {
    const cleanName = sanitizeClassName(renameText);
    if (cleanName) onRenameClass(classId, cleanName);
    setRenamingClassId(null);
  }

  function handleDeletePress(customClass: CustomSoundClass) {
    Alert.alert(
      t('custom.deleteTitle'),
      t('custom.deleteMessage', {
        name: customClass.name,
        count: exampleCountByClassId.get(customClass.id) ?? 0,
      }),
      [
        { text: t('core:common.cancel'), style: 'cancel' },
        { text: t('custom.delete'), style: 'destructive', onPress: () => onDeleteClass(customClass.id) },
      ],
    );
  }

  return (
    <>
      <BodyText tone="secondary">{t('custom.intro')}</BodyText>
      {!isModelReady ? <BodyText tone="danger">{t('custom.needsModel')}</BodyText> : null}

      {isRecording ? (
        <Card>
          <BodyText tone="accent" style={styles.emphasis}>
            {t('custom.recording')}
          </BodyText>
          <AppButton label={t('custom.cancelRecording')} variant="secondary" onPress={onCancelRecording} />
        </Card>
      ) : null}

      <SectionTitle>{t('custom.newClassTitle')}</SectionTitle>
      <View style={styles.inputRow}>
        <TextInput
          value={newClassName}
          onChangeText={setNewClassName}
          placeholder={t('custom.newClassPlaceholder')}
          placeholderTextColor={themePalette.textSecondary}
          maxLength={maximumClassNameLength}
          style={inputStyle}
          accessibilityLabel={t('custom.newClassTitle')}
          onSubmitEditing={handleCreatePress}
          returnKeyType="done"
        />
        <AppButton
          label={t('custom.create')}
          variant="secondary"
          onPress={handleCreatePress}
          isDisabled={sanitizeClassName(newClassName) === null}
        />
      </View>

      <SectionTitle>{t('custom.classesTitle')}</SectionTitle>
      {targetClasses.length === 0 ? <BodyText tone="secondary">{t('custom.noClasses')}</BodyText> : null}
      {targetClasses.map((customClass) => {
        const exampleCount = exampleCountByClassId.get(customClass.id) ?? 0;
        const isRenaming = renamingClassId === customClass.id;
        return (
          <Card key={customClass.id}>
            {isRenaming ? (
              <View style={styles.inputRow}>
                <TextInput
                  value={renameText}
                  onChangeText={setRenameText}
                  maxLength={maximumClassNameLength}
                  style={inputStyle}
                  autoFocus
                  accessibilityLabel={t('custom.rename')}
                  onSubmitEditing={() => handleRenameConfirm(customClass.id)}
                  returnKeyType="done"
                />
                <AppButton label={t('custom.renameConfirm')} variant="secondary" onPress={() => handleRenameConfirm(customClass.id)} />
              </View>
            ) : (
              <BodyText style={styles.emphasis}>{customClass.name}</BodyText>
            )}
            <BodyText tone={exampleCount >= minimumExamplesForMatching ? 'secondary' : 'danger'} style={styles.smallText}>
              {exampleCount >= minimumExamplesForMatching
                ? t('custom.exampleCount', { count: exampleCount, maximum: maximumExamplesPerClass })
                : t('custom.needsMoreExamples', { count: exampleCount, minimum: minimumExamplesForMatching })}
            </BodyText>
            <AppButton
              label={
                enrollingClassId === customClass.id ? t('custom.recordingShort') : t('custom.recordExample', { count: exampleCount + 1 })
              }
              onPress={() => onRecordExample(customClass.id)}
              isDisabled={!isModelReady || isRecording || exampleCount >= maximumExamplesPerClass}
              isBusy={enrollingClassId === customClass.id}
            />
            <View style={styles.buttonRow}>
              <View style={styles.buttonCell}>
                <AppButton
                  label={t('custom.removeLatest')}
                  variant="secondary"
                  onPress={() => onRemoveLatestExample(customClass.id)}
                  isDisabled={exampleCount === 0 || isRecording}
                />
              </View>
              <View style={styles.buttonCell}>
                <AppButton
                  label={t('custom.rename')}
                  variant="secondary"
                  onPress={() => {
                    setRenamingClassId(customClass.id);
                    setRenameText(customClass.name);
                  }}
                  isDisabled={isRenaming}
                />
              </View>
            </View>
            <AppButton
              label={t('custom.delete')}
              variant="danger"
              onPress={() => handleDeletePress(customClass)}
              isDisabled={isRecording}
            />
          </Card>
        );
      })}

      <SectionTitle>{t('custom.backgroundTitle')}</SectionTitle>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('custom.backgroundHelp')}
      </BodyText>
      <Card>
        <BodyText>{t('custom.backgroundCount', { count: backgroundExampleCount })}</BodyText>
        <AppButton
          label={isRecordingBackground ? t('custom.recordingShort') : t('custom.recordBackground')}
          variant="secondary"
          onPress={onRecordBackground}
          isDisabled={!isModelReady || isRecording || backgroundExampleCount >= maximumExamplesPerClass}
        />
        {backgroundClass && backgroundExampleCount > 0 ? (
          <AppButton
            label={t('custom.removeLatest')}
            variant="secondary"
            onPress={() => onRemoveLatestExample(backgroundClass.id)}
            isDisabled={isRecording}
          />
        ) : null}
      </Card>

      <SectionTitle>{t('custom.sensitivityTitle')}</SectionTitle>
      <ChipSelector
        options={sensitivityOptions}
        selectedOption={sensitivity}
        labelFor={(option) =>
          t(`custom.sensitivity.${option}`, { threshold: similarityText(similarityThresholdBySensitivity[option]) })
        }
        onSelect={onSensitivityChange}
      />
      <BodyText tone="secondary" style={styles.smallText}>
        {t('custom.sensitivityHelp')}
      </BodyText>

      {hasAnyExample ? <AppButton label={t('custom.export')} variant="secondary" onPress={onExport} /> : null}
      <BodyText tone="secondary" style={styles.smallText}>
        {t('custom.privacy')}
      </BodyText>
    </>
  );
}

const styles = StyleSheet.create({
  emphasis: { fontWeight: '600' },
  smallText: { fontSize: 13 },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
