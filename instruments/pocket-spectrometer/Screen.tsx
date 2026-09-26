import Storage from 'expo-sqlite/kv-store';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Camera, type CameraRef } from 'react-native-vision-camera';

import type { InstrumentScreenProps } from '@/core/instruments/types';
import { isExpectedCameraInterruption } from '@/core/sensors/cameraErrors';
import { useIsCameraAllowed } from '@/core/sensors/useIsCameraAllowed';
import { SignalChart } from '@/ui/charts/SignalChart';
import { AppButton, BodyText, Card, ScreenContainer, SectionTitle } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import {
  createViewToCameraMapping,
  mapViewPointToCamera,
  type ViewToCameraMapping,
} from '@instruments/pool-strips/stripEngine';

import type { PocketSpectrometerMeasurementValues } from './schema';
import {
  findSpectrumPeaks,
  fluorescentReferenceLines,
  isCalibrationUsable,
  parseStoredCalibration,
  positionToWavelengthNm,
  profileSampleCount,
  type WavelengthCalibration,
  wavelengthToDisplayColor,
} from './spectrumEngine';
import { type CameraLine, useSpectrumFrames } from './useSpectrumFrames';

export const pocketSpectrometerInstrumentId = 'pocket-spectrometer';

const previewHeight = 260;
const calibrationStorageKey = 'pocket-spectrometer.calibration';

/** Hora actual; solo se llama desde manejadores de eventos y temporizadores, nunca al pintar. */
function currentTimeMilliseconds(): number {
  return Date.now();
}
/** La línea guía cruza la vista del 5 % al 95 % del ancho. */
const guideMarginFraction = 0.05;
const guideStepFraction = 0.04;
/** Puntos del perfil que se guardan con cada medición. */
const storedProfilePointCount = 60;

interface StoredCalibration extends WavelengthCalibration {
  /** Altura de la línea guía con la que se calibró: si se mueve, la calibración deja de valer. */
  guideFraction: number;
}

function loadCalibration(): StoredCalibration | null {
  try {
    const storedText = Storage.getItemSync(calibrationStorageKey);
    const calibration = parseStoredCalibration(storedText);
    if (!calibration || !storedText) return null;
    const guideFraction = (JSON.parse(storedText) as { guideFraction?: unknown }).guideFraction;
    return typeof guideFraction === 'number' ? { ...calibration, guideFraction } : null;
  } catch {
    return null;
  }
}

