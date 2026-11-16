// Minimal login derivation from the kit's program/env/src/wire.ts:
// SCENARIO_SEED 0x6a09e667f3bcc909n, scenarioRng('users'), and generateUsers.
// Only the first user's two name picks are needed; no other scenario data is copied.
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

export function deriveViewerLogin(): string {
  let state = mix64(SCENARIO_SEED ^ fnv1a64('users')) || SCENARIO_SEED;
  const nextInt = (maxExclusive: number): number => {
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      let x = state;
      x = (x ^ (x >> 12n)) & U64_MASK;
      x = (x ^ (x << 25n)) & U64_MASK;
      x = (x ^ (x >> 27n)) & U64_MASK;
      state = x;
      const value = Number(((x * 0x2545f4914f6cdd1dn) & U64_MASK) >> 32n);
      if (value < limit) return value % maxExclusive;
    }
  };
  return `${FIRST_NAMES[nextInt(FIRST_NAMES.length)]}${LAST_NAMES[nextInt(LAST_NAMES.length)]}`.replace(/[^a-z0-9-]/g, '');
}
