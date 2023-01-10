import { assert, int, nonnull } from './base.js';
import { Tensor2, Tensor3, Vec3 } from './base.js';
import { EntityComponentSystem } from './ecs.js';
import { Renderer } from './renderer.js';
import { TerrainMesher } from './mesher.js';
import { kSweepResolution, sweep } from './sweep.js';
;
class Container {
    constructor(id) {
        this.element = nonnull(document.getElementById(id), () => id);
        this.canvas = nonnull(this.element.querySelector('canvas'));
        this.stats = document.getElementById('stats');
        this.inputs = {
            up: false,
            left: false,
            down: false,
            right: false,
            hover: false,
            call: false,
            space: false,
            mouse0: false,
            mouse1: false,
            pointer: false,
        };
        this.deltas = { x: 0, y: 0, scroll: 0 };
        this.bindings = new Map();
        this.addBinding('W', 'up');
        this.addBinding('A', 'left');
        this.addBinding('S', 'down');
        this.addBinding('D', 'right');
        this.addBinding('E', 'hover');
        this.addBinding('Q', 'call');
        this.addBinding(' ', 'space');
        const canvas = this.canvas;
        const target = nonnull(this.canvas.parentElement);
        target.addEventListener('click', (e) => {
            if (this.inputs.pointer)
                return;
            this.onMimicPointerLock(e, true);
            this.insistOnPointerLock();
        });
        document.addEventListener('keydown', e => this.onKeyInput(e, true));
        document.addEventListener('keyup', e => this.onKeyInput(e, false));
        document.addEventListener('mousedown', e => this.onMouseDown(e));
        document.addEventListener('mousemove', e => this.onMouseMove(e));
        document.addEventListener('touchmove', e => this.onMouseMove(e));
        document.addEventListener('pointerlockchange', e => this.onPointerInput(e));
        document.addEventListener('wheel', e => this.onMouseWheel(e));
    }
    displayStats(stats) {
        if (this.stats)
            this.stats.textContent = stats;
    }
    addBinding(key, input) {
        assert(key.length === 1);
        this.bindings.set(int(key.charCodeAt(0)), { input, handled: false });
    }
    insistOnPointerLock() {
        if (!this.inputs.pointer)
            return;
        if (document.pointerLockElement === this.canvas)
            return;
        this.canvas.requestPointerLock();
        setTimeout(() => this.insistOnPointerLock(), 100);
    }
    onKeyInput(e, down) {
        if (!this.inputs.pointer)
            return;
        const keycode = int(e.keyCode);
        if (keycode === 27)
            return this.onMimicPointerLock(e, false);
        const binding = this.bindings.get(keycode);
        if (!binding || binding.handled === down)
            return;
        this.onInput(e, binding.input, down);
        binding.handled = down;
    }
    onMouseDown(e) {
        if (!this.inputs.pointer)
            return;
        const button = e.button;
        if (button === 0)
            this.inputs.mouse0 = true;
        if (button !== 0)
            this.inputs.mouse1 = true;
    }
    onMouseMove(e) {
        if (!this.inputs.pointer)
            return;
        this.deltas.x += e.movementX;
        this.deltas.y += e.movementY;
    }
    onMouseWheel(e) {
        if (!this.inputs.pointer)
            return;
        this.deltas.scroll += e.deltaY;
    }
    onMimicPointerLock(e, locked) {
        if (locked)
            this.element.classList.remove('paused');
        if (!locked)
            this.element.classList.add('paused');
        this.onInput(e, 'pointer', locked);
    }
    onPointerInput(e) {
        const locked = document.pointerLockElement === this.canvas;
        this.onMimicPointerLock(e, locked);
    }
    onInput(e, input, state) {
        this.inputs[input] = state;
        e.stopPropagation();
        e.preventDefault();
    }
}
;
;
;
const kBlack = [0, 0, 0, 1];
const kWhite = [1, 1, 1, 1];
const kNoMaterial = 0;
const kEmptyBlock = 0;
const kUnknownBlock = 1;
class Registry {
    constructor() {
        this.opaque = [false, false];
        this.solid = [false, true];
        this.faces = [];
        for (let i = 0; i < 12; i++) {
            this.faces.push(kNoMaterial);
        }
        this.meshes = [null, null];
        this.materials = [];
        this.ids = new Map();
    }
    addBlock(xs, solid) {
        const materials = (() => {
            switch (xs.length) {
                // All faces for this block use same material.
                case 1: return [xs[0], xs[0], xs[0], xs[0], xs[0], xs[0]];
                // xs specifies [top/bottom, sides]
                case 2: return [xs[1], xs[1], xs[0], xs[0], xs[1], xs[1]];
                // xs specifies [top, bottom, sides]
                case 3: return [xs[2], xs[2], xs[0], xs[1], xs[2], xs[2]];
                // xs specifies [+x, -x, +y, -y, +z, -z]
                case 6: return xs;
                // Uninterpretable case.
                default: throw new Error(`Unexpected materials: ${JSON.stringify(xs)}`);
            }
        })();
        let opaque = true;
        materials.forEach(x => {
            const id = this.ids.get(x);
            if (id === undefined)
                throw new Error(`Unknown material: ${x}`);
            const material = id + 1;
            this.faces.push(material);
            const texture = this.getMaterialData(material).texture;
            const alphaBlend = texture.color[3] < 1;
            const alphaTest = texture.alphaTest;
            if (alphaBlend || alphaTest)
                opaque = false;
        });
        const result = this.opaque.length;
        this.opaque.push(opaque);
        this.solid.push(solid);
        this.meshes.push(null);
        return result;
    }
    addBlockMesh(mesh, solid) {
        const result = this.opaque.length;
        for (let i = 0; i < 6; i++)
            this.faces.push(kNoMaterial);
        this.meshes.push(mesh);
        this.opaque.push(false);
        this.solid.push(solid);
        return result;
    }
    addMaterial(name, texture, liquid = false) {
        assert(name.length > 0, () => 'Empty material name!');
        assert(!this.ids.has(name), () => `Duplicate material: ${name}`);
        this.ids.set(name, this.materials.length);
        this.materials.push({ liquid, texture, textureIndex: -1 });
    }
    // faces has 6 elements for each block type: [+x, -x, +y, -y, +z, -z]
    getBlockFaceMaterial(id, face) {
        return this.faces[id * 6 + face];
    }
    getBlockMesh(id) {
        return this.meshes[id];
    }
    getMaterialData(id) {
        assert(0 < id && id <= this.materials.length);
        return this.materials[id - 1];
    }
}
;
//////////////////////////////////////////////////////////////////////////////
class Performance {
    constructor(now, samples) {
        assert(samples > 0);
        this.now = now;
        this.index = 0;
        this.ticks = new Array(samples).fill(0);
        this.last = 0;
        this.sum = 0;
    }
    begin() {
        this.last = this.now.now();
    }
    end() {
        const index = this.index;
        const next_index = index + 1;
        this.index = int(next_index < this.ticks.length ? next_index : 0);
        const tick = int(Math.round(1000 * (this.now.now() - this.last)));
        this.sum += tick - this.ticks[index];
        this.ticks[index] = tick;
    }
    frame() {
        return this.index;
    }
    max() {
        return Math.max.apply(null, this.ticks);
    }
    mean() {
        return this.sum / this.ticks.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kTickResolution = 4;
const kTicksPerFrame = 4;
const kTicksPerSecond = 60;
class Timing {
    constructor(remesh, render, update) {
        this.now = performance || Date;
        this.remesh = remesh;
        this.render = render;
        this.update = update;
        const now = this.now.now();
        this.lastRender = now;
        this.lastUpdate = now;
        this.renderBinding = this.renderHandler.bind(this);
        requestAnimationFrame(this.renderBinding);
        this.updateDelay = 1000 / kTicksPerSecond;
        this.updateLimit = this.updateDelay * kTicksPerFrame;
        const updateInterval = this.updateDelay / kTickResolution;
        setInterval(this.updateHandler.bind(this), updateInterval);
        this.remeshPerf = new Performance(this.now, 60);
        this.renderPerf = new Performance(this.now, 60);
        this.updatePerf = new Performance(this.now, 60);
    }
    renderHandler() {
        requestAnimationFrame(this.renderBinding);
        this.updateHandler();
        const now = this.now.now();
        const dt = (now - this.lastRender) / 1000;
        this.lastRender = now;
        try {
            this.remeshPerf.begin();
            this.remesh(dt);
            this.remeshPerf.end();
            this.renderPerf.begin();
            this.render(dt);
            this.renderPerf.end();
        }
        catch (e) {
            this.onError(e);
        }
    }
    updateHandler() {
        let now = this.now.now();
        const delay = this.updateDelay;
        const limit = now + this.updateLimit;
        while (this.lastUpdate + delay < now) {
            try {
                this.updatePerf.begin();
                this.update(delay / 1000);
                this.updatePerf.end();
            }
            catch (e) {
                this.onError(e);
            }
            this.lastUpdate += delay;
            now = this.now.now();
            if (now > limit) {
                this.lastUpdate = now;
                break;
            }
        }
    }
    onError(e) {
        this.remesh = this.render = this.update = () => { };
        console.error(e);
    }
}
;
class Column {
    constructor() {
        this.last = 0;
        this.size = 0;
        this.reference_size = 0;
        this.decorations = [];
        this.data = new Int16Array(2 * kWorldHeight);
        this.mismatches = new Int16Array(kWorldHeight);
        this.reference_data = new Int16Array(2 * kWorldHeight);
    }
    clear() {
        this.decorations.length = 0;
        this.last = 0;
        this.size = 0;
    }
    fillChunk(x, z, chunk, first) {
        let last = int(0);
        for (let i = 0; i < this.size; i++) {
            const offset = 2 * i;
            const block = this.data[offset + 0];
            const level = int(this.data[offset + 1]);
            chunk.setColumn(x, z, last, int(level - last), block);
            last = level;
        }
        for (let i = 0; i < this.decorations.length; i += 2) {
            const block = this.decorations[i + 0];
            const level = this.decorations[i + 1];
            chunk.setColumn(x, z, level, 1, block);
        }
        this.detectEquiLevelChanges(first);
    }
    fillEquilevels(equilevels) {
        let current = 0;
        const mismatches = this.mismatches;
        for (let i = 0; i < kWorldHeight; i++) {
            current += mismatches[i];
            equilevels[i] = (current === 0 ? 1 : 0);
        }
    }
    overwrite(block, y) {
        if (!(0 <= y && y < kWorldHeight))
            return;
        this.decorations.push(block);
        this.decorations.push(y);
    }
    push(block, height) {
        height = int(Math.min(height, kWorldHeight));
        if (height <= this.last)
            return;
        this.last = height;
        const offset = 2 * this.size;
        this.data[offset + 0] = block;
        this.data[offset + 1] = this.last;
        this.size++;
    }
    getNthBlock(n, bedrock) {
        return n < 0 ? bedrock : this.data[2 * n + 0];
    }
    getNthLevel(n) {
        return n < 0 ? 0 : int(this.data[2 * n + 1]);
    }
    getSize() {
        return this.size;
    }
    detectEquiLevelChanges(first) {
        if (this.last < kWorldHeight) {
            const offset = 2 * this.size;
            this.data[offset + 0] = kEmptyBlock;
            this.data[offset + 1] = kWorldHeight;
            this.size++;
        }
        if (first)
            this.mismatches.fill(0);
        for (let i = 0; i < this.decorations.length; i += 2) {
            const level = this.decorations[i + 1];
            this.mismatches[level]++;
            if (level + 1 < kWorldHeight)
                this.mismatches[level + 1]--;
        }
        if (first) {
            for (let i = 0; i < 2 * this.size; i++) {
                this.reference_data[i] = this.data[i];
            }
            this.reference_size = this.size;
            return;
        }
        let matched = true;
        let di = 0, ri = 0;
        let d_start = 0, r_start = 0;
        while (di < this.size && ri < this.reference_size) {
            const d_offset = 2 * di;
            const d_block = this.data[d_offset + 0];
            const d_limit = this.data[d_offset + 1];
            const r_offset = 2 * ri;
            const r_block = this.reference_data[r_offset + 0];
            const r_limit = this.reference_data[r_offset + 1];
            if (matched !== (d_block === r_block)) {
                const height = Math.max(d_start, r_start);
                this.mismatches[height] += matched ? 1 : -1;
                matched = !matched;
            }
            if (d_limit <= r_limit) {
                d_start = d_limit;
                di++;
            }
            if (r_limit <= d_limit) {
                r_start = r_limit;
                ri++;
            }
        }
        assert(di === this.size);
        assert(ri === this.reference_size);
        assert(d_start === kWorldHeight);
        assert(r_start === kWorldHeight);
    }
}
;
;
class Circle {
    constructor(radius) {
        this.center_x = 0;
        this.center_z = 0;
        const bound = radius * radius;
        const floor = Math.floor(radius);
        const points = [];
        for (let i = -floor; i <= floor; i++) {
            for (let j = -floor; j <= floor; j++) {
                const distance = i * i + j * j;
                if (distance > bound)
                    continue;
                points.push({ i, j, distance });
            }
        }
        points.sort((a, b) => a.distance - b.distance);
        let current = 0;
        this.deltas = new Int32Array(floor + 1);
        this.points = new Int32Array(2 * points.length);
        for (const { i, j } of points) {
            this.points[current++] = i;
            this.points[current++] = j;
            const ai = Math.abs(i), aj = Math.abs(j);
            this.deltas[ai] = Math.max(this.deltas[ai], aj);
        }
        assert(current === this.points.length);
        let shift = 0;
        while ((1 << shift) < 2 * floor + 1)
            shift++;
        this.elements = new Array(1 << (2 * shift)).fill(null);
        this.shift = int(shift);
        this.mask = int((1 << shift) - 1);
    }
    center(center_x, center_z) {
        if (center_x === this.center_x && center_z === this.center_z)
            return;
        this.each((cx, cz) => {
            const ax = Math.abs(cx - center_x);
            const az = Math.abs(cz - center_z);
            if (az <= this.deltas[ax])
                return false;
            const index = this.index(cx, cz);
            const value = this.elements[index];
            if (value === null)
                return false;
            value.dispose();
            this.elements[index] = null;
            return false;
        });
        this.center_x = center_x;
        this.center_z = center_z;
    }
    each(fn) {
        const { center_x, center_z, points } = this;
        const length = points.length;
        for (let i = 0; i < length; i += 2) {
            const done = fn(int(points[i] + center_x), int(points[i + 1] + center_z));
            if (done)
                break;
        }
    }
    get(cx, cz) {
        const value = this.elements[this.index(cx, cz)];
        return value && value.cx === cx && value.cz === cz ? value : null;
    }
    set(cx, cz, value) {
        const index = this.index(cx, cz);
        assert(this.elements[index] === null);
        this.elements[index] = value;
    }
    index(cx, cz) {
        const { mask, shift } = this;
        return int(((cz & mask) << shift) | (cx & mask));
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kChunkBits = int(4);
const kChunkWidth = int(1 << kChunkBits);
const kChunkMask = int(kChunkWidth - 1);
const kHeightBits = int(8);
const kWorldHeight = int(1 << kHeightBits);
const kChunkShiftX = kHeightBits;
const kChunkShiftZ = kHeightBits + kChunkBits;
const kChunkRadius = 12;
const kNumChunksToLoadPerFrame = 1;
const kNumChunksToMeshPerFrame = 1;
const kNumChunksToLightPerFrame = 1;
const kNumLODChunksToMeshPerFrame = 1;
const kFrontierLOD = 2;
const kFrontierRadius = 8;
const kFrontierLevels = 6;
// Enable debug assertions for the equi-levels optimization.
const kCheckEquilevels = false;
const kNeighborOffsets = (() => {
    const W = kChunkWidth;
    const H = kWorldHeight;
    const L = int(W - 1);
    const N = int(W + 1);
    return [
        [[0, 0, 0], [1, 1, 1], [0, 0, 0], [W, H, W]],
        [[-1, 0, 0], [0, 1, 1], [L, 0, 0], [1, H, W]],
        [[1, 0, 0], [N, 1, 1], [0, 0, 0], [1, H, W]],
        [[0, 0, -1], [1, 1, 0], [0, 0, L], [W, H, 1]],
        [[0, 0, 1], [1, 1, N], [0, 0, 0], [W, H, 1]],
        [[-1, 0, 1], [0, 1, N], [L, 0, 0], [1, H, 1]],
        [[1, 0, 1], [N, 1, N], [0, 0, 0], [1, H, 1]],
        [[-1, 0, -1], [0, 1, 0], [L, 0, L], [1, H, 1]],
        [[1, 0, -1], [N, 1, 0], [0, 0, L], [1, H, 1]],
    ];
})();
const kZone = kNeighborOffsets.map(x => ({ x: x[0][0], z: x[0][2] }));
const kNeighbors = kZone.slice(1);
class LightSpread {
    constructor(diff, mask, test) {
        this.diff = diff;
        this.mask = mask;
        this.test = test;
    }
}
const kSpread = [
    new LightSpread(int(-1 << 8), int(0x0f00), int(0x0000)),
    new LightSpread(int(+1 << 8), int(0x0f00), int(0x0f00)),
    new LightSpread(int(-1 << 12), int(0xf000), int(0x0000)),
    new LightSpread(int(+1 << 12), int(0xf000), int(0xf000)),
    new LightSpread(int(-1 << 0), int(0x00ff), int(0x0000)),
    new LightSpread(int(+1 << 0), int(0x00ff), int(0x00ff)),
];
const kSunlightLevel = 0xf;
// If the light at a cell changes from `prev` to `next`, what range
// of lights in neighboring cells may need updating? The bounds are
// inclusive on both sides.
//
// These equations are tricky. We do some casework to derive them:
//
//   - If the light value in a cell drops 8 -> 4, then adjacent cells
//     with lights in {4, 5, 6, 7} may also drop. 8 is too big, since
//     an adjacent cell with the same light has a different source.
//     But 3 is too small: we can cast a light of value 3.
//
//   - If the light value increases from 4 -> 8, then adjacent cells
//     with lights in {3, 4, 5, 6} may increase. 7 is too big, since
//     we can't raise the adjacent light to 8.
//
//   - As a special case, a cell in full sunlight can raise a neighbor
//     (the one right below) to full sunlight, so we include it here.
//     `max - (max < kSunlightLevel ? 1 : 0)` is the max we can cast.
//
// If we allow for blocks that filter more than one light level at a
// time, then the lower bounds fail, but the upper bounds still hold.
//
const maxUpdatedNeighborLight = (next, prev) => {
    const max = int(Math.max(next, prev));
    return int(max - (max < kSunlightLevel ? 1 : 0) - (next > prev ? 1 : 0));
};
const minUpdatedNeighborLight = (next, prev) => {
    const min = int(Math.min(next, prev));
    return int(min - (next > prev ? 1 : 0));
};
class Chunk {
    constructor(cx, cz, world, loader) {
        this.dirty = false;
        this.ready = false;
        this.neighbors = 0;
        this.solid = null;
        this.water = null;
        this.light = null;
        this.stage2_dirty = false;
        this.cx = cx;
        this.cz = cz;
        this.world = world;
        this.instances = new Map();
        this.voxels = new Tensor3(kChunkWidth, kWorldHeight, kChunkWidth);
        this.heightmap = new Tensor2(kChunkWidth, kChunkWidth);
        this.equilevels = new Int8Array(kWorldHeight);
        this.stage1_dirty = [];
        this.stage1_edges = new Set();
        this.stage1_lights = new Tensor3(kChunkWidth, kWorldHeight, kChunkWidth);
        this.stage2_lights = new Map();
        this.load(loader);
        // Check the invariants we use to optimize getBlock.
        const [sx, sy, sz] = this.voxels.stride;
        assert(sx === (1 << kChunkShiftX));
        assert(sz === (1 << kChunkShiftZ));
        assert(sy === 1);
    }
    dispose() {
        this.dropMeshes();
        this.eachNeighbor(x => x.notifyNeighborDisposed());
    }
    getLightLevel(x, y, z) {
        const xm = int(x & kChunkMask), zm = int(z & kChunkMask);
        const index = int((xm << kChunkShiftX) | y | (zm << kChunkShiftZ));
        const light = this.stage2_lights.get(index);
        return light !== undefined ? light : int(this.stage1_lights.data[index]);
    }
    getBlock(x, y, z) {
        const xm = int(x & kChunkMask), zm = int(z & kChunkMask);
        const index = (xm << kChunkShiftX) | y | (zm << kChunkShiftZ);
        return this.voxels.data[index];
    }
    setBlock(x, y, z, block) {
        const voxels = this.voxels;
        const xm = int(x & kChunkMask), zm = int(z & kChunkMask);
        const old = voxels.get(xm, y, zm);
        if (old === block)
            return;
        const index = voxels.index(xm, y, zm);
        voxels.data[index] = block;
        this.dirty = true;
        this.stage1_dirty.push(index);
        this.stage2_dirty = true;
        this.updateHeightmap(xm, zm, index, y, 1, block);
        this.equilevels[y] = 0;
        const neighbor = (x, y, z) => {
            const { cx, cz } = this;
            const chunk = this.world.chunks.get(int(x + cx), int(z + cz));
            if (chunk)
                chunk.dirty = true;
        };
        if (xm === 0)
            neighbor(-1, 0, 0);
        if (zm === 0)
            neighbor(0, 0, -1);
        if (xm === kChunkMask)
            neighbor(1, 0, 0);
        if (zm === kChunkMask)
            neighbor(0, 0, 1);
        if (xm === 0 && zm === 0)
            neighbor(-1, 0, -1);
        if (xm === 0 && zm === kChunkMask)
            neighbor(-1, 0, 1);
        if (xm === kChunkMask && zm === 0)
            neighbor(1, 0, -1);
        if (xm === kChunkMask && zm === kChunkMask)
            neighbor(1, 0, 1);
    }
    setColumn(x, z, start, count, block) {
        const voxels = this.voxels;
        const xm = int(x & kChunkMask), zm = int(z & kChunkMask);
        assert(voxels.stride[1] === 1);
        const index = voxels.index(xm, start, zm);
        voxels.data.fill(block, index, index + count);
        this.updateHeightmap(xm, zm, index, start, count, block);
    }
    hasMesh() {
        return !!(this.solid || this.water);
    }
    needsRelight() {
        return this.stage2_dirty && this.ready && this.hasMesh();
    }
    needsRemesh() {
        return this.dirty && this.ready;
    }
    relightChunk() {
        // Called from remeshChunk to set the meshes' light textures, even if
        // !this.needsRelight(). Each step checks a dirty flag so that's okay.
        this.eachNeighbor(x => x.lightingStage1());
        this.lightingStage1();
        this.lightingStage2();
        this.setLightTexture();
    }
    remeshChunk() {
        assert(this.needsRemesh());
        this.remeshSprites();
        this.remeshTerrain();
        this.relightChunk();
        this.dirty = false;
    }
    load(loader) {
        const { cx, cz, world } = this;
        const column = world.column;
        const dx = cx << kChunkBits;
        const dz = cz << kChunkBits;
        for (let x = 0; x < kChunkWidth; x++) {
            for (let z = 0; z < kChunkWidth; z++) {
                const first = x + z === 0;
                const ax = int(x + dx), az = int(z + dz);
                loader(ax, az, column);
                column.fillChunk(ax, az, this, first);
                column.clear();
            }
        }
        column.fillEquilevels(this.equilevels);
        this.lightingInit();
        if (kCheckEquilevels) {
            for (let y = int(0); y < kWorldHeight; y++) {
                if (this.equilevels[y] === 0)
                    continue;
                const base = this.voxels.get(0, y, 0);
                for (let x = int(0); x < kChunkWidth; x++) {
                    for (let z = int(0); z < kChunkWidth; z++) {
                        assert(this.voxels.get(x, y, z) === base);
                    }
                }
            }
        }
        this.eachNeighbor(chunk => {
            chunk.notifyNeighborLoaded();
            this.neighbors++;
        });
        this.dirty = true;
        this.ready = this.checkReady();
    }
    checkReady() {
        return this.neighbors === kNeighbors.length;
    }
    dropMeshes() {
        var _a, _b, _c;
        this.dropInstancedMeshes();
        if (this.hasMesh()) {
            this.world.frontier.markDirty(0);
        }
        (_a = this.light) === null || _a === void 0 ? void 0 : _a.dispose();
        (_b = this.solid) === null || _b === void 0 ? void 0 : _b.dispose();
        (_c = this.water) === null || _c === void 0 ? void 0 : _c.dispose();
        this.light = null;
        this.solid = null;
        this.water = null;
        this.dirty = true;
    }
    dropInstancedMeshes() {
        const instances = this.instances;
        for (const mesh of instances.values())
            mesh.dispose();
        instances.clear();
    }
    eachNeighbor(fn) {
        const { cx, cz } = this;
        const chunks = this.world.chunks;
        for (const { x, z } of kNeighbors) {
            const chunk = chunks.get(int(x + cx), int(z + cz));
            if (chunk)
                fn(chunk);
        }
    }
    lightingInit() {
        const { heightmap, voxels } = this;
        const opaque = this.world.registry.opaque;
        const lights = this.stage1_lights;
        const dirty = this.stage1_dirty;
        this.stage2_dirty = true;
        // Use for fast bitwise index propagation below.
        assert(lights.stride[0] === kSpread[1].diff);
        assert(lights.stride[1] === kSpread[5].diff);
        assert(lights.stride[2] === kSpread[3].diff);
        assert(heightmap.stride[0] === (kSpread[1].diff >> 8));
        assert(heightmap.stride[1] === (kSpread[3].diff >> 8));
        const data = lights.data;
        data.fill(kSunlightLevel);
        for (let x = int(0); x < kChunkWidth; x++) {
            for (let z = int(0); z < kChunkWidth; z++) {
                const height = heightmap.get(x, z);
                const index = (x << 8) | (z << 12);
                for (let i = 0; i < 4; i++) {
                    const spread = kSpread[i];
                    if ((index & spread.mask) === spread.test)
                        continue;
                    const neighbor_index = int(index + spread.diff);
                    const neighbor = heightmap.data[neighbor_index >> 8];
                    for (let y = height; y < neighbor; y++) {
                        dirty.push(int(neighbor_index + y));
                    }
                }
                if (height > 0) {
                    const below = int(index + height - 1);
                    if (!opaque[voxels.data[below]])
                        dirty.push(below);
                    data.fill(0, index, index + height);
                }
            }
        }
    }
    lightingStage1() {
        if (this.stage1_dirty.length === 0)
            return;
        const heightmap_data = this.heightmap.data;
        const voxels_data = this.voxels.data;
        const opaque = this.world.registry.opaque;
        const lights = this.stage1_lights;
        const edges = this.stage1_edges;
        const data = lights.data;
        assert(lights.shape[0] === (1 << 4));
        assert(lights.shape[2] === (1 << 4));
        assert(lights.stride[0] === (1 << 8));
        assert(lights.stride[2] === (1 << 12));
        // Stage 1 lighting operates on "index" values, which are (x, y, z)
        // coordinates represented as indices into our {lights, voxel} Tensor3.
        let prev = this.stage1_dirty;
        let next = [];
        // Returns true if the given index is on an x-z edge of the chunk.
        const edge = (index) => {
            const x_edge = (((index >> 8) + 1) & 0xf) < 2;
            const z_edge = (((index >> 12) + 1) & 0xf) < 2;
            return x_edge || z_edge;
        };
        // Returns the updated lighting value at the given index. Note that we
        // can never use the `prev` light value in this computation: it can be
        // arbitrarily out-of-date since the chunk contents can change.
        const query = (index) => {
            if (opaque[voxels_data[index]])
                return 0;
            const height = heightmap_data[index >> 8];
            if ((index & 0xff) >= height)
                return kSunlightLevel;
            let max_neighbor = 1;
            for (const spread of kSpread) {
                if ((index & spread.mask) === spread.test)
                    continue;
                const neighbor_index = int(index + spread.diff);
                const neighbor = data[neighbor_index];
                if (neighbor > max_neighbor)
                    max_neighbor = neighbor;
            }
            return int(max_neighbor - 1);
        };
        // Enqueues new indices that may be affected by the given change.
        const enqueue = (index, hi, lo) => {
            for (const spread of kSpread) {
                if ((index & spread.mask) === spread.test)
                    continue;
                const neighbor_index = int(index + spread.diff);
                const neighbor = data[neighbor_index];
                if (lo <= neighbor && neighbor <= hi)
                    next.push(neighbor_index);
            }
        };
        while (prev.length > 0) {
            for (const index of prev) {
                const prev = int(data[index]);
                const next = query(index);
                if (next === prev)
                    continue;
                data[index] = next;
                if (edge(index)) {
                    // The edge lights map only contains cells on the edge that are not
                    // at full sunlight, since the heightmap takes care of the rest.
                    const next_in_map = 1 < next && next < kSunlightLevel;
                    const prev_in_map = 1 < prev && prev < kSunlightLevel;
                    if (next_in_map !== prev_in_map) {
                        if (next_in_map)
                            edges.add(index);
                        else
                            edges.delete(index);
                    }
                }
                const hi = maxUpdatedNeighborLight(next, prev);
                const lo = minUpdatedNeighborLight(next, prev);
                enqueue(index, hi, lo);
            }
            [prev, next] = [next, prev];
            next.length = 0;
        }
        assert(this.stage1_dirty.length === 0);
        this.eachNeighbor(x => x.stage2_dirty = true);
    }
    lightingStage2() {
        if (!this.ready || !this.stage2_dirty)
            return;
        const getIndex = (x, z) => {
            return ((x + 1) | ((z + 1) << 2));
        };
        const { cx, cz } = this;
        const chunks = this.world.chunks;
        const zone = new Array(16).fill(null);
        const data = new Array(16).fill(null);
        for (const { x, z } of kZone) {
            const index = getIndex(x, z);
            const chunk = nonnull(chunks.get(int(x + cx), int(z + cz)));
            data[index] = chunk.stage1_lights.data;
            zone[index] = chunk;
        }
        // Stage 1 lighting tracks nodes by "index", where an index can be used
        // to look up a chunk (x, y, z) coordinate in a Tensor3. Stage 2 lighting
        // deals with multiple chunks, so we deal with "locations". The first 16
        // bits of a location are an index; bits 16:18 are a chunk x coordinate,
        // and bits 18:20 are a chunk z coordinate.
        //
        // To keep the cellular automaton as fast as possible, we update stage 1
        // lighting in place. We must undo these changes at the end of this call,
        // so we track a list of (location, previous value) pairs in `deltas` as
        // we make the updates.
        //
        // To avoid needing Theta(n) heap allocations, we flatten `deltas`.
        const deltas = [];
        const opaque = this.world.registry.opaque;
        let prev = [];
        let next = [];
        for (const { x, z } of kZone) {
            const chunk = nonnull(zone[getIndex(x, z)]);
            const edges = Array.from(chunk.stage1_edges);
            const heightmap = chunk.heightmap.data;
            for (let i = 0; i < 4; i++) {
                const { diff, mask, test } = kSpread[i];
                assert(mask === 0x0f00 || mask === 0xf000);
                const dx = mask === 0x0f00 ? diff >> 8 : 0;
                const dz = mask === 0xf000 ? diff >> 12 : 0;
                const nx = int(x + dx), nz = int(z + dz);
                if (!(-1 <= nx && nx <= 1 && -1 <= nz && nz <= 1))
                    continue;
                const source = test;
                const target = source ^ mask;
                const stride = mask === 0x0f00 ? 0x1000 : 0x0100;
                const neighbor_index = getIndex(nx, nz);
                const neighbor_union = neighbor_index << 16;
                const neighbor_chunk = nonnull(zone[neighbor_index]);
                const neighbor_heightmap = neighbor_chunk.heightmap.data;
                for (const index of edges) {
                    if ((index & mask) !== test)
                        continue;
                    prev.push(((index ^ mask) | neighbor_union));
                }
                let offset = 0;
                for (let j = 0; j < kChunkWidth; j++, offset += stride) {
                    const height = heightmap[(source + offset) >> 8];
                    const neighbor_height = neighbor_heightmap[(target + offset) >> 8];
                    for (let y = height; y < neighbor_height; y++) {
                        prev.push(((target + offset + y) | neighbor_union));
                    }
                }
            }
        }
        // Returns the current light value at a given location.
        const current = (location) => {
            return int(data[location >> 16][location & 0xffff]);
        };
        // Returns the given location, shifted by the delta. If the shift is out
        // of bounds any direction, it'll return -1.
        const shift = (location, spread) => {
            const { diff, mask, test } = spread;
            if ((location & mask) !== test)
                return int(location + diff);
            switch (mask) {
                case 0x00ff: return -1;
                case 0x0f00: {
                    const x = int(((location >> 16) & 0x3) + (diff >> 8));
                    const z = int(((location >> 18) & 0x3));
                    if (!(0 <= x && x <= 2))
                        return -1;
                    return int(((location & 0xffff) ^ mask) | (x << 16) | (z << 18));
                }
                case 0xf000: {
                    const x = int(((location >> 16) & 0x3));
                    const z = int(((location >> 18) & 0x3) + (diff >> 12));
                    if (!(0 <= z && z <= 2))
                        return -1;
                    return int(((location & 0xffff) ^ mask) | (x << 16) | (z << 18));
                }
                default: assert(false);
            }
            return -1;
        };
        // Returns the updated lighting value at the given location.
        //
        // This helper carefully uses the `prev` light level ways that are
        // not possible in stage 1, because we take advantage of the fact that
        // stage 1 lighting is correct when we run stage 2. The stage 2 light at
        // at a cell is always greater than or equal to the stage 1 light, so:
        //
        //   - If the current light level is non-zero, then the cell is definitely
        //     not a solid cell (solid cells always have a light level of 0).
        //
        //   - If the current light level is kSunlightLevel, the maximum level,
        //     then we don't need to examine neighbors; the light is unchanged.
        //     Conversely, if the current light level is less than the max, then
        //     the cell definitely isn't in unobstructed sunlight, since it would
        //     have a stage 1 light of kSunlightLevel in that case.
        //
        const query = (location, prev) => {
            if (prev === kSunlightLevel)
                return kSunlightLevel;
            if (prev === 0) {
                const chunk = zone[location >> 16];
                const index = location & 0xffff;
                if (opaque[chunk.voxels.data[index]])
                    return 0;
            }
            let max_neighbor = 1;
            for (const spread of kSpread) {
                const neighbor_index = shift(location, spread);
                if (neighbor_index >= 0) {
                    const neighbor = current(neighbor_index);
                    if (neighbor > max_neighbor)
                        max_neighbor = neighbor;
                }
            }
            return int(max_neighbor - 1);
        };
        // Enqueues new locations that may be affected by the given change.
        const enqueue = (location, hi, lo) => {
            for (const spread of kSpread) {
                const neighbor_index = shift(location, spread);
                if (neighbor_index >= 0) {
                    const neighbor = current(neighbor_index);
                    if (lo <= neighbor && neighbor <= hi)
                        next.push(neighbor_index);
                }
            }
        };
        while (prev.length > 0) {
            for (const location of prev) {
                // TODO(skishore): If the index is too far from the center given its
                // current light value, drop the update here.
                const prev = current(location);
                const next = query(location, prev);
                if (next === prev)
                    continue;
                data[location >> 16][location & 0xffff] = next;
                deltas.push(location);
                deltas.push(prev);
                const hi = maxUpdatedNeighborLight(next, prev);
                const lo = minUpdatedNeighborLight(next, prev);
                enqueue(location, hi, lo);
            }
            [prev, next] = [next, prev];
            next.length = 0;
        }
        assert(getIndex(0, 0) === 5);
        const input = this.stage1_lights.data;
        const output = this.stage2_lights;
        output.clear();
        for (let i = 0; i < deltas.length; i += 2) {
            const location = deltas[i + 0];
            if ((location >> 16) !== 5)
                continue;
            const index = int(location & 0xffff);
            output.set(index, int(input[index]));
        }
        for (let i = deltas.length - 2; i >= 0; i -= 2) {
            const location = deltas[i + 0];
            data[location >> 16][location & 0xffff] = deltas[i + 1];
        }
        this.stage2_dirty = false;
    }
    notifyNeighborDisposed() {
        assert(this.neighbors > 0);
        this.neighbors--;
        const old = this.ready;
        this.ready = this.checkReady();
        if (old && !this.ready)
            this.dropMeshes();
    }
    notifyNeighborLoaded() {
        assert(this.neighbors < kNeighbors.length);
        this.neighbors++;
        this.ready = this.checkReady();
    }
    remeshSprites() {
        this.dropInstancedMeshes();
        const { equilevels, instances, voxels, world } = this;
        const { registry, renderer } = world;
        const { data, stride } = voxels;
        const bx = this.cx << kChunkBits;
        const bz = this.cz << kChunkBits;
        assert(stride[1] === 1);
        for (let y = int(0); y < kWorldHeight; y++) {
            const block = data[y];
            if (equilevels[y] && !registry.getBlockMesh(block))
                continue;
            for (let x = int(0); x < kChunkWidth; x++) {
                for (let z = int(0); z < kChunkWidth; z++) {
                    const index = voxels.index(x, y, z);
                    const mesh = registry.getBlockMesh(data[index]);
                    if (!mesh)
                        continue;
                    const item = mesh.addInstance();
                    item.setPosition(bx + x + 0.5, y, bz + z + 0.5);
                    instances.set(index, item);
                }
            }
        }
    }
    remeshTerrain() {
        const { cx, cz, world } = this;
        const { bedrock, buffer, heightmap, equilevels } = world;
        equilevels.set(this.equilevels, 1);
        for (const offset of kNeighborOffsets) {
            const [c, dstPos, srcPos, size] = offset;
            const chunk = world.chunks.get(int(cx + c[0]), int(cz + c[2]));
            const delta = int(dstPos[1] - srcPos[1]);
            assert(delta === 1);
            if (chunk) {
                this.copyHeightmap(heightmap, dstPos, chunk.heightmap, srcPos, size);
                this.copyVoxels(buffer, dstPos, chunk.voxels, srcPos, size);
            }
            else {
                this.zeroHeightmap(heightmap, dstPos, size, delta);
                this.zeroVoxels(buffer, dstPos, size);
            }
            if (chunk !== this) {
                this.copyEquilevels(equilevels, chunk, srcPos, size, delta);
            }
        }
        if (kCheckEquilevels) {
            for (let y = int(0); y < buffer.shape[1]; y++) {
                if (equilevels[y] === 0)
                    continue;
                const base = buffer.get(1, y, 1);
                for (let x = int(0); x < buffer.shape[0]; x++) {
                    for (let z = int(0); z < buffer.shape[2]; z++) {
                        if ((x !== 0 && x !== buffer.shape[0] - 1) ||
                            (z !== 0 && z !== buffer.shape[2] - 1)) {
                            assert(buffer.get(x, y, z) === base);
                        }
                    }
                }
            }
        }
        const x = cx << kChunkBits, z = cz << kChunkBits;
        const meshed = world.mesher.meshChunk(buffer, heightmap, equilevels, this.solid, this.water);
        const [solid, water] = meshed;
        solid === null || solid === void 0 ? void 0 : solid.setPosition(x, 0, z);
        water === null || water === void 0 ? void 0 : water.setPosition(x, 0, z);
        this.solid = solid;
        this.water = water;
    }
    setLightTexture() {
        var _a, _b, _c;
        if (!this.hasMesh())
            return;
        // TODO(skishore): Share a texture between the two meshes.
        const saved = new Map();
        const { stage1_lights, stage2_lights } = this;
        const lights = stage1_lights.data;
        for (const [index, value] of stage2_lights.entries()) {
            saved.set(index, lights[index]);
            lights[index] = value;
        }
        (_a = this.light) === null || _a === void 0 ? void 0 : _a.dispose();
        this.light = this.world.renderer.addLightTexture(lights);
        (_b = this.solid) === null || _b === void 0 ? void 0 : _b.setLight(this.light);
        (_c = this.water) === null || _c === void 0 ? void 0 : _c.setLight(this.light);
        for (const [index, instance] of this.instances.entries()) {
            const level = int(Math.min(lights[index] + 1, kSunlightLevel));
            instance.setLight(lighting(level));
        }
        for (const [index, value] of saved.entries()) {
            lights[index] = value;
        }
    }
    updateHeightmap(xm, zm, index, start, count, block) {
        const end = start + count;
        const offset = this.heightmap.index(xm, zm);
        const height = this.heightmap.data[offset];
        const voxels = this.voxels;
        assert(voxels.stride[1] === 1);
        if (block === kEmptyBlock && start < height && height <= end) {
            let i = 0;
            for (; i < start; i++) {
                if (voxels.data[index - i - 1] !== kEmptyBlock)
                    break;
            }
            this.heightmap.data[offset] = start - i;
        }
        else if (block !== kEmptyBlock && height <= end) {
            this.heightmap.data[offset] = end;
        }
    }
    copyEquilevels(dst, chunk, srcPos, size, delta) {
        assert(this.voxels.stride[1] === 1);
        const data = this.voxels.data;
        if (chunk === null) {
            for (let i = 0; i < kWorldHeight; i++) {
                if (dst[i + delta] === 0)
                    continue;
                if (data[i] !== kEmptyBlock)
                    dst[i + delta] = 0;
            }
            return;
        }
        assert(chunk.voxels.stride[1] === 1);
        assert(size[0] === 1 || size[2] === 1);
        const stride = chunk.voxels.stride[size[0] === 1 ? 2 : 0];
        const index = chunk.voxels.index(srcPos[0], srcPos[1], srcPos[2]);
        const limit = stride * (size[0] === 1 ? size[2] : size[0]);
        const chunk_equilevels = chunk.equilevels;
        const chunk_data = chunk.voxels.data;
        for (let i = 0; i < kWorldHeight; i++) {
            if (dst[i + delta] === 0)
                continue;
            const base = data[i];
            if (chunk_equilevels[i] === 1 && chunk_data[i] === base)
                continue;
            for (let offset = 0; offset < limit; offset += stride) {
                if (chunk_data[index + offset + i] === base)
                    continue;
                dst[i + delta] = 0;
                break;
            }
        }
    }
    copyHeightmap(dst, dstPos, src, srcPos, size) {
        const ni = size[0], nk = size[2];
        const di = dstPos[0], dk = dstPos[2];
        const si = srcPos[0], sk = srcPos[2];
        const offset = dstPos[1] - srcPos[1];
        for (let i = 0; i < ni; i++) {
            for (let k = 0; k < nk; k++) {
                const sindex = src.index(int(si + i), int(sk + k));
                const dindex = dst.index(int(di + i), int(dk + k));
                dst.data[dindex] = src.data[sindex] + offset;
            }
        }
    }
    copyVoxels(dst, dstPos, src, srcPos, size) {
        const [ni, nj, nk] = size;
        const [di, dj, dk] = dstPos;
        const [si, sj, sk] = srcPos;
        assert(dst.stride[1] === 1);
        assert(src.stride[1] === 1);
        for (let i = 0; i < ni; i++) {
            for (let k = 0; k < nk; k++) {
                const sindex = src.index(int(si + i), sj, int(sk + k));
                const dindex = dst.index(int(di + i), dj, int(dk + k));
                dst.data.set(src.data.subarray(sindex, sindex + nj), dindex);
            }
        }
    }
    zeroHeightmap(dst, dstPos, size, delta) {
        const ni = size[0], nk = size[2];
        const di = dstPos[0], dk = dstPos[2];
        for (let i = 0; i < ni; i++) {
            for (let k = 0; k < nk; k++) {
                dst.set(int(di + i), int(dk + k), delta);
            }
        }
    }
    zeroVoxels(dst, dstPos, size) {
        const [ni, nj, nk] = size;
        const [di, dj, dk] = dstPos;
        const dsj = dst.stride[1];
        for (let i = 0; i < ni; i++) {
            for (let k = 0; k < nk; k++) {
                // Unroll along the y-axis, since it's the longest chunk dimension.
                let dindex = dst.index(int(di + i), dj, int(dk + k));
                for (let j = 0; j < nj; j++, dindex += dsj) {
                    dst.data[dindex] = kEmptyBlock;
                }
            }
        }
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kMultiMeshBits = int(2);
const kMultiMeshSide = int(1 << kMultiMeshBits);
const kMultiMeshArea = int(kMultiMeshSide * kMultiMeshSide);
const kLODSingleMask = int((1 << 4) - 1);
class LODMultiMesh {
    constructor() {
        this.visible = 0;
        this.solid = null;
        this.water = null;
        this.meshed = new Array(kMultiMeshArea).fill(false);
        this.enabled = new Array(kMultiMeshArea).fill(false);
        this.mask = new Int32Array(2);
        this.mask[0] = this.mask[1] = -1;
    }
    disable(index) {
        var _a, _b;
        if (!this.enabled[index])
            return;
        this.setMask(index, kLODSingleMask);
        this.enabled[index] = false;
        if (this.enabled.some(x => x))
            return;
        for (let i = 0; i < this.meshed.length; i++)
            this.meshed[i] = false;
        (_a = this.solid) === null || _a === void 0 ? void 0 : _a.dispose();
        (_b = this.water) === null || _b === void 0 ? void 0 : _b.dispose();
        this.solid = null;
        this.water = null;
        this.mask[0] = this.mask[1] = -1;
    }
    index(chunk) {
        const mask = kMultiMeshSide - 1;
        return int(((chunk.cz & mask) << kMultiMeshBits) | (chunk.cx & mask));
    }
    show(index, mask) {
        assert(this.meshed[index]);
        this.setMask(index, mask);
        this.enabled[index] = true;
    }
    setMask(index, mask) {
        var _a, _b;
        const mask_index = index >> 3;
        const mask_shift = (index & 7) * 4;
        this.mask[mask_index] &= ~(kLODSingleMask << mask_shift);
        this.mask[mask_index] |= mask << mask_shift;
        const shown = (this.mask[0] & this.mask[1]) !== -1;
        (_a = this.solid) === null || _a === void 0 ? void 0 : _a.show(this.mask, shown);
        (_b = this.water) === null || _b === void 0 ? void 0 : _b.show(this.mask, shown);
    }
}
;
class FrontierChunk {
    constructor(cx, cz, level, mesh, frontier) {
        this.cx = cx;
        this.cz = cz;
        this.level = level;
        this.mesh = mesh;
        this.frontier = frontier;
        this.index = mesh.index(this);
    }
    dispose() {
        if (this.hasMesh()) {
            this.frontier.markDirty(int(this.level + 1));
        }
        this.mesh.disable(this.index);
    }
    hasMesh() {
        return this.mesh.meshed[this.index];
    }
}
;
class Frontier {
    constructor(world) {
        this.world = world;
        this.meshes = new Map();
        this.dirty = [];
        this.levels = [];
        let radius = (kChunkRadius | 0) + 0.5;
        for (let i = 0; i < kFrontierLevels; i++) {
            radius = (radius + kFrontierRadius) / 2;
            this.levels.push(new Circle(radius));
            this.dirty.push(true);
        }
        assert(kChunkWidth % kFrontierLOD === 0);
        const side = int(kChunkWidth / kFrontierLOD);
        const size = int(2 * (side + 2) * (side + 2));
        this.solid_heightmap = new Uint32Array(size);
        this.water_heightmap = new Uint32Array(size);
        this.side = side;
    }
    center(cx, cz) {
        for (const level of this.levels) {
            cx = int(cx >> 1);
            cz = int(cz >> 1);
            level.center(cx, cz);
        }
    }
    markDirty(level) {
        if (level < this.dirty.length)
            this.dirty[level] = true;
    }
    remeshFrontier() {
        for (let i = int(0); i < kFrontierLevels; i++) {
            this.computeLODAtLevel(i);
        }
    }
    computeLODAtLevel(l) {
        if (!this.dirty[l])
            return;
        const world = this.world;
        const level = this.levels[l];
        const meshed = (dx, dz) => {
            if (l > 0) {
                const chunk = this.levels[l - 1].get(dx, dz);
                return chunk !== null && chunk.hasMesh();
            }
            else {
                const chunk = world.chunks.get(dx, dz);
                return chunk !== null && chunk.hasMesh();
            }
        };
        let counter = 0;
        let skipped = false;
        level.each((cx, cz) => {
            let mask = int(0);
            for (let i = 0; i < 4; i++) {
                const dx = int((cx << 1) + (i & 1 ? 1 : 0));
                const dz = int((cz << 1) + (i & 2 ? 1 : 0));
                if (meshed(dx, dz))
                    mask = int(mask | (1 << i));
            }
            const shown = mask !== 15;
            const extra = counter < kNumLODChunksToMeshPerFrame;
            const create = shown && (extra || mask !== 0);
            if (shown && !create)
                skipped = true;
            const existing = level.get(cx, cz);
            if (!existing && !create)
                return false;
            const lod = (() => {
                if (existing)
                    return existing;
                const created = this.createFrontierChunk(cx, cz, l);
                level.set(cx, cz, created);
                return created;
            })();
            if (shown && !lod.hasMesh()) {
                this.createLODMeshes(lod);
                this.markDirty(int(l + 1));
                counter++;
            }
            lod.mesh.show(lod.mesh.index(lod), mask);
            return false;
        });
        this.dirty[l] = skipped;
    }
    createLODMeshes(chunk) {
        var _a, _b;
        const { side, world } = this;
        const { cx, cz, level, mesh } = chunk;
        const { bedrock, column, loadFrontier, registry } = world;
        const { solid_heightmap, water_heightmap } = this;
        if (!loadFrontier)
            return;
        assert(kFrontierLOD % 2 === 0);
        assert(registry.solid[bedrock]);
        const lshift = kChunkBits + level;
        const lod = int(kFrontierLOD << level);
        const x = (2 * cx + 1) << lshift;
        const z = (2 * cz + 1) << lshift;
        // The (x, z) position of the center of the multimesh for this mesh.
        const multi = kMultiMeshSide;
        const mx = (2 * (cx & ~(multi - 1)) + multi) << lshift;
        const mz = (2 * (cz & ~(multi - 1)) + multi) << lshift;
        for (let k = 0; k < 4; k++) {
            const dx = (k & 1 ? 0 : -1 << lshift);
            const dz = (k & 2 ? 0 : -1 << lshift);
            const ax = x + dx + lod / 2;
            const az = z + dz + lod / 2;
            for (let i = 0; i < side; i++) {
                for (let j = 0; j < side; j++) {
                    loadFrontier(int(ax + i * lod), int(az + j * lod), column);
                    const offset = 2 * ((i + 1) + (j + 1) * (side + 2));
                    const size = column.getSize();
                    const last_block = column.getNthBlock(int(size - 1), bedrock);
                    const last_level = column.getNthLevel(int(size - 1));
                    if (registry.solid[last_block]) {
                        solid_heightmap[offset + 0] = last_block;
                        solid_heightmap[offset + 1] = last_level;
                        water_heightmap[offset + 0] = 0;
                        water_heightmap[offset + 1] = 0;
                    }
                    else {
                        water_heightmap[offset + 0] = last_block;
                        water_heightmap[offset + 1] = last_level;
                        for (let i = size; i > 0; i--) {
                            const block = column.getNthBlock(int(i - 2), bedrock);
                            const level = column.getNthLevel(int(i - 2));
                            if (!registry.solid[block])
                                continue;
                            solid_heightmap[offset + 0] = block;
                            solid_heightmap[offset + 1] = level;
                            break;
                        }
                    }
                    column.clear();
                }
            }
            const n = int(side + 2);
            const px = int(x + dx - mx - lod);
            const pz = int(z + dz - mz - lod);
            const mask = int(k + 4 * mesh.index(chunk));
            mesh.solid = this.world.mesher.meshFrontier(solid_heightmap, mask, px, pz, n, n, lod, mesh.solid, true);
            mesh.water = this.world.mesher.meshFrontier(water_heightmap, mask, px, pz, n, n, lod, mesh.water, false);
        }
        (_a = mesh.solid) === null || _a === void 0 ? void 0 : _a.setPosition(mx, 0, mz);
        (_b = mesh.water) === null || _b === void 0 ? void 0 : _b.setPosition(mx, 0, mz);
        mesh.meshed[mesh.index(chunk)] = true;
    }
    createFrontierChunk(cx, cz, level) {
        const bits = kMultiMeshBits;
        const mesh = this.getOrCreateMultiMesh(int(cx >> bits), int(cz >> bits), level);
        const result = new FrontierChunk(cx, cz, level, mesh, this);
        // A FrontierChunk's mesh is just a fragment of data in its LODMultiMesh.
        // That means that we may already have a mesh when we construct the chunk,
        // if we previously disposed it without discarding data in the multi-mesh.
        // We count this case as meshing a chunk and mark l + 1 dirty.
        if (result.hasMesh())
            this.markDirty(int(level + 1));
        return result;
    }
    getOrCreateMultiMesh(cx, cz, level) {
        const shift = 12;
        const mask = (1 << shift) - 1;
        const base = ((cz & mask) << shift) | (cx & mask);
        const key = int(base * kFrontierLevels + level);
        const result = this.meshes.get(key);
        if (result)
            return result;
        const created = new LODMultiMesh();
        this.meshes.set(key, created);
        return created;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
class World {
    constructor(registry, renderer) {
        const radius = (kChunkRadius | 0) + 0.5;
        this.chunks = new Circle(radius);
        this.column = new Column();
        this.renderer = renderer;
        this.registry = registry;
        this.frontier = new Frontier(this);
        this.mesher = new TerrainMesher(registry, renderer);
        this.loadChunk = null;
        this.loadFrontier = null;
        this.bedrock = kEmptyBlock;
        // Add a one-block-wide plane of extra space on each side of our voxels,
        // so that we can include adjacent chunks and use their contents for AO.
        //
        // We add a two-block-wide plane below our voxel data, so that we also
        // have room for a plane of bedrock blocks below this chunk (in case we
        // dig all the way to y = 0).
        const w = int(kChunkWidth + 2);
        const h = int(kWorldHeight + 2);
        this.buffer = new Tensor3(w, h, w);
        this.heightmap = new Tensor2(w, w);
        this.equilevels = new Int8Array(h);
        this.equilevels[0] = this.equilevels[h - 1] = 1;
    }
    getLight(x, y, z) {
        return lighting(this.getLightLevel(x, y, z));
    }
    getBlock(x, y, z) {
        if (y < 0)
            return this.bedrock;
        if (y >= kWorldHeight)
            return kEmptyBlock;
        const cx = int(x >> kChunkBits), cz = int(z >> kChunkBits);
        const chunk = this.chunks.get(cx, cz);
        return chunk ? chunk.getBlock(x, y, z) : kUnknownBlock;
    }
    setBlock(x, y, z, block) {
        if (!(0 <= y && y < kWorldHeight))
            return;
        const cx = int(x >> kChunkBits), cz = int(z >> kChunkBits);
        const chunk = this.chunks.get(cx, cz);
        chunk === null || chunk === void 0 ? void 0 : chunk.setBlock(x, y, z, block);
    }
    setLoader(bedrock, loadChunk, loadFrontier) {
        this.bedrock = bedrock;
        this.loadChunk = loadChunk;
        this.loadFrontier = loadFrontier || loadChunk;
        const buffer = this.buffer;
        for (let x = int(0); x < buffer.shape[0]; x++) {
            for (let z = int(0); z < buffer.shape[2]; z++) {
                buffer.set(x, 0, z, bedrock);
            }
        }
    }
    recenter(x, y, z) {
        const { chunks, frontier, loadChunk } = this;
        const cx = int(Math.floor(x) >> kChunkBits);
        const cz = int(Math.floor(z) >> kChunkBits);
        chunks.center(cx, cz);
        frontier.center(cx, cz);
        if (!loadChunk)
            return;
        let loaded = 0;
        chunks.each((cx, cz) => {
            const existing = chunks.get(cx, cz);
            if (existing)
                return false;
            const chunk = new Chunk(cx, cz, this, loadChunk);
            chunks.set(cx, cz, chunk);
            return (++loaded) === kNumChunksToLoadPerFrame;
        });
    }
    remesh() {
        const { chunks, frontier } = this;
        let lit = 0, meshed = 0, total = 0;
        chunks.each((cx, cz) => {
            total++;
            const canRelight = lit < kNumChunksToLightPerFrame;
            const canRemesh = total <= 9 || meshed < kNumChunksToMeshPerFrame;
            if (!(canRelight || canRemesh))
                return true;
            const chunk = chunks.get(cx, cz);
            if (!chunk)
                return false;
            if (canRemesh && chunk.needsRemesh()) {
                if (!chunk.hasMesh())
                    frontier.markDirty(0);
                chunk.remeshChunk();
                meshed++;
            }
            else if (canRelight && chunk.needsRelight()) {
                chunk.relightChunk();
                lit++;
            }
            return false;
        });
        frontier.remeshFrontier();
    }
    distance(cx, cz, x, z) {
        const half = kChunkWidth / 2;
        const dx = (cx << kChunkBits) + half - x;
        const dy = (cz << kChunkBits) + half - z;
        return dx * dx + dy * dy;
    }
    getLightLevel(x, y, z) {
        if (y < 0)
            return 0;
        if (y >= kWorldHeight)
            return kSunlightLevel;
        const cx = int(x >> kChunkBits), cz = int(z >> kChunkBits);
        const chunk = this.chunks.get(cx, cz);
        return chunk ? chunk.getLightLevel(x, y, z) : kSunlightLevel;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kTmpPos = Vec3.create();
const kTmpMin = Vec3.create();
const kTmpMax = Vec3.create();
const kTmpDelta = Vec3.create();
const kTmpImpacts = Vec3.create();
const kMinZLowerBound = 0.001;
const kMinZUpperBound = 0.1;
const lighting = (x) => Math.pow(0.8, kSunlightLevel - x);
class Env {
    constructor(id) {
        this.highlightSide = -1;
        this.frame = 0;
        this.container = new Container(id);
        this.entities = new EntityComponentSystem();
        this.registry = new Registry();
        this.renderer = new Renderer(this.container.canvas);
        this.world = new World(this.registry, this.renderer);
        this.highlight = this.renderer.addHighlightMesh();
        this.highlightPosition = Vec3.create();
        this.cameraColor = kWhite.slice();
        this.cameraMaterial = kNoMaterial;
        const remesh = this.world.remesh.bind(this.world);
        const render = this.render.bind(this);
        const update = this.update.bind(this);
        this.timing = new Timing(remesh, render, update);
    }
    getTargetedBlock() {
        return this.highlightSide < 0 ? null : this.highlightPosition;
    }
    getTargetedBlockSide() {
        return this.highlightSide;
    }
    setCameraTarget(x, y, z) {
        this.renderer.camera.setTarget(x, y, z);
        this.setSafeZoomDistance();
    }
    refresh() {
        const saved = this.container.inputs.pointer;
        this.container.inputs.pointer = true;
        this.update(0);
        this.render(0);
        this.container.inputs.pointer = saved;
    }
    render(dt) {
        if (!this.container.inputs.pointer)
            return;
        const old_frame = this.frame;
        this.frame = old_frame + 60 * dt;
        if (this.frame > 0xffff)
            this.frame -= 0xffff;
        const pos = this.frame / 256;
        const rad = 2 * Math.PI * pos;
        const move = 0.25 * (Math.cos(rad) * 0.5 + pos);
        const wave = 0.05 * (Math.sin(rad) + 3);
        const camera = this.renderer.camera;
        const deltas = this.container.deltas;
        camera.applyInputs(deltas.x, deltas.y, deltas.scroll);
        deltas.x = deltas.y = deltas.scroll = 0;
        this.entities.render(dt);
        this.updateHighlightMesh();
        this.updateOverlayColor(wave);
        const sparkle = int(old_frame) !== int(this.frame);
        const renderer_stats = this.renderer.render(move, wave, sparkle);
        const timing = this.timing;
        if (timing.renderPerf.frame() % 20 !== 0)
            return;
        const stats = `Update: ${this.formatStat(timing.updatePerf)}\r\n` +
            `Remesh: ${this.formatStat(timing.remeshPerf)}\r\n` +
            `Render: ${this.formatStat(timing.renderPerf)}\r\n` +
            renderer_stats;
        this.container.displayStats(stats);
    }
    update(dt) {
        if (!this.container.inputs.pointer)
            return;
        this.entities.update(dt);
    }
    formatStat(perf) {
        const format = (x) => (x / 1000).toFixed(2);
        return `${format(perf.mean())}ms / ${format(perf.max())}ms`;
    }
    getRenderBlock(x, y, z) {
        const result = this.world.getBlock(x, y, z);
        if (result === kEmptyBlock || result === kUnknownBlock ||
            this.registry.getBlockFaceMaterial(result, 3) === kNoMaterial) {
            return kEmptyBlock;
        }
        return result;
    }
    setSafeZoomDistance() {
        const camera = this.renderer.camera;
        const { direction, target, zoom } = camera;
        const [x, y, z] = target;
        const check = (x, y, z) => {
            const block = this.world.getBlock(x, y, z);
            return !this.registry.opaque[block];
        };
        const shift_target = (delta, bump) => {
            const buffer = kMinZUpperBound;
            Vec3.set(kTmpMin, x - buffer, y - buffer + bump, z - buffer);
            Vec3.set(kTmpMax, x + buffer, y + buffer + bump, z + buffer);
            sweep(kTmpMin, kTmpMax, kTmpDelta, kTmpImpacts, check, true);
            Vec3.add(kTmpDelta, kTmpMin, kTmpMax);
            Vec3.scale(kTmpDelta, kTmpDelta, 0.5);
            Vec3.sub(kTmpDelta, kTmpDelta, target);
            return Vec3.length(kTmpDelta);
        };
        const safe_zoom_at = (bump) => {
            Vec3.scale(kTmpDelta, direction, -zoom);
            return shift_target(kTmpDelta, bump);
        };
        const max_bump = () => {
            Vec3.set(kTmpDelta, 0, 0.5, 0);
            return shift_target(kTmpDelta, 0);
        };
        let limit = 1;
        let best_bump = -1;
        let best_zoom = -1;
        const step_size = 1 / 64;
        for (let i = 0; i < limit; i++) {
            const bump_at = i * step_size;
            const zoom_at = safe_zoom_at(bump_at) - bump_at;
            if (zoom_at < best_zoom)
                continue;
            best_bump = bump_at;
            best_zoom = zoom_at;
            if (zoom_at > zoom - bump_at - step_size)
                break;
            if (i === 0)
                limit = Math.floor(max_bump() / step_size);
        }
        camera.setSafeZoomDistance(best_bump, best_zoom);
    }
    updateHighlightMesh() {
        const camera = this.renderer.camera;
        const { direction, target, zoom } = camera;
        let move = false;
        this.highlight.mask = int((1 << 6) - 1);
        this.highlightSide = -1;
        const check = (x, y, z) => {
            const block = this.world.getBlock(x, y, z);
            if (!this.registry.solid[block])
                return true;
            let mask = 0;
            const pos = kTmpPos;
            Vec3.set(pos, x, y, z);
            for (let d = 0; d < 3; d++) {
                pos[d] += 1;
                const b0 = this.world.getBlock(int(pos[0]), int(pos[1]), int(pos[2]));
                if (this.registry.opaque[b0])
                    mask |= (1 << (2 * d + 0));
                pos[d] -= 2;
                const b1 = this.world.getBlock(int(pos[0]), int(pos[1]), int(pos[2]));
                if (this.registry.opaque[b1])
                    mask |= (1 << (2 * d + 1));
                pos[d] += 1;
            }
            move = pos[0] !== this.highlightPosition[0] ||
                pos[1] !== this.highlightPosition[1] ||
                pos[2] !== this.highlightPosition[2];
            this.highlight.mask = int(mask);
            Vec3.copy(this.highlightPosition, pos);
            return false;
        };
        const buffer = 1 / kSweepResolution;
        const x = Math.floor(target[0] * kSweepResolution) / kSweepResolution;
        const y = Math.floor(target[1] * kSweepResolution) / kSweepResolution;
        const z = Math.floor(target[2] * kSweepResolution) / kSweepResolution;
        Vec3.set(kTmpMin, x - buffer, y - buffer, z - buffer);
        Vec3.set(kTmpMax, x + buffer, y + buffer, z + buffer);
        Vec3.scale(kTmpDelta, direction, 10);
        sweep(kTmpMin, kTmpMax, kTmpDelta, kTmpImpacts, check, true);
        for (let i = 0; i < 3; i++) {
            const impact = kTmpImpacts[i];
            if (impact === 0)
                continue;
            this.highlightSide = int(2 * i + (impact < 0 ? 0 : 1));
            break;
        }
        if (move) {
            const pos = this.highlightPosition;
            this.highlight.setPosition(pos[0], pos[1], pos[2]);
        }
    }
    updateOverlayColor(wave) {
        const [x, y, z] = this.renderer.camera.position;
        const xi = int(Math.floor(x));
        const yi = int(Math.floor(y));
        const zi = int(Math.floor(z));
        let boundary = 1;
        // We should only apply wave if the block above a liquid is an air block.
        const new_block = (() => {
            const below = this.getRenderBlock(xi, yi, zi);
            if (below === kEmptyBlock)
                return below;
            const above = this.getRenderBlock(xi, int(yi + 1), zi);
            if (above !== kEmptyBlock)
                return below;
            const delta = y + wave - yi - 1;
            boundary = Math.abs(delta);
            return delta > 0 ? kEmptyBlock : below;
        })();
        const new_material = (() => {
            if (new_block === kEmptyBlock)
                return kNoMaterial;
            return this.registry.getBlockFaceMaterial(new_block, 3);
        })();
        const old_material = this.cameraMaterial;
        this.cameraMaterial = new_material;
        const max = kMinZUpperBound;
        const min = kMinZLowerBound;
        const minZ = Math.max(Math.min(boundary / 2, max), min);
        this.renderer.camera.setMinZ(minZ);
        if (new_material === kNoMaterial) {
            const changed = new_material !== old_material;
            if (changed)
                this.renderer.setOverlayColor(kWhite);
            return;
        }
        const color = this.registry.getMaterialData(new_material).texture.color;
        const light = this.world.getLight(xi, yi, zi);
        const saved = this.cameraColor;
        saved[0] = color[0] * light;
        saved[1] = color[1] * light;
        saved[2] = color[2] * light;
        saved[3] = color[3];
        this.renderer.setOverlayColor(saved);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { Column, Env };
export { kChunkWidth, kEmptyBlock, kNoMaterial, kWorldHeight };
//# sourceMappingURL=engine.js.map