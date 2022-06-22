// https://github.com/joshforisha/open-simplex-noise-js
//
// This is free and unencumbered software released into the public domain
export default function shuffleSeed(seed) {
    const newSeed = new Uint32Array(1);
    newSeed[0] = seed[0] * 1664525 + 1013904223;
    return newSeed;
}
//# sourceMappingURL=shuffle-seed.js.map