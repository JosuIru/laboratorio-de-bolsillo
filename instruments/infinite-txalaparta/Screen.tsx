import Storage from 'expo-sqlite/kv-store';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { InfiniteTxalapartaMeasurementValues } from './schema';
import { missesToLose, type SlotOwner, slotsPerBar } from './txalapartaGame';
import { type TxalapartaState, useTxalapartaGame } from './useTxalapartaGame';

export const infiniteTxalapartaInstrumentId = 'infinite-txalaparta';

const bestScoreStorageKey = 'infinite-txalaparta.bestHits';

function loadBestHits(): number | null {
  try {
    const storedValue = Number(Storage.getItemSync(bestScoreStorageKey));
    return Number.isFinite(storedValue) && storedValue > 0 ? storedValue : null;
  } catch {
    return null;
  }
}

export function InfiniteTxalapartaScreen({ saveMeasurement }: InstrumentScreenProps<InfiniteTxalapartaMeasurementValues>) {
  const { t } = useTranslation(infiniteTxalapartaInstrumentId);
  const themePalette = useThemePalette();
  const { gameState, start, cancel } = useTxalapartaGame();
  const [bestHits, setBestHits] = useState<number | null>(loadBestHits);
  const [isNewRecord, setIsNewRecord] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Récord al terminar cada partida (una vez por partida terminada).
  const [recordedGame, setRecordedGame] = useState<TxalapartaState | null>(null);
  if (gameState.phase === 'over' && recordedGame !== gameState) {
    setRecordedGame(gameState);
    const isBetter = bestHits === null || gameState.tally.hits > bestHits;
    setIsNewRecord(isBetter && gameState.tally.hits > 0);
    if (isBetter && gameState.tally.hits > 0) {
      setBestHits(gameState.tally.hits);
      try {
        Storage.setItemSync(bestScoreStorageKey, String(gameState.tally.hits));
      } catch {
        // Sin almacenamiento, el récord vale mientras la pantalla esté abierta.
      }
    }
  }

  async function handleSave() {
    if (gameState.phase !== 'over') return;
    const { tally } = gameState;
    try {
      await saveMeasurement({
        values: {
          hits: tally.hits,
          misses: tally.misses,
          barsReached: gameState.barIndex,
          finalBeatsPerMinute: gameState.beatsPerMinute,
          ...(tally.hits > 0 ? { meanAbsoluteErrorMilliseconds: Math.round((1000 * tally.absoluteErrorSumSeconds) / tally.hits) } : {}),
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    }
  }

  const isRunning = gameState.phase === 'starting' || gameState.phase === 'playing';

  return (
    <ScreenContainer>
      {gameState.phase === 'playing' ? (
        <Card>
          <BodyText style={styles.stageText} tone="accent">
            {gameState.isCountIn ? t('countIn') : t('yourTurn')}
          </BodyText>
          <BarView barSlots={gameState.currentBarSlots} currentSlotIndex={gameState.currentSlotIndex} />
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('bar.legend')}
          </BodyText>
          <BodyText style={styles.hitsValue}>{gameState.tally.hits}</BodyText>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('hitsLabel')}
          </BodyText>
          <View style={styles.livesRow}>
            {Array.from({ length: missesToLose }, (_, lifeIndex) => (
              <View
                key={lifeIndex}
                style={[
                  styles.lifeDot,
                  {
                    backgroundColor:
                      lifeIndex < missesToLose - gameState.tally.consecutiveMisses ? themePalette.accent : themePalette.border,
                  },
                ]}
              />
            ))}
          </View>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('tempo', { bpm: gameState.beatsPerMinute, level: gameState.level + 1 })}
          </BodyText>
          {gameState.lastJudgement ? (
            <BodyText tone={gameState.lastJudgement.isHit ? 'accent' : 'danger'} style={styles.centeredText}>
              {gameState.lastJudgement.isHit && gameState.lastJudgement.errorSeconds !== null
                ? t('judgement.hit', {
                    offset: `${gameState.lastJudgement.errorSeconds >= 0 ? '+' : ''}${Math.round(gameState.lastJudgement.errorSeconds * 1000)}`,
                  })
                : gameState.lastJudgement.isStray
                  ? t('judgement.stray')
                  : t('judgement.miss')}
            </BodyText>
          ) : null}
        </Card>
      ) : gameState.phase === 'over' ? (
        <Card>
          <BodyText style={styles.stageText}>{t('over.title')}</BodyText>
          <BodyText style={styles.hitsValue}>{gameState.tally.hits}</BodyText>
          <BodyText tone="secondary" style={styles.centeredText}>
            {t('over.summary', { bars: gameState.barIndex, bpm: gameState.beatsPerMinute })}
          </BodyText>
          {gameState.tally.hits > 0 ? (
            <BodyText tone="secondary" style={styles.centeredText}>
              {t('over.accuracy', { milliseconds: Math.round((1000 * gameState.tally.absoluteErrorSumSeconds) / gameState.tally.hits) })}
            </BodyText>
          ) : null}
          {isNewRecord ? (
            <BodyText tone="accent" style={styles.centeredText}>
              {t('over.newRecord')}
            </BodyText>
          ) : null}
          <AppButton label={t('core:common.save')} variant="secondary" onPress={() => void handleSave()} />
        </Card>
      ) : (
        <Card>
          <SectionTitle>{t('howTo.title')}</SectionTitle>
          <BodyText tone="secondary">{t('howTo.rules')}</BodyText>
          <BodyText tone="secondary">{t('howTo.setup')}</BodyText>
          {bestHits !== null ? <BodyText>{t('best', { hits: bestHits })}</BodyText> : null}
          {gameState.phase === 'strokes-not-heard' ? <BodyText tone="danger">{t('error.notHeard')}</BodyText> : null}
          {gameState.phase === 'error' ? (
            <BodyText tone="danger">{t('error.microphone', { message: gameState.errorMessage })}</BodyText>
          ) : null}
        </Card>
      )}

      <AppButton
        label={isRunning ? t('stop') : gameState.phase === 'over' ? t('again') : t('start')}
        variant={isRunning ? 'secondary' : 'primary'}
        isBusy={gameState.phase === 'starting'}
        onPress={() => {
          setStatusMessage(null);
          if (isRunning) cancel();
          else void start();
        }}
      />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
      <BodyText tone="secondary" style={styles.privacyNote}>
        {t('privacy')}
      </BodyText>
    </ScreenContainer>
  );
}

