import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Camera, type CameraFrameOutput } from 'react-native-vision-camera';

import { resolveActiveCalibration } from '@/core/calibration/calibrationService';
import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { deltaE2000 } from '@/processing/color/colorDifference';
import type { RegionColorStatistics } from '@/processing/color/regionSampling';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import { colorimeterInstrument } from '@instruments/colorimeter';
import { evaluateColorimeterFrame } from '@instruments/colorimeter/colorimeterEngine';
import {
  type ColorimeterCalibrationParameters,
  type ReferencePatch,
  referencePatchLabel,
} from '@instruments/colorimeter/referenceCards';

import {
  bestCapturePerRound,
  buildCapture,
  computeScoreboard,
  createHuntGame,
  currentTargetColorId,
  generateGameCode,
  heatBarFraction,
  type HeatLevel,
  heatLevelForDeltaE,
  type HuntCapture,
  type HuntGame,
  isNewPersonalRecord,
  maximumPlayerCount,
  parseGameCode,
  type PersonalRecord,
  recordTurnCapture,
  roundDurationSeconds,
} from './colorHuntGame';
import { findPaletteColor, nearestPaletteColor } from './huntPalette';
import { loadPersonalRecord, savePersonalRecord } from './huntStorage';
import type { ColorHuntMeasurementValues } from './schema';
import { crosshairSizeFraction, useCrosshairFrames } from './useCrosshairFrames';
import { useHuntCountdown } from './useHuntCountdown';
import {
  cardWithoutPatches,
  isUsableWhiteReference,
  pickWhiteReferencePatch,
  whiteBalanceCard,
} from './whiteBalance';

export const colorHuntInstrumentId = 'color-hunt';

type GamePhase = 'setup' | 'whiteBalance' | 'turnIntro' | 'hunting' | 'turnResult' | 'summary';

const previewHeight = 300;
const playerCountOptions: readonly number[] = Array.from({ length: maximumPlayerCount }, (_, index) => index + 1);

/** Colores de la barra «frío/caliente». La pista también va en texto y en ΔE numérico. */
const heatLevelColors: Record<HeatLevel, string> = {
  freezing: '#2563EB',
  cold: '#0EA5E9',
  warm: '#EAB308',
  hot: '#F97316',
  burning: '#EF4444',
  spotOn: '#B91C1C',
};

interface WhiteReference {
  measuredRegion: RegionColorStatistics;
  patch: ReferencePatch;
}