export function PocketSpectrometerScreen({
  saveMeasurement,
}: InstrumentScreenProps<PocketSpectrometerMeasurementValues>) {
  const { t } = useTranslation(pocketSpectrometerInstrumentId);
  const themePalette = useThemePalette();
  const cameraRef = useRef<CameraRef>(null);
  const isCameraAllowed = useIsCameraAllowed();
  const [previewWidth, setPreviewWidth] = useState(0);
  const [viewToCameraMapping, setViewToCameraMapping] = useState<ViewToCameraMapping | null>(null);
  const [calibration, setCalibration] = useState<StoredCalibration | null>(loadCalibration);
  const [guideFraction, setGuideFraction] = useState(() => loadCalibration()?.guideFraction ?? 0.5);
  const [pendingCalibrationPositions, setPendingCalibrationPositions] = useState<number[] | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const guideY = guideFraction * previewHeight;
  const cameraLine = useMemo<CameraLine | null>(() => {
    if (!viewToCameraMapping || previewWidth <= 0) return null;
    return {
      start: mapViewPointToCamera(viewToCameraMapping, { x: previewWidth * guideMarginFraction, y: guideY }),
      end: mapViewPointToCamera(viewToCameraMapping, { x: previewWidth * (1 - guideMarginFraction), y: guideY }),
    };
  }, [viewToCameraMapping, previewWidth, guideY]);
  const { frameOutput, spectrumProfile } = useSpectrumFrames(cameraLine);

  const isCalibrationCurrent =
    isCalibrationUsable(calibration) && Math.abs(calibration.guideFraction - guideFraction) < 1e-6;
  const spectrumPeaks = useMemo(
    () => (spectrumProfile ? findSpectrumPeaks(spectrumProfile.intensities) : []),
    [spectrumProfile],
  );
  const describePeakPosition = (position: number) =>
    isCalibrationCurrent && calibration
      ? `${Math.round(positionToWavelengthNm(calibration, position))} nm`
      : t('peaks.position', { position: Math.round(position) });

  function handlePreviewLayout(layoutEvent: LayoutChangeEvent) {
    const { width, height } = layoutEvent.nativeEvent.layout;
    setPreviewWidth(width);
    const cameraView = cameraRef.current;
    if (!cameraView) return;
    try {
      const mapping = createViewToCameraMapping(
        width,
        height,
        cameraView.convertViewPointToCameraPoint({ x: 0, y: 0 }),
        cameraView.convertViewPointToCameraPoint({ x: width, y: 0 }),
        cameraView.convertViewPointToCameraPoint({ x: 0, y: height }),
      );
      if (mapping) setViewToCameraMapping(mapping);
    } catch {
      // La vista previa aún no está lista: se reintenta al volver a medirse.
    }
  }

  function moveGuide(direction: -1 | 1) {
    setGuideFraction((previousFraction) =>
      Math.min(0.9, Math.max(0.1, previousFraction + direction * guideStepFraction)),
    );
  }

  function handlePeakPressForCalibration(peakPosition: number) {
    if (pendingCalibrationPositions === null) return;
    const updatedPositions = [...pendingCalibrationPositions, peakPosition];
    if (updatedPositions.length < 2) {
      setPendingCalibrationPositions(updatedPositions);
      return;
    }
    const newCalibration: StoredCalibration = {
      points: [
        { position: updatedPositions[0]!, wavelengthNm: fluorescentReferenceLines[0].wavelengthNm },
        { position: updatedPositions[1]!, wavelengthNm: fluorescentReferenceLines[1].wavelengthNm },
      ],
      calibratedAt: currentTimeMilliseconds(),
      guideFraction,
    };
    setPendingCalibrationPositions(null);
    if (!isCalibrationUsable(newCalibration)) {
      setStatusMessage(t('calibration.invalid'));
      return;
    }
    setCalibration(newCalibration);
    try {
      Storage.setItemSync(calibrationStorageKey, JSON.stringify(newCalibration));
    } catch {
      // Sin almacenamiento, la calibración vale mientras la pantalla esté abierta.
    }
    setStatusMessage(t('calibration.done'));
  }

  async function handleSave() {
    if (!spectrumProfile) return;
    setStatusMessage(null);
    const downsampledProfile = Array.from({ length: storedProfilePointCount }, (_, pointIndex) => {
      const sourceIndex = Math.round((pointIndex * (profileSampleCount - 1)) / (storedProfilePointCount - 1));
      return Math.round(spectrumProfile.intensities[sourceIndex] ?? 0);
    });
    try {
      await saveMeasurement({
        values: {
          isCalibrated: isCalibrationCurrent,
          peakPositions: spectrumPeaks.map((spectrumPeak) => Math.round(spectrumPeak.position * 10) / 10),
          ...(isCalibrationCurrent && calibration
            ? {
                peakWavelengthsNm: spectrumPeaks.map(
                  (spectrumPeak) => Math.round(positionToWavelengthNm(calibration, spectrumPeak.position) * 10) / 10,
                ),
                startWavelengthNm: Math.round(positionToWavelengthNm(calibration, 0)),
                endWavelengthNm: Math.round(positionToWavelengthNm(calibration, profileSampleCount - 1)),
              }
            : {}),
          profile: downsampledProfile,
        },
      });
      setStatusMessage(t('core:instrument.savedMeasurement'));
    } catch (saveError) {
      setStatusMessage(t('core:common.error', { message: String(saveError) }));
    }
  }

  const horizontalLabels: [string, string] | undefined =
    isCalibrationCurrent && calibration
      ? [
          `${Math.round(positionToWavelengthNm(calibration, 0))} nm`,
          `${Math.round(positionToWavelengthNm(calibration, profileSampleCount - 1))} nm`,
        ]
      : undefined;

  return (
    <ScreenContainer>
      <Card>
        <SectionTitle>{t('howTo.title')}</SectionTitle>
        <BodyText tone="secondary">{t('howTo.kit')}</BodyText>
        <BodyText tone="secondary">{t('howTo.aim')}</BodyText>
      </Card>

      <View style={[styles.previewContainer, { borderColor: themePalette.border }]} onLayout={handlePreviewLayout}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device="back"
          isActive={isCameraAllowed}
          outputs={[frameOutput]}
          resizeMode="cover"
          onError={(cameraError) => {
            if (!isExpectedCameraInterruption(cameraError)) {
              setStatusMessage(t('core:common.error', { message: cameraError.message }));
            }
          }}
        />
        <View
          pointerEvents="none"
          style={[
            styles.guideLine,
            { top: guideY - 1, left: `${guideMarginFraction * 100}%`, right: `${guideMarginFraction * 100}%` },
          ]}
        />
      </View>
      <View style={styles.buttonRow}>
        <View style={styles.buttonCell}>
          <AppButton label={t('guide.up')} variant="secondary" onPress={() => moveGuide(-1)} />
        </View>
        <View style={styles.buttonCell}>
          <AppButton label={t('guide.down')} variant="secondary" onPress={() => moveGuide(1)} />
        </View>
      </View>

      <Card>
        {spectrumProfile ? (
          <>
            <SignalChart
              series={[{ values: spectrumProfile.intensities, color: themePalette.accent }]}
              height={140}
              verticalRange={{ mode: 'from-zero', minimumMaximum: 60 }}
              revision={spectrumProfile.revision}
              horizontalLabels={horizontalLabels}
              accessibilityLabel={t('chartLabel')}
            />
            <View style={styles.colorStrip}>
              {Array.from({ length: 48 }, (_, stripIndex) => {
                const sourceIndex = Math.round((stripIndex * (profileSampleCount - 1)) / 47);
                const toHex = (channelValue: number) =>
                  Math.round(Math.min(255, channelValue)).toString(16).padStart(2, '0');
                return (
                  <View
                    key={stripIndex}
                    style={[
                      styles.colorStripCell,
                      {
                        backgroundColor: `#${toHex(spectrumProfile.reds[sourceIndex] ?? 0)}${toHex(spectrumProfile.greens[sourceIndex] ?? 0)}${toHex(spectrumProfile.blues[sourceIndex] ?? 0)}`,
                      },
                    ]}
                  />
                );
              })}
            </View>
          </>
        ) : (
          <BodyText tone="secondary">{t('waiting')}</BodyText>
        )}
        {!isCalibrationCurrent ? (
          <BodyText tone="secondary">{calibration ? t('calibration.moved') : t('calibration.missing')}</BodyText>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>{t('peaks.title')}</SectionTitle>
        {pendingCalibrationPositions !== null ? (
          <BodyText tone="accent">
            {t('calibration.pick', {
              line: t(`calibration.line.${fluorescentReferenceLines[pendingCalibrationPositions.length]!.id}`),
              wavelength: fluorescentReferenceLines[pendingCalibrationPositions.length]!.wavelengthNm,
            })}
          </BodyText>
        ) : null}
        {spectrumPeaks.length === 0 ? <BodyText tone="secondary">{t('peaks.none')}</BodyText> : null}
        <View style={styles.chipRow}>
          {spectrumPeaks.map((spectrumPeak) => (
            <Pressable
              key={spectrumPeak.position}
              accessibilityRole="button"
              disabled={pendingCalibrationPositions === null}
              onPress={() => handlePeakPressForCalibration(spectrumPeak.position)}
              style={[
                styles.chip,
                { borderColor: pendingCalibrationPositions !== null ? themePalette.accent : themePalette.border },
              ]}
            >
              {isCalibrationCurrent && calibration ? (
                <View
                  style={[
                    styles.peakSwatch,
                    {
                      backgroundColor: wavelengthToDisplayColor(
                        positionToWavelengthNm(calibration, spectrumPeak.position),
                      ),
                    },
                  ]}
                />
              ) : null}
              <BodyText>{describePeakPosition(spectrumPeak.position)}</BodyText>
            </Pressable>
          ))}
        </View>
        <AppButton
          label={pendingCalibrationPositions !== null ? t('calibration.cancel') : t('calibration.start')}
          variant="secondary"
          onPress={() => {
            setStatusMessage(null);
            setPendingCalibrationPositions((previousPositions) => (previousPositions === null ? [] : null));
          }}
        />
        <BodyText tone="secondary">{t('calibration.hint')}</BodyText>
      </Card>

      <AppButton label={t('core:common.save')} onPress={() => void handleSave()} isDisabled={!spectrumProfile} />
      {statusMessage ? <BodyText tone="secondary">{statusMessage}</BodyText> : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  previewContainer: {
    height: previewHeight,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: '#000000',
  },
  guideLine: { position: 'absolute', height: 2, backgroundColor: '#FFFFFF', opacity: 0.8 },
  buttonRow: { flexDirection: 'row', gap: 8 },
  buttonCell: { flex: 1 },
  colorStrip: { flexDirection: 'row', height: 14, marginTop: 6, borderRadius: 4, overflow: 'hidden' },
  colorStripCell: { flex: 1 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1.5,
  },
  peakSwatch: { width: 12, height: 12, borderRadius: 6 },
});
