import type { Facility } from '../core/base.js';

/**
 * Icons for the safehouse facility cards.
 *
 * Until dedicated art exists each facility borrows a sprite from the game. To use your own icon, drop a
 * PNG into assets/ui/ (e.g. assets/ui/fac_storage.png) and point the facility at it in OVERRIDES below.
 */
const FALLBACK: Record<Facility, string> = {
  storage: 'assets/sprites/prop_crate.png',
  garden: 'assets/sprites/item_food.png',
  workshop: 'assets/sprites/mg_desk.png',
  radio: 'assets/sprites/item_map.png',
  armoury: 'assets/sprites/item_ammo.png',
  barricades: 'assets/sprites/ov_barricade.png',
  watchtower: 'assets/sprites/bld7.png',
};

const OVERRIDES: Partial<Record<Facility, string>> = {
  // storage: 'assets/ui/fac_storage.png',
};

export const facilityIcon = (f: Facility): string => OVERRIDES[f] ?? FALLBACK[f];
