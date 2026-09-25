import { create } from 'zustand';

import { sensorControllers } from './sensorControllers';
import { allSensorKinds, type SensorAvailability, type SensorAvailabilityMap, type SensorKind } from './types';

interface SensorAvailabilityState {
  availabilityBySensor: SensorAvailabilityMap | null;
  isRefreshing: boolean;
  refreshAvailability(): Promise<void>;
  requestSensorPermission(sensorKind: SensorKind): Promise<SensorAvailability>;
}

export const useSensorAvailabilityStore = create<SensorAvailabilityState>()((setState, getState) => ({
  availabilityBySensor: null,
  isRefreshing: false,

  async refreshAvailability() {
    if (getState().isRefreshing) return;
    setState({ isRefreshing: true });
    const availabilityList = await Promise.all(
      allSensorKinds.map((sensorKind) => sensorControllers[sensorKind].checkAvailability()),
    );
    const availabilityBySensor = Object.fromEntries(
      availabilityList.map((availability) => [availability.sensorKind, availability]),
    ) as SensorAvailabilityMap;
    setState({ availabilityBySensor, isRefreshing: false });
  },

  async requestSensorPermission(sensorKind) {
    const updatedAvailability = await sensorControllers[sensorKind].requestPermission();
    const currentAvailability = getState().availabilityBySensor;
    if (currentAvailability) {
      setState({ availabilityBySensor: { ...currentAvailability, [sensorKind]: updatedAvailability } });
    }
    return updatedAvailability;
  },
}));
