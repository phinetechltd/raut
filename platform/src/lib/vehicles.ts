/** Vehicle categories the fleet screen and API agree on. */
export const VEHICLE_TYPES = ["VAN", "PICKUP", "MOTORBIKE", "TRUCK", "CAR"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  VAN: "Van",
  PICKUP: "Pick-up",
  MOTORBIKE: "Motorbike",
  TRUCK: "Truck",
  CAR: "Car",
};

/** Normalises a plate the way the API stores it: upper case, single spaces. */
export function normalisePlate(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}