interface FinishedTurn {
  roundIndex: number;
  playerIndex: number;
  targetColorId: string;
  capture: HuntCapture;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function formatClock(remainingSeconds: number): string {
  const wholeSeconds = Math.max(0, Math.ceil(remainingSeconds));
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, '0')}`;
}

export function ColorHuntScreen({ saveMeasurement }: InstrumentScreenProps<ColorHuntMeasurementValues>) {
  const { t } = useTranslation(colorHuntInstrumentId);
  const isCameraAllowed = useIsCameraAllowed();
  const { frameOutput, latestCrosshairRegion, resetAverage } = useCrosshairFrames();

  const [gamePhase, setGamePhase] = useState<GamePhase>('setup');
  const [playerCount, setPlayerCount] = useState(1);
  const [gameCodeText, setGameCodeText] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [game, setGame] = useState<HuntGame | null>(null);
  const [finishedTurn, setFinishedTurn] = useState<FinishedTurn | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [personalRecord, setPersonalRecord] = useState<PersonalRecord | null>(loadPersonalRecord);
  const [isNewRecordGame, setIsNewRecordGame] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Balance de blancos opcional: el parche más claro de la tarjeta calibrada en el colorímetro.
  const [whiteReferencePatch, setWhiteReferencePatch] = useState<ReferencePatch>(() => pickWhiteReferencePatch(null));
  const [isWhitePatchFromColorimeter, setIsWhitePatchFromColorimeter] = useState(false);
  const [whiteReference, setWhiteReference] = useState<WhiteReference | null>(null);
  const [whiteBalanceMessage, setWhiteBalanceMessage] = useState<string | null>(null);
  const whiteReferencePatchName = referencePatchLabel(whiteReferencePatch, (translationKey) => t(translationKey));

  useEffect(() => {
    let isCurrentLoad = true;
    resolveActiveCalibration(colorimeterInstrument)
      .then((resolvedCalibration) => {
        if (!isCurrentLoad) return;
        const colorimeterParameters = resolvedCalibration.parameters as ColorimeterCalibrationParameters | null;
        setWhiteReferencePatch(pickWhiteReferencePatch(colorimeterParameters?.card));
        setIsWhitePatchFromColorimeter(resolvedCalibration.activeProfile !== null);
      })
      .catch(() => {
        // Sin calibración legible se juega igual, con el folio blanco como referencia.
      });
    return () => {
      isCurrentLoad = false;
    };
  }, []);

  // Al salir de la app o de la pantalla en mitad de un turno, la partida queda en pausa.
  if (gamePhase === 'hunting' && !isCameraAllowed && !isPaused) setIsPaused(true);

  const crosshairReading = useMemo(() => {
    if (!latestCrosshairRegion) return null;
    return whiteReference
      ? evaluateColorimeterFrame(
          latestCrosshairRegion,
          [whiteReference.measuredRegion],
          whiteBalanceCard(whiteReference.patch),
          null,
        )
      : evaluateColorimeterFrame(latestCrosshairRegion, [], cardWithoutPatches, null);
  }, [latestCrosshairRegion, whiteReference]);

  const targetColorId = game ? currentTargetColorId(game) : null;
  const targetColor = targetColorId ? findPaletteColor(targetColorId) : undefined;
  const deltaEToTarget =
    crosshairReading && targetColor ? deltaE2000(crosshairReading.sampleLab, targetColor.lab) : null;

  const captureCandidateRef = useRef<{ hexColor: string; deltaE: number } | null>(null);
  useEffect(() => {
    captureCandidateRef.current =
      crosshairReading && deltaEToTarget !== null
        ? { hexColor: crosshairReading.correctedSampleHex, deltaE: deltaEToTarget }
        : null;
  }, [crosshairReading, deltaEToTarget]);

  function finishGame(finishedGame: HuntGame) {
    const topTotalPoints = computeScoreboard(finishedGame)[0]?.totalPoints ?? 0;
    const isRecord = isNewPersonalRecord(personalRecord, topTotalPoints);
    setIsNewRecordGame(isRecord);
    if (isRecord) setPersonalRecord(savePersonalRecord(topTotalPoints));
  }

  function finishTurn(turnRemainingSeconds: number) {
    if (!game || game.isFinished || gamePhase !== 'hunting' || !targetColorId) return;
    const capture = buildCapture(captureCandidateRef.current, turnRemainingSeconds);
    const updatedGame = recordTurnCapture(game, capture);
    setFinishedTurn({
      roundIndex: game.currentRoundIndex,
      playerIndex: game.currentPlayerIndex,
      targetColorId,
      capture,
    });
    setGame(updatedGame);
    setIsTorchOn(false);
    setGamePhase('turnResult');
    if (updatedGame.isFinished) finishGame(updatedGame);
  }

  const isCountdownRunning = gamePhase === 'hunting' && isCameraAllowed && !isPaused;
  const { remainingSeconds, resetCountdown, readRemainingSeconds } = useHuntCountdown(
    roundDurationSeconds,
    isCountdownRunning,
    () => finishTurn(0),
  );

  function startGame(gameCode: number, gamePlayerCount: number) {
    setGame(createHuntGame({ gameCode, playerCount: gamePlayerCount }));
    setFinishedTurn(null);
    setIsNewRecordGame(false);
    setStatusMessage(null);
    setGamePhase('turnIntro');
  }

  function handleStartFromSetup() {
    const trimmedCodeText = gameCodeText.trim();
    const typedGameCode = trimmedCodeText ? parseGameCode(trimmedCodeText) : generateGameCode();
    if (typedGameCode === null) {
      setSetupError(t('setup.invalidGameCode'));
      return;
    }
    setSetupError(null);
    startGame(typedGameCode, playerCount);
  }

  function handleStartTurn() {
    resetCountdown();
    resetAverage();
    setIsPaused(false);
    setGamePhase('hunting');
  }

  function handleQuitGame() {
    setIsPaused(false);
    setIsTorchOn(false);
    setGame(null);
    setGamePhase('setup');
  }

  function handleFixWhite() {
    if (!latestCrosshairRegion || !isUsableWhiteReference(latestCrosshairRegion)) {
      setWhiteBalanceMessage(t('whiteBalance.tooDark'));
      return;
    }
    setWhiteReference({ measuredRegion: latestCrosshairRegion, patch: whiteReferencePatch });
    setWhiteBalanceMessage(null);
    setIsTorchOn(false);
    setGamePhase('setup');
  }

  async function handleSave() {
    if (!game) return;
    const scoreboard = computeScoreboard(game);
    const leaders = scoreboard.filter((entry) => entry.rank === 1);
    const roundBestCaptures = bestCapturePerRound(game);
    const capturedRounds = roundBestCaptures.flatMap((roundBest) =>
      roundBest.capture?.capturedHexColor && roundBest.capture.deltaE !== null
        ? [{ hexColor: roundBest.capture.capturedHexColor, deltaE: roundBest.capture.deltaE }]
        : [],
    );
    const bestOverallCapture = capturedRounds.reduce<{ hexColor: string; deltaE: number } | null>(
      (bestSoFar, candidate) => (!bestSoFar || candidate.deltaE < bestSoFar.deltaE ? candidate : bestSoFar),
      null,
    );
    setIsSaving(true);
    setStatusMessage(null);
    try {
      await saveMeasurement({
        values: {
          winnerTotalPoints: scoreboard[0]?.totalPoints ?? 0,
          winnerPlayerNumber: leaders.length === 1 ? leaders[0]!.playerIndex + 1 : 0,
          playerCount: game.playerCount,
          playerTotalPoints: Array.from(
            { length: game.playerCount },
            (_, playerIndex) => scoreboard.find((entry) => entry.playerIndex === playerIndex)?.totalPoints ?? 0,
          ),
          gameCode: game.gameCode,
          targetColors: game.targetColorIds.map((colorId) => findPaletteColor(colorId)?.hexColor ?? '-').join(' '),
          bestCapturedColors: roundBestCaptures.map((roundBest) => roundBest.capture?.capturedHexColor ?? '-').join(' '),
          bestRoundDeltaE: roundBestCaptures.map((roundBest) =>
            roundBest.capture?.deltaE !== null && roundBest.capture?.deltaE !== undefined
              ? roundTo(roundBest.capture.deltaE, 2)
              : -1,
          ),
          ...(bestOverallCapture
            ? { bestCaptureColor: bestOverallCapture.hexColor, bestCaptureDeltaE: roundTo(bestOverallCapture.deltaE, 2) }
            : {}),
          isWhiteBalanced: whiteReference !== null,
          isPersonalRecord: isNewRecordGame,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    } finally {
      setIsSaving(false);
    }
  }

  const playerLabel = (playerIndex: number) => t('player', { number: playerIndex + 1 });
  const colorName = (colorId: string) => t(`palette.${colorId}`);

  if (gamePhase === 'whiteBalance') {
    return (
      <ScreenContainer>
        <SectionTitle>{t('whiteBalance.title')}</SectionTitle>
        <CrosshairCamera
          frameOutput={frameOutput}
          isActive={isCameraAllowed}
          isTorchOn={isTorchOn}
          onCameraError={(message) => setWhiteBalanceMessage(t('core:common.error', { message }))}
        />
        <BodyText>{t('whiteBalance.aimHint', {
            patch: isWhitePatchFromColorimeter ? whiteReferencePatchName : t('whiteBalance.whitePaper'),
          })}</BodyText>
        {whiteBalanceMessage ? <BodyText tone="danger">{whiteBalanceMessage}</BodyText> : null}
        <AppButton label={t('whiteBalance.fix')} onPress={handleFixWhite} isDisabled={!latestCrosshairRegion} />
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton
              label={isTorchOn ? t('hunt.torchOff') : t('hunt.torchOn')}
              onPress={() => setIsTorchOn((wasTorchOn) => !wasTorchOn)}
              variant="secondary"
            />
          </View>
          <View style={styles.buttonCell}>
            <AppButton
              label={t('core:common.cancel')}
              onPress={() => {
                setIsTorchOn(false);
                setWhiteBalanceMessage(null);
                setGamePhase('setup');
              }}
              variant="secondary"
            />
          </View>
        </View>
      </ScreenContainer>
    );
  }

  if (gamePhase === 'setup' || !game) {
    return (
      <ScreenContainer>
        <BodyText>{t('intro')}</BodyText>
        <Card>
          <BodyText style={styles.cardTitle}>{t('setup.players')}</BodyText>
          <SegmentedChoice
            options={playerCountOptions}
            selectedOption={playerCount}
            labelFor={(optionCount) => String(optionCount)}
            accessibilityLabelFor={(optionCount) => `${t('setup.players')}: ${optionCount}`}
            onSelect={setPlayerCount}
          />
          <BodyText tone="secondary" style={styles.smallText}>
            {t('setup.playersHelp')}
          </BodyText>
          <BodyText style={styles.cardTitle}>{t('setup.gameCode')}</BodyText>
          <GameCodeInput value={gameCodeText} onChangeText={setGameCodeText} placeholder={t('setup.gameCodePlaceholder')} />
          <BodyText tone="secondary" style={styles.smallText}>
            {t('setup.gameCodeHelp')}
          </BodyText>
          {setupError ? <BodyText tone="danger">{setupError}</BodyText> : null}
        </Card>

        <Card>
          <BodyText style={styles.cardTitle}>{t('whiteBalance.title')}</BodyText>
          <BodyText tone="secondary" style={styles.smallText}>
            {t('whiteBalance.help')}
          </BodyText>
          <BodyText tone="secondary" style={styles.smallText}>
            {isWhitePatchFromColorimeter
              ? t('whiteBalance.fromColorimeter', { patch: whiteReferencePatchName })
              : t('whiteBalance.defaultReference')}
          </BodyText>
          <BodyText tone={whiteReference ? 'accent' : 'secondary'}>
            {whiteReference ? t('whiteBalance.applied') : t('whiteBalance.notApplied')}
          </BodyText>
          <View style={styles.buttonRow}>
            <View style={styles.buttonCell}>
              <AppButton
                label={t('whiteBalance.adjust')}
                onPress={() => {
                  resetAverage();
                  setWhiteBalanceMessage(null);
                  setGamePhase('whiteBalance');
                }}
                variant="secondary"
              />
            </View>
            {whiteReference ? (
              <View style={styles.buttonCell}>
                <AppButton label={t('whiteBalance.remove')} onPress={() => setWhiteReference(null)} variant="secondary" />
              </View>
            ) : null}
          </View>
        </Card>

        <AppButton label={t('setup.start')} onPress={handleStartFromSetup} />
        <BodyText tone="secondary">
          {personalRecord ? t('setup.record', { points: personalRecord.bestTotalPoints }) : t('setup.noRecord')}
        </BodyText>
        <BodyText tone="secondary" style={styles.smallText}>
          {t('privacy')}
        </BodyText>
      </ScreenContainer>
    );
  }

  const roundLabel = (roundIndex: number) =>
    t('roundOfTotal', { round: roundIndex + 1, total: game.targetColorIds.length });

  if (gamePhase === 'turnIntro' && targetColor) {
    return (
      <ScreenContainer>
        <BodyText tone="secondary">{roundLabel(game.currentRoundIndex)}</BodyText>
        {game.playerCount > 1 ? (
          <BodyText style={styles.turnTitle}>
            {game.currentRoundIndex === 0 && game.currentPlayerIndex === 0
              ? t('turn.yourTurn', { player: playerLabel(game.currentPlayerIndex) })
              : t('turn.passPhone', { player: playerLabel(game.currentPlayerIndex) })}
          </BodyText>
        ) : null}
        <Card style={styles.centeredCard}>
          <BodyText tone="secondary">{t('turn.findThis')}</BodyText>
          <View style={[styles.bigSwatch, { backgroundColor: targetColor.hexColor }]} />
          <BodyText style={styles.targetName}>{colorName(targetColor.id)}</BodyText>
        </Card>
        <BodyText tone="secondary">{t('turn.rules', { seconds: roundDurationSeconds })}</BodyText>
        <AppButton label={t('turn.go')} onPress={handleStartTurn} />
        <AppButton label={t('hunt.quit')} onPress={handleQuitGame} variant="secondary" />
      </ScreenContainer>
    );
  }

  if (gamePhase === 'hunting' && targetColor) {
    const heatLevel = deltaEToTarget !== null ? heatLevelForDeltaE(deltaEToTarget) : null;
    const readingName = crosshairReading ? colorName(nearestPaletteColor(crosshairReading.sampleLab).paletteColor.id) : null;
    return (
      <ScreenContainer>
        <View style={styles.huntHeader}>
          <View style={styles.huntHeaderText}>
            <BodyText tone="secondary" style={styles.smallText}>
              {game.playerCount > 1
                ? `${roundLabel(game.currentRoundIndex)} · ${playerLabel(game.currentPlayerIndex)}`
                : roundLabel(game.currentRoundIndex)}
            </BodyText>
            <View style={styles.targetRow}>
              <View style={[styles.smallSwatch, { backgroundColor: targetColor.hexColor }]} />
              <BodyText style={styles.targetNameSmall} numberOfLines={2}>
                {colorName(targetColor.id)}
              </BodyText>
            </View>
          </View>
          <View accessible accessibilityLabel={t('hunt.timeLeft', { seconds: Math.ceil(remainingSeconds) })}>
            <BodyText tone={remainingSeconds <= 10 ? 'danger' : 'primary'} style={styles.clock}>
              {formatClock(remainingSeconds)}
            </BodyText>
          </View>
        </View>

        {isPaused ? (
          <Card style={styles.centeredCard}>
            <BodyText>{t('hunt.paused')}</BodyText>
            <AppButton label={t('hunt.resume')} onPress={() => setIsPaused(false)} />
            <AppButton label={t('hunt.quit')} onPress={handleQuitGame} variant="danger" />
          </Card>
        ) : (
          <CrosshairCamera
            frameOutput={frameOutput}
            isActive={isCameraAllowed}
            isTorchOn={isTorchOn}
            liveHexColor={crosshairReading?.correctedSampleHex ?? null}
            onCameraError={(message) => setStatusMessage(t('core:common.error', { message }))}
          />
        )}

        <Card>
          {crosshairReading && deltaEToTarget !== null && heatLevel ? (
            <>
              <View style={styles.heatHeader}>
                <BodyText style={styles.heatLabel}>{t(`heat.${heatLevel}`)}</BodyText>
                <BodyText style={styles.deltaEText}>{t('hunt.distance', { deltaE: deltaEToTarget.toFixed(1) })}</BodyText>
              </View>
              <HeatBar deltaE={deltaEToTarget} heatLevel={heatLevel} />
              <BodyText tone="secondary">{t('hunt.reading', { name: readingName })}</BodyText>
              {!crosshairReading.isSampleUniform ? (
                <BodyText tone="danger" style={styles.smallText}>
                  {t('hunt.nonUniform')}
                </BodyText>
              ) : null}
            </>
          ) : (
            <BodyText tone="secondary">{t('hunt.waitingReading')}</BodyText>
          )}
        </Card>

        <AppButton
          label={t('hunt.capture')}
          onPress={() => finishTurn(readRemainingSeconds())}
          isDisabled={isPaused || !crosshairReading}
        />
        <View style={styles.buttonRow}>
          <View style={styles.buttonCell}>
            <AppButton
              label={isTorchOn ? t('hunt.torchOff') : t('hunt.torchOn')}
              onPress={() => setIsTorchOn((wasTorchOn) => !wasTorchOn)}
              variant="secondary"
              isDisabled={isPaused}
            />
          </View>
          <View style={styles.buttonCell}>
            <AppButton label={t('hunt.pause')} onPress={() => setIsPaused(true)} variant="secondary" isDisabled={isPaused} />
          </View>
        </View>
        {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      </ScreenContainer>
    );
  }

  if (gamePhase === 'turnResult' && finishedTurn) {
    const { capture } = finishedTurn;
    const finishedTarget = findPaletteColor(finishedTurn.targetColorId);
    return (
      <ScreenContainer>
        <BodyText tone="secondary">
          {game.playerCount > 1
            ? `${roundLabel(finishedTurn.roundIndex)} · ${playerLabel(finishedTurn.playerIndex)}`
            : roundLabel(finishedTurn.roundIndex)}
        </BodyText>
        <Card style={styles.centeredCard}>
          <BodyText style={styles.turnTitle}>{capture.wasTimedOut ? t('result.timedOut') : t('result.captured')}</BodyText>
          {capture.capturedHexColor && capture.deltaE !== null && finishedTarget ? (
            <>
              <View style={styles.swatchRow}>
                <LabeledSwatch
                  label={t('result.target')}
                  caption={colorName(finishedTarget.id)}
                  hexColor={finishedTarget.hexColor}
                />
                <LabeledSwatch label={t('result.yours')} caption={capture.capturedHexColor} hexColor={capture.capturedHexColor} />
              </View>
              <BodyText>
                {t('result.difference', {
                  deltaE: capture.deltaE.toFixed(1),
                  heat: t(`heat.${heatLevelForDeltaE(capture.deltaE)}`),
                })}
              </BodyText>
              <BodyText tone="secondary">{t('result.closeness', { points: capture.closenessPoints })}</BodyText>
              <BodyText tone="secondary">{t('result.timeBonus', { points: capture.timeBonusPoints })}</BodyText>
            </>
          ) : (
            <BodyText tone="secondary">{t('result.nothingSeen')}</BodyText>
          )}
          <BodyText style={styles.scoreValue}>{t('points', { points: capture.totalPoints })}</BodyText>
        </Card>
        <AppButton
          label={game.isFinished ? t('result.seeResults') : t('result.nextTurn')}
          onPress={() => setGamePhase(game.isFinished ? 'summary' : 'turnIntro')}
        />
      </ScreenContainer>
    );
  }

  // Resumen final.
  const scoreboard = computeScoreboard(game);
  const leaders = scoreboard.filter((entry) => entry.rank === 1);
  const roundBestCaptures = bestCapturePerRound(game);
  return (
    <ScreenContainer>
      <Card style={styles.centeredCard}>
        <BodyText style={styles.turnTitle}>{t('summary.title')}</BodyText>
        {game.playerCount > 1 ? (
          <BodyText tone="accent" style={styles.winnerText}>
            {leaders.length === 1 ? t('summary.winner', { player: playerLabel(leaders[0]!.playerIndex) }) : t('summary.tie')}
          </BodyText>
        ) : null}
        <BodyText style={styles.scoreValue}>{t('points', { points: scoreboard[0]?.totalPoints ?? 0 })}</BodyText>
        {isNewRecordGame ? (
          <BodyText tone="accent" style={styles.winnerText}>
            {t('summary.newRecord')}
          </BodyText>
        ) : personalRecord ? (
          <BodyText tone="secondary">{t('setup.record', { points: personalRecord.bestTotalPoints })}</BodyText>
        ) : null}
      </Card>

      {game.playerCount > 1 ? (
        <Card>
          <BodyText style={styles.cardTitle}>{t('summary.scoreboard')}</BodyText>
          {scoreboard.map((entry) => (
            <View key={entry.playerIndex} style={styles.scoreboardRow}>
              <BodyText style={entry.rank === 1 ? styles.leaderText : undefined}>
                {t('summary.rankedPlayer', { rank: entry.rank, player: playerLabel(entry.playerIndex) })}
              </BodyText>
              <BodyText style={styles.tabularText}>{entry.totalPoints}</BodyText>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <BodyText style={styles.cardTitle}>{t('summary.bestCaptures')}</BodyText>
        {roundBestCaptures.map((roundBest) => {
          const roundTarget = findPaletteColor(roundBest.targetColorId);
          const bestCapture = roundBest.capture;
          return (
            <View key={roundBest.roundIndex} style={styles.captureRow}>
              <View style={[styles.pairSwatch, { backgroundColor: roundTarget?.hexColor ?? 'transparent' }]} />
              <BodyText tone="secondary">→</BodyText>
              <View
                style={[
                  styles.pairSwatch,
                  bestCapture?.capturedHexColor
                    ? { backgroundColor: bestCapture.capturedHexColor }
                    : styles.emptySwatch,
                ]}
              />
              <View style={styles.captureText}>
                <BodyText numberOfLines={1}>{colorName(roundBest.targetColorId)}</BodyText>
                <BodyText tone="secondary" style={styles.smallText}>
                  {bestCapture && bestCapture.deltaE !== null
                    ? `${t('summary.roundCapture', { deltaE: bestCapture.deltaE.toFixed(1), points: bestCapture.totalPoints })}${
                        game.playerCount > 1 && roundBest.playerIndex !== null ? ` · ${playerLabel(roundBest.playerIndex)}` : ''
                      }`
                    : t('summary.nobodyCaptured')}
                </BodyText>
              </View>
            </View>
          );
        })}
      </Card>

      <BodyText tone="secondary" style={styles.smallText}>
        {t('summary.gameCode', { code: game.gameCode })}
      </BodyText>
      <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isBusy={isSaving} />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton label={t('summary.rematch')} onPress={() => startGame(game.gameCode, game.playerCount)} variant="secondary" />
        </View>
        <View style={styles.buttonCell}>
          <AppButton label={t('summary.newGame')} onPress={handleQuitGame} variant="secondary" />
        </View>
      </View>
    </ScreenContainer>
  );
}

function CrosshairCamera({
  frameOutput,
  isActive,
  isTorchOn,
  liveHexColor = null,
  onCameraError,
}: {
  frameOutput: CameraFrameOutput;
  isActive: boolean;
  isTorchOn: boolean;
  liveHexColor?: string | null;
  onCameraError(message: string): void;
}) {
  const { t } = useTranslation(colorHuntInstrumentId);
  const themePalette = useThemePalette();
  const [previewWidth, setPreviewWidth] = useState(0);
  // Tamaño aproximado en pantalla de la región medida: fotograma 3:4 recortado en modo `cover`.
  const crosshairDiameter = Math.max(24, crosshairSizeFraction * Math.max(previewWidth, (previewHeight * 3) / 4));

  return (
    <View
      style={[styles.previewContainer, { borderColor: themePalette.border }]}
      onLayout={(layoutEvent: LayoutChangeEvent) => setPreviewWidth(layoutEvent.nativeEvent.layout.width)}>
      <Camera
        style={StyleSheet.absoluteFill}
        device="back"
        isActive={isActive}
        outputs={[frameOutput]}
        torchMode={isTorchOn ? 'on' : 'off'}
        resizeMode="cover"
        onError={(cameraError) => {
          if (!isExpectedCameraInterruption(cameraError)) onCameraError(cameraError.message);
        }}
      />
      <View pointerEvents="none" style={styles.crosshairLayer} accessible accessibilityLabel={t('hunt.crosshair')}>
        <View style={[styles.crosshairLineHorizontal, { width: crosshairDiameter * 2.6 }]} />
        <View style={[styles.crosshairLineVertical, { height: crosshairDiameter * 2.6 }]} />
        <View
          style={[
            styles.crosshairRing,
            { width: crosshairDiameter, height: crosshairDiameter, borderRadius: crosshairDiameter / 2 },
          ]}
        />
      </View>
      {liveHexColor ? (
        <View pointerEvents="none" style={[styles.liveSwatch, { backgroundColor: liveHexColor }]} />
      ) : null}
    </View>
  );
}

function HeatBar({ deltaE, heatLevel }: { deltaE: number; heatLevel: HeatLevel }) {
  const themePalette = useThemePalette();
  return (
    <View style={[styles.heatTrack, { borderColor: themePalette.border }]}>
      <View
        style={[
          styles.heatFill,
          { width: `${Math.max(4, heatBarFraction(deltaE) * 100)}%`, backgroundColor: heatLevelColors[heatLevel] },
        ]}
      />
    </View>
  );
}

function LabeledSwatch({ label, caption, hexColor }: { label: string; caption: string; hexColor: string }) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.swatchColumn}>
      <BodyText tone="secondary">{label}</BodyText>
      <View style={[styles.mediumSwatch, { backgroundColor: hexColor, borderColor: themePalette.border }]} />
      <BodyText style={styles.swatchCaption} numberOfLines={2}>
        {caption}
      </BodyText>
    </View>
  );
}

function GameCodeInput({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText(text: string): void;
  placeholder: string;
}) {
  const themePalette = useThemePalette();
  return (
    <TextInput
      value={value}
      onChangeText={(typedText) => onChangeText(typedText.replace(/\D/g, '').slice(0, 4))}
      keyboardType="number-pad"
      maxLength={4}
      placeholder={placeholder}
      placeholderTextColor={themePalette.textSecondary}
      style={[styles.input, { color: themePalette.textPrimary, borderColor: themePalette.border }]}
    />
  );
}

function SegmentedChoice({
  options,
  selectedOption,
  labelFor,
  accessibilityLabelFor,
  onSelect,
}: {
  options: readonly number[];
  selectedOption: number;
  labelFor(option: number): string;
  accessibilityLabelFor(option: number): string;
  onSelect(option: number): void;
}) {
  const themePalette = useThemePalette();
  return (
    <View style={styles.segmentedRow}>
      {options.map((option) => {
        const isSelected = option === selectedOption;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityLabel={accessibilityLabelFor(option)}
            accessibilityState={{ selected: isSelected }}
            onPress={() => onSelect(option)}
            style={[styles.segment, { borderColor: isSelected ? themePalette.accent : themePalette.border }]}>
            <BodyText tone={isSelected ? 'accent' : 'primary'} style={styles.segmentLabel}>
              {labelFor(option)}
            </BodyText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontWeight: '600' },
  smallText: { fontSize: 13 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  segmentedRow: { flexDirection: 'row', gap: 8 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10, borderWidth: 1.5 },
  segmentLabel: { fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 17, letterSpacing: 4 },
  centeredCard: { alignItems: 'center', gap: 8, paddingVertical: 20 },
  turnTitle: { fontSize: 22, lineHeight: 28, fontWeight: '700', textAlign: 'center' },
  bigSwatch: { width: 160, height: 160, borderRadius: 24, borderWidth: 2, borderColor: 'rgba(127,127,127,0.4)' },
  targetName: { fontSize: 26, lineHeight: 32, fontWeight: '700', textAlign: 'center' },
  huntHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  huntHeaderText: { flex: 1, gap: 4 },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  smallSwatch: { width: 44, height: 44, borderRadius: 10, borderWidth: 2, borderColor: 'rgba(127,127,127,0.4)' },
  targetNameSmall: { flex: 1, fontSize: 20, lineHeight: 24, fontWeight: '700' },
  clock: { fontSize: 36, lineHeight: 42, fontWeight: '700', fontVariant: ['tabular-nums'] },
  previewContainer: {
    height: previewHeight,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  crosshairLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  crosshairLineHorizontal: { position: 'absolute', height: 1.5, backgroundColor: 'rgba(255,255,255,0.7)' },
  crosshairLineVertical: { position: 'absolute', width: 1.5, backgroundColor: 'rgba(255,255,255,0.7)' },
  crosshairRing: {
    borderWidth: 3,
    borderColor: '#FFFFFF',
    backgroundColor: 'transparent',
    shadowColor: '#000000',
    shadowOpacity: 0.8,
    shadowRadius: 2,
    elevation: 2,
  },
  liveSwatch: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 48,
    height: 48,
    borderRadius: 10,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  heatHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  heatLabel: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  deltaEText: { fontVariant: ['tabular-nums'], fontWeight: '600' },
  heatTrack: { height: 16, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  heatFill: { height: '100%', borderRadius: 8 },
  swatchRow: { flexDirection: 'row', justifyContent: 'space-around', alignSelf: 'stretch' },
  swatchColumn: { alignItems: 'center', gap: 4, flex: 1 },
  mediumSwatch: { width: 88, height: 88, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  swatchCaption: { textAlign: 'center', fontVariant: ['tabular-nums'] },
  scoreValue: { fontSize: 36, lineHeight: 44, fontWeight: '700', fontVariant: ['tabular-nums'] },
  winnerText: { fontSize: 18, fontWeight: '700' },
  scoreboardRow: { flexDirection: 'row', justifyContent: 'space-between' },
  leaderText: { fontWeight: '700' },
  tabularText: { fontVariant: ['tabular-nums'], fontWeight: '600' },
  captureRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pairSwatch: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(127,127,127,0.4)' },
  emptySwatch: { borderStyle: 'dashed', backgroundColor: 'transparent' },
  captureText: { flex: 1 },
});
