import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, Switch, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { type GeoLocation, getLocationForMeasurement } from '@/core/sensors/adapters/location';
import { useKeepScreenOnWhile } from '@/core/useKeepScreenOnWhile';
import { useStopWhenAppInactive } from '@/core/useStopWhenAppInactive';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { ChipSelector } from './ChipSelector';
import {
  confidenceBarFraction,
  confidenceLevelFor,
  decideDetectionLogging,
  displayNameFor,
  type LoggingDecision,
  possibleMinimumScore,
  probableMinimumScore,
  topScoringClasses,
} from './classification';
import {
  type CustomMatchingResult,
  type CustomSoundSensitivity,
  formatCustomSoundsJsonLines,
  matchCustomClasses,
  type PreparedCustomClass,
  similarityText,
  similarityThresholdBySensitivity,
} from './customSounds';
import { CustomSoundsPanel } from './CustomSoundsPanel';
import {
  createCustomSoundClass,
  deleteCustomSoundClass,
  deleteLatestCustomSoundExample,
  insertCustomSoundExample,
  renameCustomSoundClass,
} from './customSoundStore';
import { DetectionLogPanel } from './DetectionLogPanel';
import {
  type DetectionRecord,
  encodeFloat16LittleEndian,
  formatDetectionsCsv,
  formatDetectionsJsonLines,
  type NewDetectionRecord,
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
import {
  type AdjustedRankedClass,
  type ClassPenalties,
  computeClassPenalties,
  occurrenceContextFor,
  offSeasonPenalty,
  outOfAreaPenalty,
  plausibilityPenalty,
  rankClassesWithPenalties,
  type SpeciesPlausibility,
} from './occurrenceFilter';
import type { WildlifeSoundsMeasurementValues } from './schema';
import { SessionPanel } from './SessionPanel';
import { appendSessionDetections, type SessionDetection, sessionDetectionsForWindow } from './sessionTimeline';
import { shareDetectionExport, type DetectionExportKind } from './shareDetectionFiles';
import { useCustomSounds } from './useCustomSounds';
import { useOccurrenceData } from './useOccurrenceData';
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
/**
 * Un ejemplo de «Tus sonidos» tiene que empezar después de pulsar «Grabar»; se admite este margen
 * porque la hora de la ventana se toma al acabar de recibir el audio, no del reloj del micrófono.
 */
const enrollmentStartToleranceMilliseconds = 300;

type ScreenTab = 'listen' | 'session' | 'custom' | 'log';
const screenTabs: readonly ScreenTab[] = ['listen', 'session', 'custom', 'log'];

interface LatestAnalysis {
  topClasses: AdjustedRankedClass[];
  loggingDecision: LoggingDecision;
  analyzedWindow: AnalyzedWindow;
  customMatching: CustomMatchingResult | null;
}

interface PendingEnrollment {
  classId: number;
  className: string;
  requestedAt: number;
}

interface RoundedLocation {
  latitude: number;
  longitude: number;
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

export function WildlifeSoundsScreen({ saveMeasurement }: InstrumentScreenProps<WildlifeSoundsMeasurementValues>) {
  const { t, i18n } = useTranslation(wildlifeSoundsInstrumentId);
  const themePalette = useThemePalette();
  const appLocale = i18n.language;
  const [activeTab, setActiveTab] = useState<ScreenTab>('listen');

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
  const [sessionDetections, setSessionDetections] = useState<SessionDetection[]>([]);
  const [sessionEndTimestamp, setSessionEndTimestamp] = useState<number | null>(null);
  const [analysisErrorMessage, setAnalysisErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const [isLocationEnabled, setIsLocationEnabled] = useState(false);
  const [isLocationDenied, setIsLocationDenied] = useState(false);
  const cachedLocationRef = useRef<{ location: GeoLocation | undefined; fetchedAt: number } | null>(null);

  // --- Filtro por lugar y época ---
  const [isOccurrenceFilterEnabled, setIsOccurrenceFilterEnabled] = useState(true);
  const [filterLocation, setFilterLocation] = useState<RoundedLocation | null>(null);
  const [currentMonthIndex] = useState(() => new Date().getMonth());
  const { occurrenceState, retryOccurrenceDownload } = useOccurrenceData(installedModel?.manifest ?? null);
  const occurrenceData = occurrenceState.status === 'ready' ? occurrenceState.occurrenceData : null;
  const occurrenceContext = useMemo(
    () =>
      occurrenceData && filterLocation
        ? occurrenceContextFor(occurrenceData, filterLocation.latitude, filterLocation.longitude, currentMonthIndex)
        : null,
    [occurrenceData, filterLocation, currentMonthIndex],
  );
  const isFilterApplied = isOccurrenceFilterEnabled && isLocationEnabled && occurrenceContext?.status === 'active';
  const classPenalties: ClassPenalties | null = useMemo(
    () =>
      isFilterApplied && occurrenceData && occurrenceContext && manifest
        ? computeClassPenalties(occurrenceData, occurrenceContext, manifest.classes)
        : null,
    [isFilterApplied, occurrenceData, occurrenceContext, manifest],
  );

  // --- Tus sonidos ---
  const {
    targetClasses,
    backgroundClass,
    library: customSoundLibrary,
    exampleCountByClassId,
    preparedClasses,
    libraryErrorMessage,
    refreshLibrary,
  } = useCustomSounds();
  const [customSensitivity, setCustomSensitivity] = useState<CustomSoundSensitivity>('normal');
  const [pendingEnrollment, setPendingEnrollment] = useState<PendingEnrollment | null>(null);
  const [isEnrollmentOnly, setIsEnrollmentOnly] = useState(false);
  const [customStatusMessage, setCustomStatusMessage] = useState<string | null>(null);

  // El análisis de cada ventana llega por un callback: lee lo que cambia desde referencias.
  const isLocationEnabledRef = useRef(isLocationEnabled);
  const classPenaltiesRef = useRef<ClassPenalties | null>(classPenalties);
  const preparedClassesRef = useRef<PreparedCustomClass[]>(preparedClasses);
  const similarityThresholdRef = useRef(similarityThresholdBySensitivity[customSensitivity]);
  const pendingEnrollmentRef = useRef<PendingEnrollment | null>(pendingEnrollment);
  const isEnrollmentOnlyRef = useRef(isEnrollmentOnly);
  useEffect(() => {
    isLocationEnabledRef.current = isLocationEnabled;
    classPenaltiesRef.current = classPenalties;
    preparedClassesRef.current = preparedClasses;
    similarityThresholdRef.current = similarityThresholdBySensitivity[customSensitivity];
    pendingEnrollmentRef.current = pendingEnrollment;
    isEnrollmentOnlyRef.current = isEnrollmentOnly;
  }, [isLocationEnabled, classPenalties, preparedClasses, customSensitivity, pendingEnrollment, isEnrollmentOnly]);

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

  /** Ubicación reciente (se reutiliza un minuto). */
  const readRecentLocation = useCallback(async (): Promise<GeoLocation | undefined> => {
    const cachedLocation = cachedLocationRef.current;
    if (cachedLocation && Date.now() - cachedLocation.fetchedAt < locationReuseMilliseconds) return cachedLocation.location;
    const location = await getLocationForMeasurement({ maxAgeMilliseconds: 5 * 60_000 });
    cachedLocationRef.current = { location, fetchedAt: Date.now() };
    return location;
  }, []);

  const updateFilterLocation = useCallback((location: GeoLocation | undefined) => {
    if (location) {
      setFilterLocation({ latitude: roundCoordinate(location.latitude), longitude: roundCoordinate(location.longitude) });
    }
  }, []);

  // Con la ubicación activada, se pide al activarla y al empezar a escuchar (para el filtro).
  useEffect(() => {
    if (!isLocationEnabled) return;
    let isEffectActive = true;
    readRecentLocation()
      .then((location) => {
        if (isEffectActive) updateFilterLocation(location);
      })
      .catch(() => undefined);
    return () => {
      isEffectActive = false;
    };
  }, [isLocationEnabled, isListening, readRecentLocation, updateFilterLocation]);

  const stopEnrollmentListening = useCallback(() => {
    isEnrollmentOnlyRef.current = false;
    setIsEnrollmentOnly(false);
    setIsListening(false);
  }, []);

  /** Guarda la ventana como ejemplo de la clase que se está enseñando. */
  const saveEnrollmentWindow = useCallback(
    (enrollment: PendingEnrollment, analyzedWindow: AnalyzedWindow, hasHumanVoice: boolean, modelVersion: string) => {
      pendingEnrollmentRef.current = null;
      setPendingEnrollment(null);
      if (isEnrollmentOnlyRef.current) stopEnrollmentListening();
      if (hasHumanVoice) {
        // Privacidad: tampoco se guarda el embedding de una voz como ejemplo.
        setCustomStatusMessage(t('custom.rejectedVoice'));
        return;
      }
      const isQuiet = analyzedWindow.levelDecibels < quietLevelDecibels;
      void insertCustomSoundExample(
        enrollment.classId,
        new Date(analyzedWindow.windowEndTimestamp).toISOString(),
        modelVersion,
        encodeFloat16LittleEndian(analyzedWindow.classification.embedding),
      )
        .then(refreshLibrary)
        .then(() => setCustomStatusMessage(t(isQuiet ? 'custom.savedQuiet' : 'custom.saved', { name: enrollment.className })))
        .catch((insertError: unknown) => setCustomStatusMessage(t('core:common.error', { message: String(insertError) })));
    },
    [refreshLibrary, stopEnrollmentListening, t],
  );

  const handleWindowAnalyzed = useCallback(
    (analyzedWindow: AnalyzedWindow) => {
      if (!classifier) return;
      const { classes, modelVersion } = classifier.manifest;
      const { logits, embedding } = analyzedWindow.classification;
      const topClasses = rankClassesWithPenalties(logits, classPenaltiesRef.current, displayedClassCount);
      const loggingDecision = decideDetectionLogging(topClasses, classes);
      const hasHumanVoice = loggingDecision.kind === 'human-voice';
      const customMatching =
        !hasHumanVoice && preparedClassesRef.current.length > 0
          ? matchCustomClasses(embedding, preparedClassesRef.current, similarityThresholdRef.current)
          : null;
      setLatestAnalysis({ topClasses, loggingDecision, analyzedWindow, customMatching });
      setAnalysisErrorMessage(null);

      // Se lee antes de guardar el ejemplo, que puede apagar la escucha solo-para-grabar.
      const wasEnrollmentOnly = isEnrollmentOnlyRef.current;
      const enrollment = pendingEnrollmentRef.current;
      const windowStartTimestamp = analyzedWindow.windowEndTimestamp - analyzedWindow.windowSeconds * 1000;
      if (enrollment && windowStartTimestamp >= enrollment.requestedAt - enrollmentStartToleranceMilliseconds) {
        saveEnrollmentWindow(enrollment, analyzedWindow, hasHumanVoice, modelVersion);
      }
      // Escuchando solo para grabar un ejemplo: ni sesión ni registro.
      if (wasEnrollmentOnly) return;

      const matchedCustomClasses = customMatching?.classMatches.filter((classMatch) => classMatch.isMatch) ?? [];
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
      const windowDetections = sessionDetectionsForWindow(
        topClasses,
        classes,
        matchedCustomClasses,
        analyzedWindow.windowEndTimestamp,
        hasHumanVoice,
      );
      if (windowDetections.length > 0) {
        setSessionDetections((previousDetections) => appendSessionDetections(previousDetections, windowDetections));
      }
      if (loggingDecision.kind !== 'log' && matchedCustomClasses.length === 0) return;

      void (async () => {
        try {
          const location = isLocationEnabledRef.current ? await readRecentLocation() : undefined;
          updateFilterLocation(location);
          // En el registro va lo que dice el modelo (top y puntuaciones sin el filtro de lugar y
          // época), para que los datos se puedan reinterpretar; el filtro solo decide qué especie se apunta.
          const modelTopClasses = topScoringClasses(logits, displayedClassCount);
          const sharedFields: Omit<NewDetectionRecord, 'speciesLabel' | 'speciesScore' | 'isCustomClass'> = {
            detectedAtIso: new Date(analyzedWindow.windowEndTimestamp).toISOString(),
            durationSeconds: analyzedWindow.windowSeconds,
            latitude: location ? roundCoordinate(location.latitude) : null,
            longitude: location ? roundCoordinate(location.longitude) : null,
            topClasses: modelTopClasses.map((rankedClass) => ({
              label: classes[rankedClass.classIndex]?.label ?? String(rankedClass.classIndex),
              score: roundScore(rankedClass.score),
            })),
            modelVersion,
            embeddingFloat16Bytes: encodeFloat16LittleEndian(embedding),
          };
          if (loggingDecision.kind === 'log') {
            await insertDetection({
              ...sharedFields,
              speciesLabel,
              speciesScore: roundScore(logits[loggingDecision.speciesClassIndex] ?? loggingDecision.speciesScore),
              isCustomClass: false,
            });
          }
          for (const customMatch of matchedCustomClasses) {
            await insertDetection({
              ...sharedFields,
              speciesLabel: customMatch.name,
              speciesScore: roundScore(customMatch.similarity),
              isCustomClass: true,
            });
          }
          await refreshLog();
        } catch (insertError) {
          setStatusMessage(t('log.saveError', { message: String(insertError) }));
        }
      })();
    },
    [classifier, readRecentLocation, refreshLog, saveEnrollmentWindow, t, updateFilterLocation],
  );

  const handleAnalysisError = useCallback((errorMessage: string) => setAnalysisErrorMessage(errorMessage), []);

  const { listenerState } = useWildlifeListener({
    isListening,
    classifier,
    onWindowAnalyzed: handleWindowAnalyzed,
    onAnalysisError: handleAnalysisError,
  });
  useKeepScreenOnWhile(isListening, wildlifeSoundsInstrumentId);
  const isSessionListening = isListening && !isEnrollmentOnly;

  // Al tapar la pantalla o pasar a segundo plano, la escucha se da por terminada y se avisa.
  const releaseNothing = useCallback(() => undefined, []);
  useStopWhenAppInactive(() => {
    if (!isListening) return;
    setIsListening(false);
    setPendingEnrollment(null);
    setIsEnrollmentOnly(false);
    if (isEnrollmentOnly) return;
    setSessionEndTimestamp(Date.now());
    setWasInterrupted(true);
  }, releaseNothing);

  function handleStartListening() {
    setStatusMessage(null);
    setWasInterrupted(false);
    setAnalysisErrorMessage(null);
    setLatestAnalysis(null);
    setSessionSummary(createListeningSessionSummary(Date.now()));
    setSessionDetections([]);
    setSessionEndTimestamp(null);
    // Si ya se escuchaba para grabar un ejemplo, la escucha sigue y pasa a ser una sesión.
    isEnrollmentOnlyRef.current = false;
    setIsEnrollmentOnly(false);
    setIsListening(true);
  }

  function handleStopListening() {
    setIsListening(false);
    setPendingEnrollment(null);
    if (!isEnrollmentOnly) setSessionEndTimestamp(Date.now());
    setIsEnrollmentOnly(false);
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

  // --- Tus sonidos: acciones ---

  /** Graba el próximo trozo de 5 s como ejemplo. Si no se estaba escuchando, escucha solo para eso. */
  function startEnrollment(classId: number, className: string) {
    if (!classifier) return;
    setCustomStatusMessage(null);
    setPendingEnrollment({ classId, className, requestedAt: Date.now() });
    if (!isListening) {
      isEnrollmentOnlyRef.current = true;
      setIsEnrollmentOnly(true);
      setWasInterrupted(false);
      setIsListening(true);
    }
  }

  function handleCancelEnrollment() {
    pendingEnrollmentRef.current = null;
    setPendingEnrollment(null);
    if (isEnrollmentOnly) stopEnrollmentListening();
  }

  function runLibraryChange(libraryChange: () => Promise<unknown>) {
    setCustomStatusMessage(null);
    void libraryChange()
      .then(refreshLibrary)
      .catch((changeError: unknown) => setCustomStatusMessage(t('core:common.error', { message: String(changeError) })));
  }

  async function handleRecordBackground() {
    try {
      const backgroundClassId = backgroundClass?.id ?? (await createCustomSoundClass(t('custom.backgroundName'), true));
      if (!backgroundClass) await refreshLibrary();
      startEnrollment(backgroundClassId, t('custom.backgroundName'));
    } catch (createError) {
      setCustomStatusMessage(t('core:common.error', { message: String(createError) }));
    }
  }

  async function handleExportCustomSounds() {
    setCustomStatusMessage(null);
    try {
      const fileContents = formatCustomSoundsJsonLines(customSoundLibrary.customClasses, customSoundLibrary.examples);
      const dateText = new Date().toISOString().slice(0, 10);
      await shareDetectionExport(`quien-canta-mis-sonidos-${dateText}.jsonl`, fileContents, 'jsonl', t('custom.shareTitle'));
    } catch (exportError) {
      setCustomStatusMessage(t('core:common.error', { message: String(exportError) }));
    }
  }

  // --- Textos derivados ---

  function occurrenceFilterStatus(): { text: string; tone: 'secondary' | 'accent' | 'danger' } {
    if (!isOccurrenceFilterEnabled) return { text: t('filter.off'), tone: 'secondary' };
    if (!isLocationEnabled) return { text: t('filter.needsLocation'), tone: 'secondary' };
    if (occurrenceState.status === 'absent') return { text: t('filter.needsModel'), tone: 'secondary' };
    if (occurrenceState.status === 'loading') return { text: t('filter.loading'), tone: 'secondary' };
    if (occurrenceState.status === 'unavailable') return { text: t('filter.unavailable'), tone: 'danger' };
    if (!occurrenceContext) return { text: t('filter.waitingLocation'), tone: 'secondary' };
    if (occurrenceContext.status === 'outside-grid') return { text: t('filter.outsideGrid'), tone: 'secondary' };
    if (occurrenceContext.status === 'no-cell-data') return { text: t('filter.noCellData'), tone: 'secondary' };
    return { text: t('filter.active', { count: classPenalties?.penalizedClassCount ?? 0 }), tone: 'accent' };
  }

  function plausibilityMarkText(rankedClass: AdjustedRankedClass): string | null {
    const plausibility: SpeciesPlausibility | undefined = rankedClass.plausibility;
    if (!plausibility) return null;
    const reasons = [
      plausibility.isUnlikelyHere ? t('filter.markUnlikelyHere') : null,
      plausibility.isOffSeason ? t('filter.markOffSeason') : null,
    ].filter((reason): reason is string => reason !== null);
    return `${reasons.join(' · ')} (−${plausibilityPenalty(plausibility)}; ${t('filter.modelScore', {
      score: rankedClass.rawScore.toFixed(1),
    })})`;
  }

  const isDownloading = downloadState.status === 'downloading';
  const downloadProgress = downloadState.status === 'downloading' ? downloadState.progress : null;
  const downloadFraction =
    downloadProgress && downloadProgress.totalBytes > 0 ? downloadProgress.bytesWritten / downloadProgress.totalBytes : 0;
  const latestWindow = latestAnalysis?.analyzedWindow ?? null;
  const filterStatus = occurrenceFilterStatus();
  const customMatching = latestAnalysis?.customMatching ?? null;
  const matchedCustomClasses = customMatching?.classMatches.filter((classMatch) => classMatch.isMatch) ?? [];
  const closestCustomClass = customMatching?.classMatches[0] ?? null;
  const sessionTimelineEnd =
    sessionEndTimestamp ?? latestWindow?.windowEndTimestamp ?? sessionSummary?.sessionStartTimestamp ?? 0;

  function tabLabel(tab: ScreenTab): string {
    if (tab === 'session' && isSessionListening && sessionDetections.length > 0) return `${t('tabs.session')} ●`;
    if (tab === 'custom' && pendingEnrollment) return `${t('tabs.custom')} ●`;
    return t(`tabs.${tab}`);
  }

  return (
    <ScreenContainer>
      <BodyText tone="secondary">{t('intro')}</BodyText>
      <ChipSelector options={screenTabs} selectedOption={activeTab} labelFor={tabLabel} onSelect={setActiveTab} accessibilityRole="tab" />

      {activeTab === 'listen' ? (
        <>
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

          <SectionTitle>{t('filter.title')}</SectionTitle>
          <Card>
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
            <View style={styles.switchRow}>
              <BodyText style={styles.switchLabel}>{t('filter.enable')}</BodyText>
              <Switch
                value={isOccurrenceFilterEnabled}
                onValueChange={setIsOccurrenceFilterEnabled}
                accessibilityLabel={t('filter.enable')}
                trackColor={{ true: themePalette.accent, false: themePalette.border }}
              />
            </View>
            <BodyText tone={filterStatus.tone} style={styles.smallText}>
              {filterStatus.text}
            </BodyText>
            <BodyText tone="secondary" style={styles.smallText}>
              {t('filter.help', { areaPenalty: outOfAreaPenalty, seasonPenalty: offSeasonPenalty })}
            </BodyText>
            {isOccurrenceFilterEnabled && occurrenceState.status === 'unavailable' ? (
              <AppButton label={t('filter.retry')} variant="secondary" onPress={retryOccurrenceDownload} />
            ) : null}
          </Card>

          {classifier ? (
            <>
              <AppButton
                label={isSessionListening ? t('listen.stop') : t('listen.start')}
                variant={isSessionListening ? 'danger' : 'primary'}
                onPress={isSessionListening ? handleStopListening : handleStartListening}
              />
              <BodyText tone="secondary" style={styles.smallText}>
                {t('listen.keepAwake')}
              </BodyText>
              {pendingEnrollment ? <BodyText tone="accent">{t('custom.recording')}</BodyText> : null}
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
                <>
                  {customMatching && customMatching.classMatches.length > 0 ? (
                    <Card>
                      <BodyText style={styles.emphasis}>{t('results.customTitle')}</BodyText>
                      {matchedCustomClasses.map((classMatch) => (
                        <View key={classMatch.classId} style={styles.resultHeader}>
                          <BodyText tone="accent" style={styles.resultName} numberOfLines={1}>
                            {classMatch.name}
                          </BodyText>
                          <BodyText tone="secondary" style={styles.resultScore}>
                            {t('results.similarity', { similarity: similarityText(classMatch.similarity) })}
                          </BodyText>
                        </View>
                      ))}
                      {matchedCustomClasses.length === 0 && closestCustomClass ? (
                        <BodyText tone="secondary" style={styles.smallText}>
                          {t(closestCustomClass.isBeatenByBackground ? 'results.customBeatenByBackground' : 'results.customNone', {
                            name: closestCustomClass.name,
                            similarity: similarityText(closestCustomClass.similarity),
                          })}
                        </BodyText>
                      ) : null}
                    </Card>
                  ) : null}
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
                              plausibilityText={plausibilityMarkText(rankedClass)}
                            />
                          ) : null;
                        })}
                        {latestAnalysis.loggingDecision.kind === 'log' && !isEnrollmentOnly ? (
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
                </>
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
        </>
      ) : null}

      {activeTab === 'session' ? (
        sessionSummary ? (
          <>
            <BodyText tone="secondary">
              {t('session.summary', {
                windows: sessionSummary.analyzedWindowCount,
                logged: sessionSummary.loggedDetectionCount,
                voice: sessionSummary.humanVoiceWindowCount,
              })}
            </BodyText>
            <SessionPanel
              sessionDetections={sessionDetections}
              sessionStartTimestamp={sessionSummary.sessionStartTimestamp}
              sessionEndTimestamp={sessionTimelineEnd}
              commonNameForLabel={commonNameForLabel}
            />
            {!isSessionListening && sessionSummary.analyzedWindowCount > 0 ? (
              <AppButton label={t('session.save')} onPress={() => void handleSaveSession()} isBusy={isSaving} />
            ) : null}
          </>
        ) : (
          <BodyText tone="secondary">{t('sessionList.notStarted')}</BodyText>
        )
      ) : null}

      {activeTab === 'custom' ? (
        <>
          <CustomSoundsPanel
            targetClasses={targetClasses}
            backgroundClass={backgroundClass}
            exampleCountByClassId={exampleCountByClassId}
            sensitivity={customSensitivity}
            onSensitivityChange={setCustomSensitivity}
            enrollingClassId={pendingEnrollment?.classId ?? null}
            isModelReady={classifier !== null}
            onCreateClass={(className) => runLibraryChange(() => createCustomSoundClass(className, false))}
            onRecordExample={(classId) =>
              startEnrollment(classId, targetClasses.find((customClass) => customClass.id === classId)?.name ?? '')
            }
            onRecordBackground={() => void handleRecordBackground()}
            onCancelRecording={handleCancelEnrollment}
            onRemoveLatestExample={(classId) => runLibraryChange(() => deleteLatestCustomSoundExample(classId))}
            onRenameClass={(classId, newName) => runLibraryChange(() => renameCustomSoundClass(classId, newName))}
            onDeleteClass={(classId) => runLibraryChange(() => deleteCustomSoundClass(classId))}
            onExport={() => void handleExportCustomSounds()}
          />
          {customStatusMessage ? <BodyText tone="accent">{customStatusMessage}</BodyText> : null}
          {pendingEnrollment && listenerState.status === 'error' ? (
            <BodyText tone="danger">{t('core:common.error', { message: listenerState.errorMessage })}</BodyText>
          ) : null}
          {libraryErrorMessage ? (
            <BodyText tone="danger">{t('core:common.error', { message: libraryErrorMessage })}</BodyText>
          ) : null}
        </>
      ) : null}

      {activeTab === 'log' ? (
        <DetectionLogPanel
          logStatistics={logStatistics}
          recentDetections={recentDetections}
          commonNameForLabel={commonNameForLabel}
          onExport={(exportKind) => void handleExport(exportKind)}
          onDelete={handleDeleteLogPress}
        />
      ) : null}

      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      {activeTab !== 'custom' && customStatusMessage && pendingEnrollment === null ? (
        <BodyText tone="accent">{customStatusMessage}</BodyText>
      ) : null}

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
  plausibilityText,
}: {
  soundClass: SoundClass;
  score: number;
  displayName: string;
  confidenceText: string;
  scoreText: string;
  soundKindText: string;
  /** Marca del filtro de lugar y época, si la especie está penalizada. */
  plausibilityText: string | null;
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
          {plausibilityText ? `${displayName} ⚑` : displayName}
        </BodyText>
        <BodyText tone="secondary" style={styles.resultScore}>{`${confidenceText} · ${scoreText}`}</BodyText>
      </View>
      {secondaryName !== displayName ? (
        <BodyText tone="secondary" style={isSpecies ? styles.scientificName : styles.smallText}>
          {secondaryName}
        </BodyText>
      ) : null}
      {plausibilityText ? (
        <BodyText tone="secondary" style={styles.smallText}>
          {plausibilityText}
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
});
