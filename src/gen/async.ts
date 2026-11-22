import type { LevelData } from '../core/level.js';
import type { StoryKey } from '../core/types.js';
import type { Difficulty, Region } from './difficulty.js';
import { generateExpedition } from './generate.js';

let worker: Worker | null = null;
let broken = false;
let nextId = 1;
const waiting = new Map<number, { ok: (d: LevelData) => void; fail: (e: string) => void }>();

function spawn(): Worker | null {
  if (broken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; data?: LevelData; error?: string }>) => {
      const p = waiting.get(e.data.id);
      if (!p) return;
      waiting.delete(e.data.id);
      if (e.data.data) p.ok(e.data.data);
      else p.fail(e.data.error ?? 'worker failed');
    };
    w.onerror = () => {
      // module workers unsupported (or blocked): fall back to generating on the main thread
      broken = true;
      worker = null;
      for (const p of waiting.values()) p.fail('worker error');
      waiting.clear();
    };
    worker = w;
    return w;
  } catch {
    broken = true;
    return null;
  }
}

/** Generate an expedition in a Web Worker, falling back to the main thread if workers are unavailable. */
export function generateAsync(difficulty: Difficulty, seed: number, region: Region, story: readonly StoryKey[] = []): Promise<LevelData> {
  const w = spawn();
  const sync = (): Promise<LevelData> => new Promise((res) => window.setTimeout(() => res(generateExpedition(difficulty, seed, region, story).data), 20));
  if (!w) return sync();
  return new Promise<LevelData>((ok, fail) => {
    const id = nextId++;
    waiting.set(id, { ok, fail });
    w.postMessage({ id, difficulty, seed, region, story: [...story] });
  }).catch(sync);
}