/**
 * El compás que suena: 8 casillas, las tuyas en color, las del móvil en gris y los silencios
 * vacíos; la que suena ahora, más grande. Durante la entrada se ven vacías.
 */
function BarView({ barSlots, currentSlotIndex }: { barSlots: readonly SlotOwner[]; currentSlotIndex: number | null }) {
  const { t } = useTranslation(infiniteTxalapartaInstrumentId);
  const themePalette = useThemePalette();
  return (
    <View style={styles.barRow} accessible accessibilityLabel={t('bar.accessibilityLabel')}>
      {Array.from({ length: slotsPerBar }, (_, slotIndex) => {
        const slotOwner = barSlots[slotIndex] ?? 'rest';
        const isCurrent = slotIndex === currentSlotIndex;
        const slotColor =
          slotOwner === 'player'
            ? themePalette.accent
            : slotOwner === 'machine'
              ? themePalette.textSecondary
              : 'transparent';
        return (
          <View
            key={slotIndex}
            style={[
              styles.barSlot,
              {
                backgroundColor: slotColor,
                borderColor: isCurrent ? themePalette.textPrimary : themePalette.border,
                borderWidth: isCurrent ? 3 : 1.5,
                opacity: currentSlotIndex === null || isCurrent ? 1 : 0.55,
                transform: [{ scale: isCurrent ? 1.15 : 1 }],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  barRow: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginVertical: 12 },
  barSlot: { flex: 1, maxWidth: 36, aspectRatio: 1, borderRadius: 8 },
  centeredText: { textAlign: 'center' },
  stageText: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  hitsValue: { fontSize: 64, fontWeight: '700', lineHeight: 72, textAlign: 'center', fontVariant: ['tabular-nums'] },
  livesRow: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginVertical: 8 },
  lifeDot: { width: 18, height: 18, borderRadius: 9 },
  privacyNote: { fontSize: 13 },
});
