import type { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, View } from 'react-native';

import {
  ApkDownloadError,
  downloadReleaseApk,
  findDownloadedApk,
  isInAppInstallSupported,
  openApkInstaller,
  openUnknownSourcesSettings,
} from '@/core/updates/apkInstaller';
import type { AvailableRelease, UpdateCheckResult } from '@/core/updates/releaseSelection';
import { checkForUpdate, getInstalledVersion, repositoryUrl, UpdateCheckError } from '@/core/updates/updateChecker';

import { AppButton, BodyText, Card } from './components';
import { useThemePalette } from './theme';

type UpdateCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'finished'; result: UpdateCheckResult }
  | { status: 'failed'; errorKey: string };

type ApkInstallState =
  | { status: 'idle' }
  | { status: 'downloading'; downloadedBytes: number; totalBytes: number | null }
  | { status: 'downloaded'; downloadedApk: File; hasOpenedInstaller: boolean }
  | { status: 'failed'; errorKey: string };

const maximumReleaseNotesCharacters = 600;
const bytesPerMegabyte = 1_000_000;

function formatMegabytes(sizeBytes: number): string {
  return (sizeBytes / bytesPerMegabyte).toFixed(0);
}

function DownloadProgressBar({ progressFraction }: { progressFraction: number | null }) {
  const themePalette = useThemePalette();
  return (
    <View style={[styles.progressTrack, { backgroundColor: themePalette.border }]}>
      <View
        style={[
          styles.progressFill,
          {
            backgroundColor: themePalette.accent,
            width: `${Math.round((progressFraction ?? 0) * 100)}%`,
          },
        ]}
      />
    </View>
  );
}

/**
 * Descarga el APK dentro de la app, con progreso y cancelación, y abre el instalador de Android.
 * Si algo falla, queda el enlace para descargarlo desde GitHub con el navegador.
 */
function InAppApkInstaller({ availableRelease }: { availableRelease: AvailableRelease }) {
  const { t } = useTranslation();
  const [installState, setInstallState] = useState<ApkInstallState>(() => {
    const downloadedApk = findDownloadedApk(availableRelease);
    return downloadedApk ? { status: 'downloaded', downloadedApk, hasOpenedInstaller: false } : { status: 'idle' };
  });
  const downloadAbortControllerRef = useRef<AbortController | null>(null);
  /** Último avance mostrado (en % o en MB): solo se vuelve a pintar cuando cambia. */
  const lastShownProgressStepRef = useRef(-1);

  // Si se sale de la pantalla a mitad de descarga, se cancela: no quedan descargas huérfanas.
  useEffect(() => () => downloadAbortControllerRef.current?.abort(), []);

  async function installDownloadedApk(downloadedApk: File) {
    try {
      await openApkInstaller(downloadedApk);
      setInstallState({ status: 'downloaded', downloadedApk, hasOpenedInstaller: true });
    } catch {
      setInstallState({ status: 'failed', errorKey: 'updates.downloadError.installer' });
    }
  }

  async function handleDownloadAndInstall() {
    if (downloadAbortControllerRef.current) return;
    const downloadAbortController = new AbortController();
    downloadAbortControllerRef.current = downloadAbortController;
    lastShownProgressStepRef.current = -1;
    setInstallState({ status: 'downloading', downloadedBytes: 0, totalBytes: availableRelease.apkSizeBytes });
    let downloadedApk: File;
    try {
      downloadedApk = await downloadReleaseApk(availableRelease, {
        abortSignal: downloadAbortController.signal,
        onProgress: ({ downloadedBytes, totalBytes }) => {
          const progressStep = totalBytes
            ? Math.floor((downloadedBytes / totalBytes) * 100)
            : Math.floor(downloadedBytes / bytesPerMegabyte);
          if (progressStep === lastShownProgressStepRef.current) return;
          lastShownProgressStepRef.current = progressStep;
          setInstallState({ status: 'downloading', downloadedBytes, totalBytes });
        },
      });
    } catch (downloadError) {
      const failureReason = downloadError instanceof ApkDownloadError ? downloadError.reason : 'network';
      setInstallState({ status: 'failed', errorKey: `updates.downloadError.${failureReason}` });
      return;
    } finally {
      downloadAbortControllerRef.current = null;
    }
    setInstallState({ status: 'downloaded', downloadedApk, hasOpenedInstaller: false });
    await installDownloadedApk(downloadedApk);
  }

  if (installState.status === 'downloading') {
    const progressFraction = installState.totalBytes
      ? Math.min(1, installState.downloadedBytes / installState.totalBytes)
      : null;
    return (
      <View style={styles.installBlock}>
        <DownloadProgressBar progressFraction={progressFraction} />
        <BodyText tone="secondary">
          {progressFraction !== null
            ? t('updates.downloadingPercent', { percent: Math.floor(progressFraction * 100) })
            : t('updates.downloadingMegabytes', {
                downloadedMegabytes: formatMegabytes(installState.downloadedBytes),
              })}
        </BodyText>
        <AppButton
          label={t('updates.cancelDownload')}
          onPress={() => downloadAbortControllerRef.current?.abort()}
          variant="danger"
        />
      </View>
    );
  }

  if (installState.status === 'downloaded') {
    return (
      <View style={styles.installBlock}>
        <AppButton
          label={t('updates.install', { version: availableRelease.version })}
          onPress={() => void installDownloadedApk(installState.downloadedApk)}
        />
        {installState.hasOpenedInstaller ? (
          <>
            <BodyText tone="secondary" style={styles.hint}>
              {t('updates.unknownSourcesHint')}
            </BodyText>
            <AppButton
              label={t('updates.openUnknownSourcesSettings')}
              onPress={() => void openUnknownSourcesSettings(installState.downloadedApk).catch(() => undefined)}
              variant="secondary"
            />
          </>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.installBlock}>
      {installState.status === 'failed' ? <BodyText tone="danger">{t(installState.errorKey)}</BodyText> : null}
      <AppButton
        label={
          availableRelease.apkSizeBytes
            ? t('updates.downloadAndInstallWithSize', {
                sizeMegabytes: formatMegabytes(availableRelease.apkSizeBytes),
              })
            : t('updates.downloadAndInstall')
        }
        onPress={() => void handleDownloadAndInstall()}
      />
      <BodyText tone="secondary" style={styles.hint}>
        {t('updates.downloadHint')}
      </BodyText>
    </View>
  );
}

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
  const canInstallApk = isInAppInstallSupported && !!availableRelease?.apkDownloadUrl;

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
              <InAppApkInstaller key={availableRelease.version} availableRelease={availableRelease} />
              {/* Plan B: el navegador descarga el mismo APK en Descargas. */}
              <AppButton
                label={t('updates.openOnGitHub')}
                onPress={() => void Linking.openURL(availableRelease.apkDownloadUrl!)}
                variant="secondary"
              />
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
  installBlock: { gap: 8 },
  releaseTitle: { fontWeight: '600' },
  hint: { fontSize: 13 },
  progressTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4 },
});
