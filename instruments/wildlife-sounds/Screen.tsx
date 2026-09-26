import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, Switch, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { type GeoLocation, getLocationForMeasurement } from '@/core/sensors/adapters/location';
import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import {
  confidenceBarFraction,
  confidenceLevelFor,
  decideDetectionLogging,
  displayNameFor,
  type LoggingDecision,
  possibleMinimumScore,
  probableMinimumScore,
  type RankedClass,
  topScoringClasses,
} from './classification';
import {
  type DetectionRecord,
  encodeFloat16LittleEndian,
  formatDetectionsCsv,
  formatDetectionsJsonLines,
  roundCoordinate,
  roundScore,
} from './detectionLog';
import {
  deleteAllDetections,
  type DetectionStatistics,
  insertDetection,
  listAllDetections,
  listRecentDetections,
  readDetectionStatistics,
} from './detectionStore';
import {
  addWindowToSession,
  averageAnalysisMilliseconds,
  createListeningSessionSummary,
  formatSpeciesSummary,
  type ListeningSessionSummary,
} from './listeningSession';
import { MelSpectrogramView } from './MelSpectrogramView';
import type { FaunaManifest, SoundClass } from './modelManifest';
import { approximateModelMegabytes } from './modelStore';
import type { WildlifeSoundsMeasurementValues } from './schema';
import { shareDetectionExport, type DetectionExportKind } from './shareDetectionFiles';
import { type AnalyzedWindow, useWildlifeListener } from './useWildlifeListener';
import { useWildlifeModel } from './useWildlifeModel';
import type { ModelAccelerator } from './wildlifeClassifier';

export const wildlifeSoundsInstrumentId = 'wildlife-sounds';

/** Clases que se muestran por trozo. */
const displayedClassCount = 5;
/** Detecciones recientes que se listan en pantalla (la exportación las lleva todas). */
const recentDetectionCount = 10;
/** Por debajo de este nivel se avisa de que el micrófono apenas capta nada. */
const quietLevelDecibels = -70;
/** La ubicación se reutiliza durante este tiempo: no hace falta pedirla cada 2,5 s. */
const locationReuseMilliseconds = 60_000;

interface LatestAnalysis {
  topClasses: RankedClass[];
  loggingDecision: LoggingDecision;
  analyzedWindow: AnalyzedWindow;
}

async function readLogSnapshot(): Promise<{ statistics: DetectionStatistics; recentRecords: DetectionRecord[] }> {
  const [statistics, recentRecords] = await Promise.all([
    readDetectionStatistics(),
    listRecentDetections(recentDetectionCount),
  ]);
  return { statistics, recentRecords };
}

function megabytesText(byteCount: number): string {
  return (byteCount / 1_000_000).toFixed(1);
}

function localTimeText(isoTimestamp: string): string {
  const detectionDate = new Date(isoTimestamp);
  const twoDigits = (numericValue: number) => String(numericValue).padStart(2, '0');
  return `${twoDigits(detectionDate.getHours())}:${twoDigits(detectionDate.getMinutes())}:${twoDigits(detectionDate.getSeconds())}`;
}

