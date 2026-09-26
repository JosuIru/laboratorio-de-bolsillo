import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { BodyText } from '@/ui/components';
import { useThemePalette } from '@/ui/theme';

import type { FourWheelLifts, SingleAxleLeveling } from './levelingGeometry';
import { rvLevelerInstrumentId } from './rvLevelerInstrumentId';

const diagramWidthPixels = 280;
const diagramHeightPixels = 320;
const bodyWidthPixels = 100;
const bodyLeftPixels = (diagramWidthPixels - bodyWidthPixels) / 2;
const bodyBottomPixels = diagramHeightPixels - 10;
const wheelWidthPixels = 18;
const wheelHeightPixels = 44;
const labelWidthPixels = bodyLeftPixels - wheelWidthPixels / 2 - 8;
const labelHeightPixels = 44;

// Posiciones verticales (centro de la rueda) en el esquema.
const fourWheelsBodyTopPixels = 40;
const frontWheelsCenterPixels = 90;
const rearWheelsCenterPixels = 250;
const singleAxleBodyTopPixels = 110;
const singleAxleWheelsCenterPixels = 230;
const jockeyWheelTopPixels = 36;

type WheelSide = 'left' | 'right';

/** Los calzos se dan en cm enteros: más precisión no la tiene ni el acelerómetro ni un calzo. */
export function roundedCentimeters(liftCentimeters: number): number {
  const rounded = Math.round(liftCentimeters);
  return rounded === 0 ? 0 : rounded;
}

/** «0 cm», «Subir 12 cm» o «Bajar 5 cm» para la rueda jockey. */
export function jockeyChangeText(t: TFunction, jockeyWheelChangeCentimeters: number): string {
  const displayedCentimeters = roundedCentimeters(jockeyWheelChangeCentimeters);
  if (displayedCentimeters === 0) return t('diagram.liftValue', { centimeters: 0 });
  return displayedCentimeters > 0
    ? t('diagram.jockeyRaise', { centimeters: displayedCentimeters })
    : t('diagram.jockeyLower', { centimeters: -displayedCentimeters });
}

function Wheel({ centerTopPixels, side, wheelColor }: { centerTopPixels: number; side: WheelSide; wheelColor: string }) {
  const bodyEdgePixels = side === 'left' ? bodyLeftPixels : bodyLeftPixels + bodyWidthPixels;
  return (
    <View
      style={[
        styles.wheel,
        {
          top: centerTopPixels - wheelHeightPixels / 2,
          left: bodyEdgePixels - wheelWidthPixels / 2,
          backgroundColor: wheelColor,
        },
      ]}
    />
  );
}

function LiftLabel({ centerTopPixels, side, labelText, isZero }: {
  centerTopPixels: number;
  side: WheelSide;
  labelText: string;
  isZero: boolean;
}) {
  return (
    <View
      style={[
        styles.liftLabel,
        { top: centerTopPixels - labelHeightPixels / 2 },
        side === 'left' ? styles.leftLabel : styles.rightLabel,
      ]}>
      <BodyText style={styles.liftValue} tone={isZero ? 'secondary' : 'accent'}>
        {labelText}
      </BodyText>
    </View>
  );
}

function WheelWithLift({
  centerTopPixels,
  side,
  liftCentimeters,
  t,
  wheelColor,
}: {
  centerTopPixels: number;
  side: WheelSide;
  liftCentimeters: number;
  t: TFunction;
  wheelColor: string;
}) {
  const displayedCentimeters = roundedCentimeters(liftCentimeters);
  return (
    <>
      <Wheel centerTopPixels={centerTopPixels} side={side} wheelColor={wheelColor} />
      <LiftLabel
        centerTopPixels={centerTopPixels}
        side={side}
        labelText={t('diagram.liftValue', { centimeters: displayedCentimeters })}
        isZero={displayedCentimeters === 0}
      />
    </>
  );
}

type VehicleDiagramProps =
  | { vehicleLayout: 'fourWheels'; wheelLifts: FourWheelLifts }
  | { vehicleLayout: 'singleAxle'; singleAxleLeveling: SingleAxleLeveling };

