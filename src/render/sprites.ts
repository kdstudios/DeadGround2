/**
 * Sprite lookup by name. Everything the renderer draws goes through here, so
 * swapping art = replacing PNGs / editing assets/manifest.json. No game logic
 * knows about image files.
 */
export interface SpriteDef {
  src: string;
  w: number;
  h: number;
}

export interface Manifest {
  tile: number;
  sprites: Record<string, SpriteDef>;
  /** Named lists of sprites the renderer picks from (ground_dirt, floor_in, prop_out, ...). */
  groups?: Record<string, string[]>;
}

export class SpriteStore {
  readonly images = new Map<string, HTMLImageElement>();
  baseTile = 64;
  missing = new Set<string>();
  groups: Record<string, string[]> = {};

  async load(manifestUrl = 'assets/manifest.json'): Promise<void> {
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`Could not load ${manifestUrl}`);
    const manifest = (await res.json()) as Manifest;
    this.baseTile = manifest.tile;
    this.groups = manifest.groups ?? {};
    const base = manifestUrl.replace(/[^/]*$/, '');
    await Promise.all(
      Object.entries(manifest.sprites).map(
        ([name, def]) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.images.set(name, img);
              resolve();
            };
            img.onerror = () => {
              console.warn(`Sprite failed to load: ${name} (${def.src})`);
              resolve();
            };
            img.src = base + def.src;
          }),
      ),
    );
  }

  get(name: string): HTMLImageElement | null {
    const img = this.images.get(name) ?? null;
    if (!img && !this.missing.has(name)) {
      this.missing.add(name);
      console.warn(`Missing sprite: ${name}`);
    }
    return img;
  }
}