export function WildlifeSoundsScreen({ saveMeasurement }: InstrumentScreenProps<WildlifeSoundsMeasurementValues>) {
  const { t, i18n } = useTranslation(wildlifeSoundsInstrumentId);
  const themePalette = useThemePalette();
  const appLocale = i18n.language;

  const [requestedAccelerator, setRequestedAccelerator] = useState<ModelAccelerator>('cpu');
  const {
    installedModel,
    downloadState,
    classifierState,
    fetchManifestForDownload,
    startDownload,
    cancelDownload,
    deleteModel,
  } = useWildlifeModel(requestedAccelerator);
  const classifier = classifierState.status === 'ready' ? classifierState.classifier : null;
  const manifest: FaunaManifest | null = classifier?.manifest ?? installedModel?.manifest ?? null;

  const [isListening, setIsListening] = useState(false);
  const [wasInterrupted, setWasInterrupted] = useState(false);
  const [latestAnalysis, setLatestAnalysis] = useState<LatestAnalysis | null>(null);
  const [sessionSummary, setSessionSummary] = useState<ListeningSessionSummary | null>(null);
  const [sessionEndTimestamp, setSessionEndTimestamp] = useState<number | null>(null);
  const [analysisErrorMessage, setAnalysisErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [isLocationEnabled, setIsLocationEnabled] = useState(false);
  const [isLocationDenied, setIsLocationDenied] = useState(false);
  const isLocationEnabledRef = useRef(isLocationEnabled);
  const cachedLocationRef = useRef<{ location: GeoLocation | undefined; fetchedAt: number } | null>(null);
  useEffect(() => {
    isLocationEnabledRef.current = isLocationEnabled;
  }, [isLocationEnabled]);

  const [logStatistics, setLogStatistics] = useState<DetectionStatistics | null>(null);
  const [recentDetections, setRecentDetections] = useState<DetectionRecord[]>([]);

  const refreshLog = useCallback(async () => {
    try {
      const { statistics, recentRecords } = await readLogSnapshot();
      setLogStatistics(statistics);
      setRecentDetections(recentRecords);
    } catch (readError) {
      setStatusMessage(t('core:common.error', { message: String(readError) }));
    }
  }, [t]);

  useEffect(() => {
    let isEffectActive = true;
    readLogSnapshot()
      .then(({ statistics, recentRecords }) => {
        if (!isEffectActive) return;
        setLogStatistics(statistics);
        setRecentDetections(recentRecords);
      })
      .catch((readError: unknown) => {
        if (isEffectActive) setStatusMessage(t('core:common.error', { message: String(readError) }));
      });
    return () => {
      isEffectActive = false;
    };
  }, [t]);

  const commonNameForLabel = useCallback(
    (label: string) => {
      const soundClass = manifest?.classes.find((candidateClass) => candidateClass.label === label);
      return soundClass ? displayNameFor(soundClass, appLocale) : label;
    },
    [manifest, appLocale],
  );

  async function readLocationForDetection(): Promise<GeoLocation | undefined> {
    const cachedLocation = cachedLocationRef.current;
    if (cachedLocation && Date.now() - cachedLocation.fetchedAt < locationReuseMilliseconds) return cachedLocation.location;
    const location = await getLocationForMeasurement({ maxAgeMilliseconds: 5 * 60_000 });
    cachedLocationRef.current = { location, fetchedAt: Date.now() };
    return location;
  }

  const handleWindowAnalyzed = useCallback(
    (analyzedWindow: AnalyzedWindow) => {
      if (!classifier) return;
      const { classes, modelVersion } = classifier.manifest;
      const topClasses = topScoringClasses(analyzedWindow.classification.logits, displayedClassCount);
      const loggingDecision = decideDetectionLogging(topClasses, classes);
      setLatestAnalysis({ topClasses, loggingDecision, analyzedWindow });
      setAnalysisErrorMessage(null);
      const speciesLabel = loggingDecision.kind === 'log' ? classes[loggingDecision.speciesClassIndex]!.label : '';
      setSessionSummary((previousSummary) =>
        previousSummary
          ? addWindowToSession(
              previousSummary,
              loggingDecision.kind === 'log'
                ? { kind: 'logged', speciesLabel, speciesScore: loggingDecision.speciesScore }
                : { kind: loggingDecision.kind },
              analyzedWindow.analysisMilliseconds,
            )
          : previousSummary,
      );
      if (loggingDecision.kind !== 'log') return;

      void (async () => {
        try {
          const location = isLocationEnabledRef.current ? await readLocationForDetection() : undefined;
          await insertDetection({
            detectedAtIso: new Date(analyzedWindow.windowEndTimestamp).toISOString(),
            durationSeconds: analyzedWindow.windowSeconds,
            latitude: location ? roundCoordinate(location.latitude) : null,
            longitude: location ? roundCoordinate(location.longitude) : null,
            speciesLabel,
            speciesScore: roundScore(loggingDecision.speciesScore),
            topClasses: topClasses.map((rankedClass) => ({
              label: classes[rankedClass.classIndex]?.label ?? String(rankedClass.classIndex),
              score: roundScore(rankedClass.score),
            })),
            modelVersion,
            embeddingFloat16Bytes: encodeFloat16LittleEndian(analyzedWindow.classification.embedding),
          });
          await refreshLog();
        } catch (insertError) {
          setStatusMessage(t('log.saveError', { message: String(insertError) }));
        }
      })();
    },
    [classifier, refreshLog, t],
  );

  const handleAnalysisError = useCallback((errorMessage: string) => setAnalysisErrorMessage(errorMessage), []);

  const { listenerState } = useWildlifeListener({
    isListening,
    classifier,
    onWindowAnalyzed: handleWindowAnalyzed,
    onAnalysisError: handleAnalysisError,
  });
  useKeepScreenOnWhile(isListening, wildlifeSoundsInstrumentId);

  // Al tapar la pantalla o pasar a segundo plano, la escucha se da por terminada y se avisa.
  const releaseNothing = useCallback(() => undefined, []);
  useStopWhenAppInactive(() => {
    if (!isListening) return;
    setIsListening(false);
    setSessionEndTimestamp(Date.now());
    setWasInterrupted(true);
  }, releaseNothing);

  function handleStartListening() {
    setStatusMessage(null);
    setWasInterrupted(false);
    setAnalysisErrorMessage(null);
    setLatestAnalysis(null);
    setSessionSummary(createListeningSessionSummary(Date.now()));
    setSessionEndTimestamp(null);
    setIsListening(true);
  }

  function handleStopListening() {
    setIsListening(false);
    setSessionEndTimestamp(Date.now());
  }

  async function handleDownloadPress() {
    setStatusMessage(null);
    const remoteManifest = await fetchManifestForDownload();
    if (!remoteManifest) return;
    Alert.alert(
      t('model.confirmTitle'),
      t('model.confirmMessage', { megabytes: megabytesText(remoteManifest.modelBytes) }),
      [
        { text: t('core:common.cancel'), style: 'cancel' },
        { text: t('model.confirm'), onPress: () => void startDownload(remoteManifest) },
      ],
    );
  }

  function handleDeleteModelPress() {
    if (!installedModel) return;
    Alert.alert(
      t('model.deleteTitle'),
      t('model.deleteMessage', { megabytes: megabytesText(installedModel.manifest.modelBytes) }),
      [
        { text: t('core:common.cancel'), style: 'cancel' },
        {
          text: t('model.delete'),
          style: 'destructive',
          onPress: () => {
            if (isListening) handleStopListening();
            setLatestAnalysis(null);
            deleteModel();
          },
        },
      ],
    );
  }

  async function handleLocationToggle(shouldUseLocation: boolean) {
    if (!shouldUseLocation) {
      setIsLocationEnabled(false);
      return;
    }
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      const isGranted = permission.status === 'granted';
      setIsLocationDenied(!isGranted);
      setIsLocationEnabled(isGranted);
      cachedLocationRef.current = null;
    } catch {
      setIsLocationDenied(true);
      setIsLocationEnabled(false);
    }
  }

  async function handleExport(exportKind: DetectionExportKind) {
    setStatusMessage(null);
    try {
      const allDetections = await listAllDetections();
      const fileContents =
        exportKind === 'jsonl'
          ? formatDetectionsJsonLines(allDetections)
          : formatDetectionsCsv(allDetections, commonNameForLabel);
      const dateText = new Date().toISOString().slice(0, 10);
      await shareDetectionExport(`quien-canta-${dateText}.${exportKind}`, fileContents, exportKind, t('log.shareTitle'));
    } catch (exportError) {
      setStatusMessage(t('core:common.error', { message: String(exportError) }));
    }
  }

  function handleDeleteLogPress() {
    Alert.alert(t('log.deleteTitle'), t('log.deleteMessage', { count: logStatistics?.detectionCount ?? 0 }), [
      { text: t('core:common.cancel'), style: 'cancel' },
      {
        text: t('log.delete'),
        style: 'destructive',
        onPress: () => {
          void deleteAllDetections()
            .then(refreshLog)
            .catch((deleteError: unknown) => setStatusMessage(t('core:common.error', { message: String(deleteError) })));
        },
      },
    ]);
  }

  async function handleSaveSession() {
    if (!sessionSummary || !manifest) return;
    setIsSaving(true);
    setStatusMessage(null);
    try {
      const bestTally = [...sessionSummary.speciesTallies].sort((left, right) => right.bestScore - left.bestScore)[0];
      const durationSeconds = Math.round(((sessionEndTimestamp ?? Date.now()) - sessionSummary.sessionStartTimestamp) / 1000);
      await saveMeasurement({
        values: {
          sessionStartTimestamp: sessionSummary.sessionStartTimestamp,
          durationSeconds,
          analyzedWindowCount: sessionSummary.analyzedWindowCount,
          loggedDetectionCount: sessionSummary.loggedDetectionCount,
          humanVoiceWindowCount: sessionSummary.humanVoiceWindowCount,
          distinctSpeciesCount: sessionSummary.speciesTallies.length,
          speciesSummary: formatSpeciesSummary(sessionSummary.speciesTallies, commonNameForLabel),
          ...(bestTally ? { bestSpeciesLabel: bestTally.label, bestSpeciesScore: roundScore(bestTally.bestScore) } : {}),
          averageAnalysisMilliseconds: Math.round(averageAnalysisMilliseconds(sessionSummary)),
          modelVersion: manifest.modelVersion,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const isDownloading = downloadState.status === 'downloading';
  const downloadProgress = downloadState.status === 'downloading' ? downloadState.progress : null;
  const downloadFraction =
    downloadProgress && downloadProgress.totalBytes > 0 ? downloadProgress.bytesWritten / downloadProgress.totalBytes : 0;
  const latestWindow = latestAnalysis?.analyzedWindow ?? null;

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('intro')}</BodyText>
      <Card>
        <BodyText style={styles.emphasis}>{t('privacyTitle')}</BodyText>
        <BodyText tone="secondary">{t('privacy')}</BodyText>
      </Card>

      <SectionTitle>{t('model.title')}</SectionTitle>
      {installedModel ? (
        <Card>
          <BodyText>
            {t('model.installed', {
              version: installedModel.manifest.modelVersion,
              megabytes: megabytesText(installedModel.manifest.modelBytes),
            })}
          </BodyText>
          <BodyText tone="secondary" style={styles.smallText}>
            {t('model.license')}
          </BodyText>
          {classifierState.status === 'loading' ? <BodyText tone="secondary">{t('model.loading')}</BodyText> : null}
          {classifierState.status === 'error' ? (
            <BodyText tone="danger">{t('model.loadError', { message: classifierState.errorMessage })}</BodyText>
          ) : null}
          <View style={styles.switchRow}>
            <BodyText style={styles.switchLabel}>{t('model.useGpu')}</BodyText>
            <Switch
              value={requestedAccelerator === 'gpu'}
              onValueChange={(shouldUseGpu) => setRequestedAccelerator(shouldUseGpu ? 'gpu' : 'cpu')}
              disabled={isListening}
              accessibilityLabel={t('model.useGpu')}
              trackColor={{ true: themePalette.accent, false: themePalette.border }}
            />
          </View>
          <BodyText tone="secondary" style={styles.smallText}>
            {classifier?.acceleratorFallbackReason ? t('model.gpuFallback') : t('model.useGpuHelp')}
          </BodyText>
          <AppButton label={t('model.delete')} variant="secondary" onPress={handleDeleteModelPress} />
        </Card>
      ) : (
        <Card>
          <BodyText>{t('model.missing', { megabytes: approximateModelMegabytes })}</BodyText>
          {isDownloading ? (
            <>
              <BodyText tone="secondary">
                {!downloadProgress
                  ? t('model.downloadStarting')
                  : downloadProgress.stage === 'verifying'
                    ? t('model.verifying')
                    : t('model.downloading', {
                        percent: Math.round(downloadFraction * 100),
                        downloaded: megabytesText(downloadProgress.bytesWritten),
                        total: megabytesText(downloadProgress.totalBytes),
                      })}
              </BodyText>
              <ProgressBar fraction={downloadFraction} color={themePalette.accent} trackColor={themePalette.border} />
              <AppButton label={t('model.cancel')} variant="secondary" onPress={cancelDownload} />
            </>
          ) : (
            <AppButton
              label={t('model.download')}
              onPress={() => void handleDownloadPress()}
              isBusy={downloadState.status === 'fetching-manifest'}
            />
          )}
          {downloadState.status === 'fetching-manifest' ? (
            <BodyText tone="secondary">{t('model.fetchingManifest')}</BodyText>
          ) : null}
          {downloadState.status === 'error' ? (
            <BodyText tone="danger">{t('model.downloadError', { message: downloadState.errorMessage })}</BodyText>
          ) : null}
        </Card>
      )}

      {classifier ? (
        <>
          <AppButton
            label={isListening ? t('listen.stop') : t('listen.start')}
            variant={isListening ? 'danger' : 'primary'}
            onPress={isListening ? handleStopListening : handleStartListening}
          />
          <BodyText tone="secondary" style={styles.smallText}>
            {t('listen.keepAwake')}
          </BodyText>
          {listenerState.status === 'starting' ? <BodyText tone="secondary">{t('listen.starting')}</BodyText> : null}
          {listenerState.status === 'listening' ? (
            <BodyText tone="secondary">
              {t('listen.listening', {
                sampleRate: listenerState.inputSampleRateHz,
                hop: String(latestWindow?.hopSeconds ?? 2.5).replace('.', ','),
              })}
            </BodyText>
          ) : null}
          {listenerState.status === 'listening' && !latestAnalysis ? (
            <BodyText tone="secondary">{t('listen.waitingFirst')}</BodyText>
          ) : null}
          {listenerState.status === 'error' ? (
            <BodyText tone="danger">{t('core:common.error', { message: listenerState.errorMessage })}</BodyText>
          ) : null}
          {wasInterrupted ? <BodyText tone="danger">{t('listen.interrupted')}</BodyText> : null}
          {analysisErrorMessage ? (
            <BodyText tone="danger">{t('listen.analysisError', { message: analysisErrorMessage })}</BodyText>
          ) : null}
        </>
      ) : null}

      {manifest && (latestAnalysis || isListening) ? (
        <>
          <SectionTitle>{t('results.title')}</SectionTitle>
          {!latestAnalysis ? (
            <BodyText tone="secondary">{t('results.nothingYet')}</BodyText>
          ) : (
            <Card>
              {latestAnalysis.loggingDecision.kind === 'human-voice' ? (
                <BodyText tone="danger">{t('results.humanVoice')}</BodyText>
              ) : (
                <>
                  {latestAnalysis.topClasses.map((rankedClass) => {
                    const soundClass = manifest.classes[rankedClass.classIndex];
                    return soundClass ? (
                      <ClassResultRow
                        key={rankedClass.classIndex}
                        soundClass={soundClass}
                        score={rankedClass.score}
                        displayName={displayNameFor(soundClass, appLocale)}
                        confidenceText={t(`results.confidence.${confidenceLevelFor(rankedClass.score)}`)}
                        scoreText={t('results.score', { score: rankedClass.score.toFixed(1) })}
                        soundKindText={t('results.soundKind')}
                      />
                    ) : null;
                  })}
                  {latestAnalysis.loggingDecision.kind === 'log' ? (
                    <BodyText tone="accent">{t('results.logged')}</BodyText>
                  ) : null}
                </>
              )}
              {latestWindow && latestWindow.levelDecibels < quietLevelDecibels ? (
                <BodyText tone="secondary" style={styles.smallText}>
                  {t('listen.quiet', { level: Math.round(latestWindow.levelDecibels) })}
                </BodyText>
              ) : null}
              {latestWindow && classifier ? (
                <BodyText tone="secondary" style={styles.smallText}>
                  {t('listen.timing', {
                    total: Math.round(latestWindow.analysisMilliseconds),
                    resample: Math.round(latestWindow.resampleMilliseconds),
                    model: Math.round(latestWindow.classification.inferenceMilliseconds),
                    accelerator: t(`accelerator.${classifier.activeAccelerator}`),
                  })}
                </BodyText>
              ) : null}
            </Card>
          )}
          <BodyText tone="secondary" style={styles.smallText}>
            {t('results.scoreHelp', { possible: possibleMinimumScore, probable: probableMinimumScore })}
          </BodyText>
          {latestWindow && latestAnalysis?.loggingDecision.kind !== 'human-voice' ? (
            <>
              <SectionTitle>{t('results.spectrogramTitle')}</SectionTitle>
              <MelSpectrogramView
                melSpectrogram={latestWindow.classification.melSpectrogram}
                frameCount={latestWindow.classification.spectrogramFrameCount}
                melBinCount={latestWindow.classification.melBinCount}
                height={140}
                horizontalLabels={['0 s', `${latestWindow.windowSeconds} s`]}
                accessibilityLabel={t('results.spectrogramAccessibility')}
              />
            </>
          ) : null}
        </>
      ) : null}

      {sessionSummary && !isListening && sessionSummary.analyzedWindowCount > 0 ? (
        <>
          <SectionTitle>{t('session.title')}</SectionTitle>
          <BodyText tone="secondary">
            {t('session.summary', {
              windows: sessionSummary.analyzedWindowCount,
              logged: sessionSummary.loggedDetectionCount,
              voice: sessionSummary.humanVoiceWindowCount,
            })}
          </BodyText>
          {sessionSummary.speciesTallies.length > 0 ? (
            <BodyText>{formatSpeciesSummary(sessionSummary.speciesTallies, commonNameForLabel)}</BodyText>
          ) : null}
          <AppButton label={t('session.save')} onPress={() => void handleSaveSession()} isBusy={isSaving} />
        </>
      ) : null}

      <SectionTitle>{t('log.title')}</SectionTitle>
      <BodyText tone="secondary" style={styles.smallText}>
        {t('log.explanation')}
      </BodyText>
      <View style={styles.switchRow}>
        <BodyText style={styles.switchLabel}>{t('log.useLocation')}</BodyText>
        <Switch
          value={isLocationEnabled}
          onValueChange={(shouldUseLocation) => void handleLocationToggle(shouldUseLocation)}
          accessibilityLabel={t('log.useLocation')}
          trackColor={{ true: themePalette.accent, false: themePalette.border }}
        />
      </View>
      <BodyText tone={isLocationDenied ? 'danger' : 'secondary'} style={styles.smallText}>
        {isLocationDenied ? t('log.locationDenied') : t('log.useLocationHelp')}
      </BodyText>
      {logStatistics ? (
        <BodyText>
          {t('log.statistics', {
            detections: logStatistics.detectionCount,
            species: logStatistics.distinctSpeciesCount,
          })}
        </BodyText>
      ) : null}
      {recentDetections.length === 0 ? (
        <BodyText tone="secondary">{t('log.empty')}</BodyText>
      ) : (
        <Card>
          <BodyText tone="secondary">{t('log.recent')}</BodyText>
          {recentDetections.map((detectionRecord) => (
            <View key={detectionRecord.id} style={styles.detectionRow}>
              <BodyText style={styles.detectionTime}>{localTimeText(detectionRecord.detectedAtIso)}</BodyText>
              <BodyText style={styles.detectionName} numberOfLines={1}>
                {commonNameForLabel(detectionRecord.speciesLabel)}
              </BodyText>
              <BodyText style={styles.detectionScore}>{detectionRecord.speciesScore.toFixed(1)}</BodyText>
            </View>
          ))}
        </Card>
      )}
      {logStatistics && logStatistics.detectionCount > 0 ? (
        <>
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton label={t('log.exportJsonl')} variant="secondary" onPress={() => void handleExport('jsonl')} />
            </View>
            <View style={styles.buttonCell}>
              <AppButton label={t('log.exportCsv')} variant="secondary" onPress={() => void handleExport('csv')} />
            </View>
          </View>
          <AppButton label={t('log.delete')} variant="danger" onPress={handleDeleteLogPress} />
        </>
      ) : null}
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}

      <BodyText tone="secondary" style={styles.smallText}>
        {t('disclaimer')}
      </BodyText>
    </ScreenContainer>
  );
}

function ProgressBar({ fraction, color, trackColor }: { fraction: number; color: string; trackColor: string }) {
  return (
    <View style={[styles.barTrack, { backgroundColor: trackColor }]}>
      <View style={[styles.barFill, { backgroundColor: color, width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }]} />
    </View>
  );
}

function ClassResultRow({
  soundClass,
  score,
  displayName,
  confidenceText,
  scoreText,
  soundKindText,
}: {
  soundClass: SoundClass;
  score: number;
  displayName: string;
  confidenceText: string;
  scoreText: string;
  soundKindText: string;
}) {
  const themePalette = useThemePalette();
  const confidenceLevel = confidenceLevelFor(score);
  const barColor =
    confidenceLevel === 'probable'
      ? themePalette.success
      : confidenceLevel === 'possible'
        ? themePalette.accent
        : themePalette.textSecondary;
  const isSpecies = soundClass.kind === 'species';
  const secondaryName = isSpecies ? soundClass.label : soundKindText;
  return (
    <View style={styles.resultRow}>
      <View style={styles.resultHeader}>
        <BodyText style={styles.resultName} numberOfLines={1}>
          {displayName}
        </BodyText>
        <BodyText tone="secondary" style={styles.resultScore}>{`${confidenceText} · ${scoreText}`}</BodyText>
      </View>
      {secondaryName !== displayName ? (
        <BodyText tone="secondary" style={isSpecies ? styles.scientificName : styles.smallText}>
          {secondaryName}
        </BodyText>
      ) : null}
      <ProgressBar fraction={confidenceBarFraction(score)} color={barColor} trackColor={themePalette.border} />
    </View>
  );
}

const styles = StyleSheet.create({
  emphasis: { fontWeight: '600' },
  smallText: { fontSize: 13 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchLabel: { flex: 1 },
  barTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  resultRow: { gap: 2, paddingVertical: 4 },
  resultHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  resultName: { flex: 1, fontWeight: '600' },
  resultScore: { fontSize: 13, fontVariant: ['tabular-nums'] },
  scientificName: { fontSize: 13, fontStyle: 'italic' },
  detectionRow: { flexDirection: 'row', gap: 8 },
  detectionTime: { fontVariant: ['tabular-nums'] },
  detectionName: { flex: 1 },
  detectionScore: { fontVariant: ['tabular-nums'] },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
});
