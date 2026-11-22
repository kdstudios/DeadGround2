/// <reference lib="webworker" />
import { generateExpedition } from './generate.js';
import type { Difficulty, Region } from './difficulty.js';
import type { StoryKey } from '../core/types.js';

/** Map generation (and its guess-free check) off the main thread, so Risky maps never freeze the page. */
self.onmessage = (e: MessageEvent<{ id: number; difficulty: Difficulty; seed: number; region: Region; story?: StoryKey[] }>) => {
  const { id, difficulty, seed, region, story } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, data: generateExpedition(difficulty, seed, region, story ?? []).data });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
