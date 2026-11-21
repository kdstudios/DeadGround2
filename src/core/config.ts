/** All balance numbers live here so they can be tuned without touching game logic. */
export const CONFIG = {
  startHearts: 4,
  maxHearts: 5,
  maxShield: 3,

  /** Damage dealt to the player (a shield absorbs one whole hit regardless of amount). */
  damage: {
    mine: 1,
    zombie: 1,
    swat: 2,
  },

  /** Player walking speed, in tiles per second. */
  playerSpeed: 6,
  /** Default SWAT patrol speed, in tiles per second. */
  swatSpeed: 2,
  /** Seconds the player is immune to further SWAT contact after being hit. */
  swatContactCooldown: 1.2,
  /** How close (in tiles) a SWAT zombie must be to the player to count as contact. */
  swatContactRadius: 0.6,

  /**
   * Fog of war: stepping reveals tiles like Minesweeper (empty tiles open up, numbers form the border),
   * but only within this many tiles (Chebyshev distance) of the avatar. Measured from the reference
   * footage at roughly 2-3 tiles.
   */
  fogRadius: 3,

  medkitHeal: 1,
  /** Radius of bomb / map-item area. 1 = 3x3 centred on the player. */
  bombRadius: 1,
  mapRadius: 1,
} as const;
