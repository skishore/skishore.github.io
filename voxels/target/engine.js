import { assert, nonnull, Tensor3 } from './base.js';
import { EntityComponentSystem } from './ecs.js';
import { Renderer } from './renderer.js';
import { TerrainMesher } from './mesher.js';
class Container {
    constructor(id) {
        this.element = nonnull(document.getElementById(id), () => id);
        this.canvas = nonnull(this.element.querySelector('canvas'));
        this.stats = nonnull(this.element.querySelector('#stats'));
        this.inputs = {
            up: false,
            left: false,
            down: false,
            right: false,
            space: false,
            pointer: false,
        };
        this.deltas = { x: 0, y: 0, scroll: 0 };
        this.bindings = new Map();
        this.bindings.set('W'.charCodeAt(0), 'up');
        this.bindings.set('A'.charCodeAt(0), 'left');
        this.bindings.set('S'.charCodeAt(0), 'down');
        this.bindings.set('D'.charCodeAt(0), 'right');
        this.bindings.set(' '.charCodeAt(0), 'space');
        const element = this.element;
        element.addEventListener('click', () => element.requestPointerLock());
        document.addEventListener('keydown', e => this.onKeyInput(e, true));
        document.addEventListener('keyup', e => this.onKeyInput(e, false));
        document.addEventListener('mousemove', e => this.onMouseMove(e));
        document.addEventListener('pointerlockchange', e => this.onPointerInput(e));
        document.addEventListener('wheel', e => this.onMouseWheel(e));
    }
    displayStats(stats) {
        this.stats.textContent = stats;
    }
    onKeyInput(e, down) {
        if (!this.inputs.pointer)
            return;
        const input = this.bindings.get(e.keyCode);
        if (input)
            this.onInput(e, input, down);
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
    onPointerInput(e) {
        const locked = document.pointerLockElement === this.element;
        this.onInput(e, 'pointer', locked);
    }
    onInput(e, input, state) {
        this.inputs[input] = state;
        e.stopPropagation();
        e.preventDefault();
    }
}
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
        const result = this.opaque.length;
        this.opaque.push(solid);
        this.solid.push(solid);
        materials.forEach(x => {
            const material = this.ids.get(x);
            if (material === undefined)
                throw new Error(`Unknown material: ${x}`);
            this.faces.push(material + 1);
        });
        return result;
    }
    addMaterialOfColor(name, color) {
        this.addMaterialHelper(name, color, null);
    }
    addMaterialOfTexture(name, texture, color) {
        this.addMaterialHelper(name, color || kWhite, texture);
    }
    // faces has 6 elements for each block type: [+x, -x, +y, -y, +z, -z]
    getBlockFaceMaterial(id, face) {
        return this.faces[id * 6 + face];
    }
    getMaterialData(id) {
        assert(0 < id && id <= this.materials.length);
        return this.materials[id - 1];
    }
    addMaterialHelper(name, color, texture) {
        assert(name.length > 0, () => 'Empty material name!');
        assert(!this.ids.has(name), () => `Duplicate material: ${name}`);
        this.ids.set(name, this.materials.length);
        this.materials.push({ color, texture, textureIndex: 0 });
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
        this.index = next_index < this.ticks.length ? next_index : 0;
        const tick = Math.round(1000 * (this.now.now() - this.last));
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
const kTicksPerSecond = 30;
class Timing {
    constructor(render, update) {
        this.now = performance || Date;
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
        this.renderPerf = new Performance(this.now, 60);
        this.updatePerf = new Performance(this.now, 60);
    }
    renderHandler() {
        requestAnimationFrame(this.renderBinding);
        this.updateHandler();
        const now = this.now.now();
        const dt = now - this.lastRender;
        this.lastRender = now;
        const fraction = (now - this.lastUpdate) / this.updateDelay;
        try {
            this.renderPerf.begin();
            this.render(dt, fraction);
            this.renderPerf.end();
        }
        catch (e) {
            this.render = () => { };
            console.error(e);
        }
    }
    updateHandler() {
        let now = this.now.now();
        const delay = this.updateDelay;
        const limit = now + this.updateLimit;
        while (this.lastUpdate + delay < now) {
            try {
                this.updatePerf.begin();
                this.update(delay);
                this.updatePerf.end();
            }
            catch (e) {
                this.update = () => { };
                console.error(e);
            }
            this.lastUpdate += delay;
            now = this.now.now();
            if (now > limit) {
                this.lastUpdate = now;
                break;
            }
        }
    }
}
;
class Column {
    constructor() {
        this.data = new Uint16Array(2 * kWorldHeight);
        this.last = 0;
        this.size = 0;
    }
    clear() {
        this.last = 0;
        this.size = 0;
    }
    fillChunk(x, z, chunk) {
        let last = 0;
        for (let i = 0; i < this.size; i++) {
            const offset = 2 * i;
            const block = this.data[offset + 0];
            const level = this.data[offset + 1];
            for (let y = last; y < level; y++) {
                chunk.setBlock(x, y, z, block);
            }
            last = level;
        }
    }
    push(block, count) {
        if (count <= 0)
            return;
        const offset = 2 * this.size;
        const last = Math.min(this.last + count, kWorldHeight);
        this.data[offset + 0] = block;
        this.data[offset + 1] = last;
        this.last = last;
        this.size++;
    }
    height() {
        return this.last;
    }
    top(bedrock) {
        if (this.size === 0)
            return bedrock;
        return this.data[2 * this.size - 2];
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kChunkBits = 4;
const kChunkWidth = 1 << kChunkBits;
const kChunkMask = kChunkWidth - 1;
const kWorldHeight = 256;
const kChunkKeyBits = 16;
const kChunkKeySize = 1 << kChunkKeyBits;
const kChunkKeyMask = kChunkKeySize - 1;
const kChunkRadius = 12;
const kNeighbors = (kChunkRadius ? 4 : 0);
const kNumChunksToLoadPerFrame = 1;
const kNumChunksToMeshPerFrame = 1;
const kFrontierLOD = 2;
const kFrontierRadius = 4;
const kNeighborOffsets = (() => {
    const W = kChunkWidth;
    const H = kWorldHeight;
    const L = W - 1;
    const N = W + 1;
    return [
        [[0, 0, 0], [1, 1, 1], [0, 0, 0], [W, H, W]],
        [[-1, 0, 0], [0, 1, 1], [L, 0, 0], [1, H, W]],
        [[1, 0, 0], [N, 1, 1], [0, 0, 0], [1, H, W]],
        [[0, 0, -1], [1, 1, 0], [0, 0, L], [W, H, 1]],
        [[0, 0, 1], [1, 1, N], [0, 0, 0], [W, H, 1]],
    ];
})();
class Chunk {
    constructor(world, cx, cz) {
        this.cx = cx;
        this.cz = cz;
        this.world = world;
        this.active = false;
        this.enabled = false;
        this.finished = false;
        this.requested = false;
        this.distance = 0;
        this.neighbors = kNeighbors;
        this.dirty = true;
        this.solid = null;
        this.water = null;
        this.voxels = null;
    }
    disable() {
        if (!this.enabled)
            return;
        this.world.enabled.delete(this);
        if (this.solid)
            this.solid.dispose();
        if (this.water)
            this.water.dispose();
        this.solid = null;
        this.water = null;
        this.active = false;
        this.enabled = false;
        this.dirty = true;
    }
    enable() {
        this.world.enabled.add(this);
        this.enabled = true;
        this.active = this.checkActive();
    }
    load(loader) {
        assert(!this.voxels);
        this.voxels = new Tensor3(kChunkWidth, kWorldHeight, kChunkWidth);
        const { cx, cz } = this;
        const dx = cx << kChunkBits;
        const dz = cz << kChunkBits;
        const column = new Column();
        for (let x = 0; x < kChunkWidth; x++) {
            for (let z = 0; z < kChunkWidth; z++) {
                loader(x + dx, z + dz, column);
                column.fillChunk(x + dx, z + dz, this);
                column.clear();
            }
        }
        this.finish();
    }
    finish() {
        assert(!this.finished);
        this.finished = true;
        const { cx, cz } = this;
        const neighbor = (x, z) => {
            const chunk = this.world.getChunk(x + cx, z + cz, false);
            if (!(chunk && chunk.finished))
                return;
            chunk.notifyNeighborFinished();
            this.neighbors--;
        };
        neighbor(1, 0);
        neighbor(-1, 0);
        neighbor(0, 1);
        neighbor(0, -1);
        this.active = this.checkActive();
        this.dirty = !!this.voxels;
    }
    getBlock(x, y, z) {
        const voxels = this.voxels;
        if (!voxels)
            return kEmptyBlock;
        const xm = x & kChunkMask, zm = z & kChunkMask;
        return voxels.get(xm, y, zm);
    }
    setBlock(x, y, z, block) {
        const voxels = this.voxels;
        if (!voxels)
            return;
        const xm = x & kChunkMask, zm = z & kChunkMask;
        if (!this.finished)
            return voxels.set(xm, y, zm, block);
        const old = voxels.get(xm, y, zm);
        if (old === block)
            return;
        voxels.set(xm, y, zm, block);
        this.dirty = true;
        const neighbor = (x, y, z) => {
            const { cx, cz } = this;
            const chunk = this.world.getChunk(x + cx, z + cz, false);
            if (chunk)
                chunk.dirty = true;
        };
        if (xm === 0)
            neighbor(-1, 0, 0);
        if (xm === kChunkMask)
            neighbor(1, 0, 0);
        if (zm === 0)
            neighbor(0, 0, -1);
        if (zm === kChunkMask)
            neighbor(0, 0, 1);
    }
    hasMesh() {
        return !!(this.solid || this.water);
    }
    needsRemesh() {
        return this.active && this.dirty;
    }
    remeshChunk() {
        assert(this.dirty);
        this.remeshTerrain();
        this.dirty = false;
    }
    checkActive() {
        return this.enabled && this.finished && this.neighbors === 0;
    }
    notifyNeighborFinished() {
        assert(this.neighbors > 0);
        this.neighbors--;
        this.active = this.checkActive();
    }
    remeshTerrain() {
        const { cx, cz, world } = this;
        const { bedrock, buffer } = world;
        for (const offset of kNeighborOffsets) {
            const [c, dstPos, srcPos, size] = offset;
            const chunk = world.getChunk(cx + c[0], cz + c[2], false);
            chunk && chunk.voxels
                ? this.copyVoxels(buffer, dstPos, chunk.voxels, srcPos, size)
                : this.zeroVoxels(buffer, dstPos, size);
        }
        const x = cx << kChunkBits, z = cz << kChunkBits;
        const meshed = world.mesher.meshChunk(buffer, this.solid, this.water);
        const [solid, water] = meshed;
        if (solid)
            solid.setPosition(x, 0, z);
        if (water)
            water.setPosition(x, 0, z);
        this.solid = solid;
        this.water = water;
    }
    copyVoxels(dst, dstPos, src, srcPos, size) {
        const [ni, nj, nk] = size;
        const [di, dj, dk] = dstPos;
        const [si, sj, sk] = srcPos;
        const dsj = dst.stride[1];
        const ssj = src.stride[1];
        for (let i = 0; i < ni; i++) {
            for (let k = 0; k < nk; k++) {
                // Unroll along the y-axis, since it's the longest chunk dimension.
                let sindex = src.index(si + i, sj, sk + k);
                let dindex = dst.index(di + i, dj, dk + k);
                for (let j = 0; j < nj; j++, dindex += dsj, sindex += ssj) {
                    dst.data[dindex] = src.data[sindex];
                }
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
                let dindex = dst.index(di + i, dj, dk + k);
                for (let j = 0; j < nj; j++, dindex += dsj) {
                    dst.data[dindex] = kEmptyBlock;
                }
            }
        }
    }
}
;
class Counters {
    constructor() {
        this.values = new Map();
    }
    bounds() {
        let min = Infinity, max = -Infinity;
        for (const value of this.values.keys()) {
            if (value < min)
                min = value;
            if (value > max)
                max = value;
        }
        return [min, max];
    }
    dec(value) {
        const count = this.values.get(value) || 0;
        if (count > 1) {
            this.values.set(value, count - 1);
        }
        else {
            assert(count === 1);
            this.values.delete(value);
        }
    }
    inc(value) {
        const count = this.values.get(value) || 0;
        this.values.set(value, count + 1);
    }
}
;
class Frontier {
    constructor(world) {
        this.xs = new Counters();
        this.zs = new Counters();
        this.world = world;
        this.column = new Column();
        this.meshes = new Map();
        assert(kChunkWidth % kFrontierLOD === 0);
        const side = kChunkWidth / kFrontierLOD;
        this.heightmap = new Uint32Array((side + 2) * (side + 2) * 2);
        this.side = side;
    }
    chunkHidden(chunk) {
        if (!chunk.hasMesh())
            return;
        this.xs.dec(chunk.cx);
        this.zs.dec(chunk.cz);
    }
    chunkShown(chunk) {
        if (chunk.hasMesh())
            return;
        this.xs.inc(chunk.cx);
        this.zs.inc(chunk.cz);
    }
    remeshFrontier() {
        const [min_x, max_x] = this.xs.bounds();
        const [min_z, max_z] = this.zs.bounds();
        if (min_x > max_x || min_z > max_z)
            return;
        const r = kFrontierRadius;
        const ax = min_x - r, bx = max_x + r + 1;
        const az = min_z - r, bz = max_z + r + 1;
        const { meshes, world } = this;
        for (let cx = ax; cx < bx; cx++) {
            for (let cz = az; cz < bz; cz++) {
                const key = world.getChunkKey(cx, cz);
                const lod = this.getFrontierChunk(cx, cz, key);
                const chunk = world.getChunkByKey(key);
                const mesh = chunk && chunk.hasMesh();
                if (!mesh && !lod.mesh) {
                    lod.mesh = this.createLODMesh(cx, cz);
                }
                if (lod.mesh)
                    lod.mesh.show(!mesh);
            }
        }
        for (const chunk of this.meshes.values()) {
            const { cx, cz } = chunk;
            const disable = !(ax <= cx && cx < bx && az <= cz && cz < bz);
            if (!disable || !chunk.mesh)
                continue;
            chunk.mesh.dispose();
            chunk.mesh = null;
        }
    }
    createLODMesh(cx, cz) {
        const { column, heightmap, side, world } = this;
        const { bedrock, loader } = world;
        if (!loader)
            return null;
        assert(kFrontierLOD % 2 === 0);
        const lod = kFrontierLOD;
        const x = cx << kChunkBits, z = cz << kChunkBits;
        const ax = x + lod / 2, az = z + lod / 2;
        for (let i = 0; i < side; i++) {
            for (let j = 0; j < side; j++) {
                loader(ax + i * lod, az + j * lod, column);
                const offset = 2 * ((i + 1) + (j + 1) * (side + 2));
                heightmap[offset + 0] = column.top(bedrock);
                heightmap[offset + 1] = column.height();
                column.clear();
            }
        }
        const mesh = this.world.mesher.meshFrontier(heightmap, side + 2, side + 2, lod, null);
        if (mesh)
            mesh.setPosition(x - lod, 0, z - lod);
        return mesh;
    }
    getFrontierChunk(cx, cz, key) {
        const result = this.meshes.get(key);
        if (result)
            return result;
        const created = { cx, cz, mesh: null };
        this.meshes.set(key, created);
        return created;
    }
}
;
class World {
    constructor(registry, renderer) {
        this.chunks = new Map();
        this.enabled = new Set();
        this.renderer = renderer;
        this.registry = registry;
        this.frontier = new Frontier(this);
        this.mesher = new TerrainMesher(registry, renderer);
        this.loader = null;
        this.bedrock = kEmptyBlock;
        const w = kChunkWidth + 2;
        const h = kWorldHeight + 2;
        this.buffer = new Tensor3(w, h, w);
    }
    getBlock(x, y, z) {
        if (y < 0)
            return this.bedrock;
        if (y >= kWorldHeight)
            return kEmptyBlock;
        const cx = x >> kChunkBits, cz = z >> kChunkBits;
        const chunk = this.getChunk(cx, cz, false);
        return chunk && chunk.finished ? chunk.getBlock(x, y, z) : kUnknownBlock;
    }
    setBlock(x, y, z, block) {
        if (!(0 <= y && y < kWorldHeight))
            return;
        const cx = x >> kChunkBits, cz = z >> kChunkBits;
        const chunk = this.getChunk(cx, cz, false);
        if (chunk && chunk.active)
            chunk.setBlock(x, y, z, block);
    }
    getChunk(cx, cz, add) {
        const key = this.getChunkKey(cx, cz);
        const result = this.chunks.get(key);
        if (result)
            return result;
        if (!add)
            return null;
        const chunk = new Chunk(this, cx, cz);
        this.chunks.set(key, chunk);
        return chunk;
    }
    getChunkKey(cx, cz) {
        return (cx & kChunkKeyMask) | ((cz & kChunkKeyMask) << kChunkKeyBits);
    }
    getChunkByKey(key) {
        return this.chunks.get(key) || null;
    }
    setLoader(bedrock, loader) {
        this.bedrock = bedrock;
        this.loader = loader;
        const buffer = this.buffer;
        for (let x = 0; x < buffer.shape[0]; x++) {
            for (let z = 0; z < buffer.shape[2]; z++) {
                buffer.set(x, 0, z, bedrock);
            }
        }
    }
    recenter(x, y, z) {
        const dx = (x >> kChunkBits);
        const dz = (z >> kChunkBits);
        const area = kChunkWidth * kChunkWidth;
        const base = kChunkRadius * kChunkRadius;
        const lo = (base + 1) * area;
        const hi = (base + 9) * area;
        const limit = kChunkRadius + 1;
        const frontier = this.frontier;
        for (const chunk of this.enabled) {
            const { cx, cz } = chunk;
            const ax = Math.abs(cx - dx);
            const az = Math.abs(cz - dz);
            if (ax + az <= 1)
                continue;
            const disable = ax > limit || az > limit ||
                this.distance(cx, cz, x, z) > hi;
            if (!disable)
                continue;
            frontier.chunkHidden(chunk);
            chunk.disable();
        }
        const loader = this.loader;
        if (!loader)
            return;
        const requests = [];
        for (let i = dx - kChunkRadius; i <= dx + kChunkRadius; i++) {
            const ax = Math.abs(i - dx);
            for (let k = dz - kChunkRadius; k <= dz + kChunkRadius; k++) {
                const az = Math.abs(k - dz);
                const distance = this.distance(i, k, x, z);
                if (ax + az > 1 && distance > lo)
                    continue;
                const chunk = nonnull(this.getChunk(i, k, true));
                if (!chunk.requested)
                    requests.push(chunk);
                chunk.distance = distance;
                chunk.enable();
            }
        }
        const n = kNumChunksToLoadPerFrame;
        const m = Math.min(requests.length, n);
        if (requests.length > n) {
            requests.sort((x, y) => x.distance - y.distance);
        }
        for (let i = 0; i < m; i++) {
            const chunk = requests[i];
            chunk.requested = true;
            chunk.load(loader);
        }
    }
    remesh() {
        const queued = [];
        for (const chunk of this.chunks.values()) {
            if (chunk.needsRemesh())
                queued.push(chunk);
        }
        const n = kNumChunksToMeshPerFrame;
        const m = Math.min(queued.length, kNumChunksToMeshPerFrame);
        if (queued.length > n)
            queued.sort((x, y) => x.distance - y.distance);
        const frontier = this.frontier;
        for (let i = 0; i < m; i++) {
            const chunk = queued[i];
            frontier.chunkShown(chunk);
            chunk.remeshChunk();
        }
        frontier.remeshFrontier();
    }
    distance(cx, cz, x, z) {
        const half = kChunkWidth / 2;
        const dx = (cx << kChunkBits) + half - x;
        const dy = (cz << kChunkBits) + half - z;
        return dx * dx + dy * dy;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
class Env {
    constructor(id) {
        this.container = new Container(id);
        this.entities = new EntityComponentSystem();
        this.registry = new Registry();
        this.renderer = new Renderer(this.container.canvas);
        this.world = new World(this.registry, this.renderer);
        this.cameraBlock = kEmptyBlock;
        this.timing = new Timing(this.render.bind(this), this.update.bind(this));
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
        const camera = this.renderer.camera;
        const deltas = this.container.deltas;
        camera.applyInputs(deltas.x, deltas.y, deltas.scroll);
        deltas.x = deltas.y = deltas.scroll = 0;
        this.entities.render(dt);
        this.updateOverlayColor();
        const renderer_stats = this.renderer.render();
        const timing = this.timing;
        if (timing.updatePerf.frame() % 10 !== 0)
            return;
        const stats = `Update: ${this.formatStat(timing.updatePerf)}\r\n` +
            `Render: ${this.formatStat(timing.renderPerf)}\r\n` +
            renderer_stats;
        this.container.displayStats(stats);
    }
    update(dt) {
        if (!this.container.inputs.pointer)
            return;
        this.entities.update(dt);
        this.world.remesh();
    }
    formatStat(perf) {
        const format = (x) => (x / 1000).toFixed(2);
        return `${format(perf.mean())}ms / ${format(perf.max())}ms`;
    }
    updateOverlayColor() {
        const [x, y, z] = this.renderer.camera.position;
        const block = this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
        if (block === this.cameraBlock)
            return;
        const color = (() => {
            if (block === kEmptyBlock)
                return kWhite;
            const material = this.registry.getBlockFaceMaterial(block, 3);
            return this.registry.getMaterialData(material).color;
        })();
        this.cameraBlock = block;
        this.renderer.setOverlayColor(color);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { Column, Env, kWorldHeight };
//# sourceMappingURL=engine.js.map