/** Esquema del vehículo visto desde arriba, con el morro hacia arriba y los cm de calzo de cada rueda. */
export function VehicleDiagram(diagramProps: VehicleDiagramProps) {
  const { t } = useTranslation(rvLevelerInstrumentId);
  const themePalette = useThemePalette();
  const wheelColor = themePalette.textPrimary;
  const bodyTopPixels =
    diagramProps.vehicleLayout === 'fourWheels' ? fourWheelsBodyTopPixels : singleAxleBodyTopPixels;

  const vehicleBody = (
    <View
      style={[
        styles.body,
        {
          top: bodyTopPixels,
          height: bodyBottomPixels - bodyTopPixels,
          borderColor: themePalette.textSecondary,
          backgroundColor: themePalette.background,
        },
      ]}
    />
  );
  const frontLabel = (
    <BodyText tone="secondary" style={styles.frontLabel}>
      {t('diagram.front')}
    </BodyText>
  );

  if (diagramProps.vehicleLayout === 'fourWheels') {
    const { wheelLifts } = diagramProps;
    const accessibilityDescription = t('diagram.fourWheelsDescription', {
      frontLeft: roundedCentimeters(wheelLifts.frontLeftLiftCentimeters),
      frontRight: roundedCentimeters(wheelLifts.frontRightLiftCentimeters),
      rearLeft: roundedCentimeters(wheelLifts.rearLeftLiftCentimeters),
      rearRight: roundedCentimeters(wheelLifts.rearRightLiftCentimeters),
    });
    return (
      <View accessible accessibilityLabel={accessibilityDescription} style={styles.diagram}>
        {frontLabel}
        {vehicleBody}
        <WheelWithLift
          centerTopPixels={frontWheelsCenterPixels}
          side="left"
          liftCentimeters={wheelLifts.frontLeftLiftCentimeters}
          t={t}
          wheelColor={wheelColor}
        />
        <WheelWithLift
          centerTopPixels={frontWheelsCenterPixels}
          side="right"
          liftCentimeters={wheelLifts.frontRightLiftCentimeters}
          t={t}
          wheelColor={wheelColor}
        />
        <WheelWithLift
          centerTopPixels={rearWheelsCenterPixels}
          side="left"
          liftCentimeters={wheelLifts.rearLeftLiftCentimeters}
          t={t}
          wheelColor={wheelColor}
        />
        <WheelWithLift
          centerTopPixels={rearWheelsCenterPixels}
          side="right"
          liftCentimeters={wheelLifts.rearRightLiftCentimeters}
          t={t}
          wheelColor={wheelColor}
        />
      </View>
    );
  }

  const { singleAxleLeveling } = diagramProps;
  const accessibilityDescription = t('diagram.singleAxleDescription', {
    left: roundedCentimeters(singleAxleLeveling.leftWheelLiftCentimeters),
    right: roundedCentimeters(singleAxleLeveling.rightWheelLiftCentimeters),
    jockey: jockeyChangeText(t, singleAxleLeveling.jockeyWheelChangeCentimeters),
  });
  const drawbarTopPixels = jockeyWheelTopPixels + 14;
  return (
    <View accessible accessibilityLabel={accessibilityDescription} style={styles.diagram}>
      {frontLabel}
      <View
        style={[
          styles.drawbar,
          { top: drawbarTopPixels, height: bodyTopPixels - drawbarTopPixels, backgroundColor: themePalette.textSecondary },
        ]}
      />
      {vehicleBody}
      <View style={[styles.jockeyWheel, { top: jockeyWheelTopPixels, backgroundColor: wheelColor }]} />
      <View style={[styles.jockeyLabel, { top: jockeyWheelTopPixels + 13 - labelHeightPixels / 2 }]}>
        <BodyText
          style={styles.jockeyValue}
          tone={roundedCentimeters(singleAxleLeveling.jockeyWheelChangeCentimeters) === 0 ? 'secondary' : 'accent'}>
          {jockeyChangeText(t, singleAxleLeveling.jockeyWheelChangeCentimeters)}
        </BodyText>
      </View>
      <WheelWithLift
        centerTopPixels={singleAxleWheelsCenterPixels}
        side="left"
        liftCentimeters={singleAxleLeveling.leftWheelLiftCentimeters}
        t={t}
        wheelColor={wheelColor}
      />
      <WheelWithLift
        centerTopPixels={singleAxleWheelsCenterPixels}
        side="right"
        liftCentimeters={singleAxleLeveling.rightWheelLiftCentimeters}
        t={t}
        wheelColor={wheelColor}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  diagram: { width: diagramWidthPixels, height: diagramHeightPixels, alignSelf: 'center' },
  frontLabel: { position: 'absolute', top: 0, left: 0, right: 0, textAlign: 'center', fontSize: 13 },
  body: {
    position: 'absolute',
    left: bodyLeftPixels,
    width: bodyWidthPixels,
    borderWidth: 2,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  wheel: { position: 'absolute', width: wheelWidthPixels, height: wheelHeightPixels, borderRadius: 4 },
  liftLabel: { position: 'absolute', width: labelWidthPixels, height: labelHeightPixels, justifyContent: 'center' },
  leftLabel: { left: 0, alignItems: 'flex-end' },
  rightLabel: { right: 0, alignItems: 'flex-start' },
  liftValue: { fontSize: 24, lineHeight: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  // Lleva verbo («subir 12 cm»): más pequeño para que quepa en una línea junto a la rueda jockey.
  jockeyValue: { fontSize: 18, lineHeight: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
  drawbar: { position: 'absolute', left: diagramWidthPixels / 2 - 2, width: 4 },
  jockeyWheel: { position: 'absolute', left: diagramWidthPixels / 2 - 8, width: 16, height: 26, borderRadius: 6 },
  jockeyLabel: {
    position: 'absolute',
    left: diagramWidthPixels / 2 + 18,
    right: 0,
    height: labelHeightPixels,
    justifyContent: 'center',
  },
});
