import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import type { UpdateCheckResult } from '@/core/updates/releaseSelection';
import { checkForUpdate, getInstalledVersion, repositoryUrl, UpdateCheckError } from '@/core/updates/updateChecker';

import { AppButton, BodyText, Card } from './components';

type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'finished'; result: UpdateCheckResult }
  | { status: 'failed'; errorKey: string };

const maximumReleaseNotesCharacters = 600;

export function UpdateSection() {
  const { t, i18n } = useTranslation();
  const [checkState, setCheckState] = useState<UpdateCheckState>({ status: 'idle' });

  async function handleCheck() {
    setCheckState({ status: 'checking' });
    try {
      setCheckState({ status: 'finished', result: await checkForUpdate() });
    } catch (checkError) {
      const errorReason = checkError instanceof UpdateCheckError ? checkError.reason : 'unexpected-response';
      setCheckState({ status: 'failed', errorKey: `updates.error.${errorReason}` });
    }
  }

  const updateResult = checkState.status === 'finished' ? checkState.result : null;
  const availableRelease = updateResult?.status === 'update-available' ? updateResult.release : null;
  const canInstallApk = Platform.OS === 'android' && !!availableRelease?.apkDownloadUrl;

  return (
    <Card>
      <BodyText>{t('updates.installedVersion', { version: getInstalledVersion() })}</BodyText>
      <AppButton
        label={t('updates.check')}
        onPress={() => void handleCheck()}
        variant="secondary"
        isBusy={checkState.status === 'checking'}
      />

      {checkState.status === 'failed' ? <BodyText tone="danger">{t(checkState.errorKey)}</BodyText> : null}
      {updateResult?.status === 'up-to-date' ? <BodyText tone="secondary">{t('updates.upToDate')}</BodyText> : null}
      {updateResult?.status === 'no-releases' ? <BodyText tone="secondary">{t('updates.noReleases')}</BodyText> : null}

      {availableRelease ? (
        <View style={styles.releaseBlock}>
          <BodyText tone="accent" style={styles.releaseTitle}>
            {t('updates.available', { version: availableRelease.version })}
          </BodyText>
          {availableRelease.publishedAt ? (
            <BodyText tone="secondary">
              {new Date(availableRelease.publishedAt).toLocaleDateString(i18n.language)}
            </BodyText>
          ) : null}
          {availableRelease.releaseNotes ? (
            <BodyText tone="secondary" numberOfLines={10}>
              {availableRelease.releaseNotes.slice(0, maximumReleaseNotesCharacters)}
            </BodyText>
          ) : null}

          {canInstallApk ? (
            <>
              <AppButton
                label={
                  availableRelease.apkSizeBytes
                    ? t('updates.downloadApkWithSize', {
                        sizeMegabytes: (availableRelease.apkSizeBytes / 1_000_000).toFixed(0),
                      })
                    : t('updates.downloadApk')
                }
                onPress={() => void Linking.openURL(availableRelease.apkDownloadUrl!)}
              />
              <BodyText tone="secondary" style={styles.hint}>
                {t('updates.installHint')}
              </BodyText>
            </>
          ) : null}

          {availableRelease.releasePageUrl ? (
            <AppButton
              label={t('updates.viewRelease')}
              onPress={() => void Linking.openURL(availableRelease.releasePageUrl)}
              variant="secondary"
            />
          ) : null}
        </View>
      ) : null}

      <BodyText tone="secondary" style={styles.hint}>
        {t('updates.privacyNote', { repository: repositoryUrl.replace('https://', '') })}
      </BodyText>
    </Card>
  );
}

const styles = StyleSheet.create({
  releaseBlock: { gap: 8 },
  releaseTitle: { fontWeight: '600' },
  hint: { fontSize: 13 },
});
