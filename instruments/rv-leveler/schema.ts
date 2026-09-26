import { defineMeasurementSchema } from '@/core/measurements/schema';

import type { VehicleLayout } from './levelingGeometry';

/** Una nivelación: ángulos (con el cero aplicado), medidas del vehículo y calzos calculados. */
export interface RvLevelerMeasurementValues {
  vehicleLayout: VehicleLayout;
  lateralTiltDegrees: number;
  longitudinalTiltDegrees: number;
  isLevel: boolean;
  trackWidthCentimeters: number;
  // Vehículo de dos ejes.
  wheelbaseCentimeters?: number;
  frontLeftLiftCentimeters?: number;
  frontRightLiftCentimeters?: number;
  rearLeftLiftCentimeters?: number;
  rearRightLiftCentimeters?: number;
  // Caravana de un eje.
  jockeyDistanceCentimeters?: number;
  leftWheelLiftCentimeters?: number;
  rightWheelLiftCentimeters?: number;
  jockeyWheelChangeCentimeters?: number;
}

export const rvLevelerSchema = defineMeasurementSchema<RvLevelerMeasurementValues>(1, [
  { key: 'vehicleLayout', labelKey: 'fields.vehicleLayout', type: 'string' },
  { key: 'lateralTiltDegrees', labelKey: 'fields.lateralTilt', type: 'number', unit: '°' },
  { key: 'longitudinalTiltDegrees', labelKey: 'fields.longitudinalTilt', type: 'number', unit: '°' },
  { key: 'isLevel', labelKey: 'fields.isLevel', type: 'boolean' },
  { key: 'trackWidthCentimeters', labelKey: 'fields.trackWidth', type: 'number', unit: 'cm' },
  { key: 'wheelbaseCentimeters', labelKey: 'fields.wheelbase', type: 'number', unit: 'cm', optional: true },
  { key: 'frontLeftLiftCentimeters', labelKey: 'fields.frontLeftLift', type: 'number', unit: 'cm', optional: true },
  { key: 'frontRightLiftCentimeters', labelKey: 'fields.frontRightLift', type: 'number', unit: 'cm', optional: true },
  { key: 'rearLeftLiftCentimeters', labelKey: 'fields.rearLeftLift', type: 'number', unit: 'cm', optional: true },
  { key: 'rearRightLiftCentimeters', labelKey: 'fields.rearRightLift', type: 'number', unit: 'cm', optional: true },
  { key: 'jockeyDistanceCentimeters', labelKey: 'fields.jockeyDistance', type: 'number', unit: 'cm', optional: true },
  { key: 'leftWheelLiftCentimeters', labelKey: 'fields.leftWheelLift', type: 'number', unit: 'cm', optional: true },
  { key: 'rightWheelLiftCentimeters', labelKey: 'fields.rightWheelLift', type: 'number', unit: 'cm', optional: true },
  {
    key: 'jockeyWheelChangeCentimeters',
    labelKey: 'fields.jockeyWheelChange',
    type: 'number',
    unit: 'cm',
    optional: true,
  },
]);
