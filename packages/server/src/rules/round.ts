import { mulberry32 } from "@impropster/shared";

/**
 * Dynamic 50/50 split. Seekers take the floor, hiders take the remainder, so an
 * odd lobby always has one more hider than seeker.
 */
export function splitTeams(playerCount: number): { seekers: number; hiders: number } {
  const seekers = Math.floor(playerCount / 2);
  return { seekers, hiders: playerCount - seekers };
}

/** Deterministic Fisher-Yates shuffle seeded per round. */
export function shuffleSeeded<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = result[i];
    const b = result[j];
    if (a === undefined || b === undefined) continue;
    result[i] = b;
    result[j] = a;
  }
  return result;
}
