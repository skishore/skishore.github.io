import { makeNoise2D } from '../lib/open-simplex-2d.js';
import { int } from './base.js';
import { kChunkWidth, kEmptyBlock, kWorldHeight } from './engine.js';
//////////////////////////////////////////////////////////////////////////////
const kIslandRadius = 1024;
const kSeaLevel = int(kWorldHeight / 4);
const kCaveLevels = 3;
const kCaveDeltaY = 0;
const kCaveHeight = 8;
const kCaveRadius = 16;
const kCaveCutoff = 0.25;
const kCaveWaveHeight = 16;
const kCaveWaveRadius = 256;
;
//////////////////////////////////////////////////////////////////////////////
// Noise helpers:
let noise_counter = (Math.random() * (1 << 30)) | 0;
const noise2D = () => {
    return makeNoise2D(noise_counter++);
};
const minetest_noise_2d = (offset, scale, spread, octaves, persistence, lacunarity) => {
    const components = new Array(octaves).fill(null).map(noise2D);
    const inverse_spread = 1 / spread;
    return (x, y) => {
        let f = 1, g = 1;
        let result = 0;
        x *= inverse_spread;
        y *= inverse_spread;
        for (let i = 0; i < octaves; i++) {
            result += g * components[i](x * f, y * f);
            f *= lacunarity;
            g *= persistence;
        }
        return scale * result + offset;
    };
};
const ridgeNoise = (octaves, persistence, scale) => {
    const components = new Array(4).fill(null).map(noise2D);
    return (x, z) => {
        let result = 0, a = 1, s = scale;
        for (const component of components) {
            result += (1 - Math.abs(component(x * s, z * s))) * a;
            a *= persistence;
            s *= 2;
        }
        return result;
    };
};
// Noises instances used to build the heightmap.
const mgv7_np_cliff_select = minetest_noise_2d(0, 1, 512, 4, 0.7, 2.0);
const mgv7_np_mountain_select = minetest_noise_2d(0, 1, 512, 4, 0.7, 2.0);
const mgv7_np_terrain_ground = minetest_noise_2d(2, 8, 512, 6, 0.6, 2.0);
const mgv7_np_terrain_cliff = minetest_noise_2d(8, 16, 512, 6, 0.6, 2.0);
const mgv7_mountain_ridge = ridgeNoise(8, 0.5, 0.002);
const cave_noises = new Array(2 * kCaveLevels).fill(null).map(noise2D);
// Cave generation.
const carve_caves = (blocks, x, z, column, limit, height) => {
    let max = 0;
    let min = kWorldHeight;
    const start = kSeaLevel - kCaveDeltaY * (kCaveLevels - 1) / 2;
    for (let i = 0; i < kCaveLevels; i++) {
        const carver_noise = cave_noises[2 * i + 0];
        const height_noise = cave_noises[2 * i + 1];
        const carver = carver_noise(x / kCaveRadius, z / kCaveRadius);
        if (carver > kCaveCutoff) {
            const dy = start + i * kCaveDeltaY;
            const height = height_noise(x / kCaveWaveRadius, z / kCaveWaveRadius);
            const offset = int(dy + kCaveWaveHeight * height);
            const blocks = int((carver - kCaveCutoff) * kCaveHeight);
            const ay = int(offset - blocks);
            const by = int(Math.min(offset + blocks + 3, limit));
            for (let i = ay; i < by; i++) {
                column.overwrite(kEmptyBlock, int(i));
            }
            max = int(Math.max(max, by));
            min = int(Math.min(min, ay));
        }
    }
    if (max < height && max < limit && (hash_point(x, z) & 63) === 4) {
        //column.overwrite(blocks.fungi, min);
    }
    return max;
};
// Tree generation.
const randomness = new Uint8Array(1 << 20);
for (let i = 0; i < randomness.length; i++) {
    randomness[i] = (Math.random() * 256) & 0xff;
}
const kMask = int((1 << 10) - 1);
const hash_point = (x, z) => {
    return int(randomness[(((x & kMask) << 10) | (z & kMask))]);
};
;
const kHeightmapResult = { height: 0, tile: kEmptyBlock, snow_depth: 0 };
const heightmap = (x, z, blocks) => {
    const base = Math.sqrt(x * x + z * z) / kIslandRadius;
    const falloff = 16 * base * base;
    if (falloff >= kSeaLevel) {
        kHeightmapResult.height = 0;
        kHeightmapResult.tile = kEmptyBlock;
        kHeightmapResult.snow_depth = 0;
        return kHeightmapResult;
    }
    const cliff_select = mgv7_np_cliff_select(x, z);
    const cliff_x = Math.max(Math.min(16 * Math.abs(cliff_select) - 4, 1), 0);
    const mountain_select = mgv7_np_mountain_select(x, z);
    const mountain_x = Math.sqrt(Math.max(8 * mountain_select, 0));
    const cliff = cliff_x - mountain_x;
    const mountain = -cliff;
    const height_ground = mgv7_np_terrain_ground(x, z);
    const height_cliff = cliff > 0
        ? mgv7_np_terrain_cliff(x, z)
        : height_ground;
    const height_mountain = mountain > 0
        ? height_ground + 64 * Math.pow((mgv7_mountain_ridge(x, z) - 1.25), 1.5)
        : height_ground;
    const height = (() => {
        if (height_mountain > height_ground) {
            return height_mountain * mountain + height_ground * (1 - mountain);
        }
        else if (height_cliff > height_ground) {
            return height_cliff * cliff + height_ground * (1 - cliff);
        }
        return height_ground;
    })();
    const truncated = (height - falloff) | 0;
    const abs_height = truncated + kSeaLevel;
    const tile = (() => {
        if (truncated < -1)
            return blocks.dirt;
        if (height_mountain > height_ground) {
            const base = height - (72 - 8 * mountain);
            return base > 0 ? blocks.snow : blocks.stone;
        }
        if (height_cliff > height_ground)
            return blocks.dirt;
        return truncated < 1 ? blocks.sand : blocks.grass;
    })();
    kHeightmapResult.height = int(abs_height);
    kHeightmapResult.tile = tile;
    kHeightmapResult.snow_depth = tile === blocks.snow
        ? int(height - (72 - 8 * mountain))
        : 0;
    return kHeightmapResult;
};
//////////////////////////////////////////////////////////////////////////////
const kBuffer = 1;
const kExpandedWidth = kChunkWidth + 2 * kBuffer;
const kChunkHeightmap = new Int16Array(3 * kExpandedWidth * kExpandedWidth);
const kCurrentChunk = { cx: Math.PI, cz: Math.PI };
const kNeighborOffsets = [0, 1, -1, kExpandedWidth, -kExpandedWidth];
const kDefaultBlocks = {
    bedrock: kEmptyBlock,
    bush: kEmptyBlock,
    dirt: kEmptyBlock,
    fungi: kEmptyBlock,
    grass: kEmptyBlock,
    rock: kEmptyBlock,
    sand: kEmptyBlock,
    snow: kEmptyBlock,
    stone: kEmptyBlock,
    trunk: kEmptyBlock,
    water: kEmptyBlock,
};
const getHeight = (x, z) => {
    const base = heightmap(x, z, kDefaultBlocks).height;
    return Math.max(Math.min(base, kWorldHeight), 0);
};
const loadChunk = (blocks) => (x, z, column) => {
    const cx = int(Math.floor(x / kChunkWidth));
    const cz = int(Math.floor(z / kChunkWidth));
    const dx = cx * kChunkWidth - kBuffer;
    const dz = cz * kChunkWidth - kBuffer;
    if (cx !== kCurrentChunk.cx || cz !== kCurrentChunk.cz) {
        for (let i = 0; i < kExpandedWidth; i++) {
            for (let j = 0; j < kExpandedWidth; j++) {
                const offset = 3 * (i + j * kExpandedWidth);
                const { height, tile, snow_depth } = heightmap(int(i + dx), int(j + dz), blocks);
                kChunkHeightmap[offset + 0] = height;
                kChunkHeightmap[offset + 1] = tile;
                kChunkHeightmap[offset + 2] = snow_depth;
            }
        }
        kCurrentChunk.cx = cx;
        kCurrentChunk.cz = cz;
    }
    const offset = 3 * ((x - dx) + (z - dz) * kExpandedWidth);
    const height = int(kChunkHeightmap[offset + 0]);
    const tile = kChunkHeightmap[offset + 1];
    const snow_depth = int(kChunkHeightmap[offset + 2]);
    if (tile === blocks.snow) {
        column.push(blocks.stone, int(height - snow_depth));
    }
    else if (tile !== blocks.stone) {
        column.push(blocks.stone, int(height - 4));
        column.push(blocks.dirt, int(height - 1));
    }
    column.push(tile, height);
    column.push(blocks.water, kSeaLevel);
    let limit = kWorldHeight;
    for (const neighbor of kNeighborOffsets) {
        const neighbor_height = int(kChunkHeightmap[offset + 3 * neighbor]);
        if (neighbor_height < kSeaLevel) {
            limit = int(Math.min(limit, neighbor_height - 1));
        }
    }
    const cave_height = carve_caves(blocks, x, z, column, limit, height);
    if (tile === blocks.grass && cave_height < height) {
        const hash = hash_point(x, z) & 63;
        if (hash < 2)
            column.push(blocks.bush, int(height + 1));
        else if (hash < 4)
            column.push(blocks.rock, int(height + 1));
    }
};
const loadFrontier = (blocks) => (x, z, column) => {
    const { height, tile } = heightmap(x, z, blocks);
    column.push(tile, height);
    column.push(blocks.water, kSeaLevel);
};
export { getHeight, loadChunk, loadFrontier };
//# sourceMappingURL=worldgen.js.map