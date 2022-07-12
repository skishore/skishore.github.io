import { assert, nonnull } from './base.js';
import { Tensor2, Tensor3, Vec3 } from './base.js';
import { EntityComponentSystem } from './ecs.js';
import { Renderer } from './renderer.js';
import { TerrainMesher } from './mesher.js';
import { kSweepResolution, sweep } from './sweep.js';
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
            hover: false,
            space: false,
            mouse0: false,
            mouse1: false,
            pointer: false,
        };
        this.deltas = { x: 0, y: 0, scroll: 0 };
        this.bindings = new Map();
        this.bindings.set('W'.charCodeAt(0), 'up');
        this.bindings.set('A'.charCodeAt(0), 'left');
        this.bindings.set('S'.charCodeAt(0), 'down');
        this.bindings.set('D'.charCodeAt(0), 'right');
        this.bindings.set('E'.charCodeAt(0), 'hover');
        this.bindings.set(' '.charCodeAt(0), 'space');
        const element = this.element;
        element.addEventListener('click', () => element.requestPointerLock());
        document.addEventListener('keydown', e => this.onKeyInput(e, true));
        document.addEventListener('keyup', e => this.onKeyInput(e, false));
        document.addEventListener('mousedown', e => this.onMouseDown(e));
        document.addEventListener('mousemove', e => this.onMouseMove(e));
        document.addEventListener('touchmove', e => this.onMouseMove(e));
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
        let opaque = true;
        materials.forEach(x => {
            const id = this.ids.get(x);
            if (id === undefined)
                throw new Error(`Unknown material: ${x}`);
            const material = id + 1;
            this.faces.push(material);
            const data = this.getMaterialData(material);
            const alphaBlend = data.color[3] < 1;
            const alphaTest = data.texture && data.texture.alphaTest;
            if (alphaBlend || alphaTest)
                opaque = false;
        });
        const result = this.opaque.length;
        this.opaque.push(opaque);
        this.solid.push(solid);
        return result;
    }
    addMaterialOfColor(name, color, liquid = false) {
        this.addMaterialHelper(name, color, liquid, null);
    }
    addMaterialOfTexture(name, texture, color = kWhite, liquid = false) {
        this.addMaterialHelper(name, color, liquid, texture);
    }
    // faces has 6 elements for each block type: [+x, -x, +y, -y, +z, -z]
    getBlockFaceMaterial(id, face) {
        return this.faces[id * 6 + face];
    }
    getMaterialData(id) {
        assert(0 < id && id <= this.materials.length);
        return this.materials[id - 1];
    }
    addMaterialHelper(name, color, liquid, texture) {
        assert(name.length > 0, () => 'Empty material name!');
        assert(!this.ids.has(name), () => `Duplicate material: ${name}`);
        this.ids.set(name, this.materials.length);
        this.materials.push({ color, liquid, texture, textureIndex: 0 });
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
        this.decorations = [];
        this.data = new Uint16Array(2 * kWorldHeight);
        this.last = 0;
        this.size = 0;
    }
    clear() {
        this.decorations.length = 0;
        this.last = 0;
        this.size = 0;
    }
    fillChunk(x, z, chunk) {
        let last = 0;
        for (let i = 0; i < this.size; i++) {
            const offset = 2 * i;
            const block = this.data[offset + 0];
            const level = this.data[offset + 1];
            chunk.setColumn(x, z, last, level - last, block);
            last = level;
        }
        for (let i = 0; i < this.decorations.length; i += 2) {
            const block = this.decorations[i + 0];
            const level = this.decorations[i + 1];
            chunk.setColumn(x, z, level, 1, block);
        }
    }
    overwrite(block, y) {
        if (!(0 <= y && y < kWorldHeight))
            return;
        this.decorations.push(block);
        this.decorations.push(y);
    }
    push(block, height) {
        if (height <= this.last)
            return;
        this.last = Math.min(height, kWorldHeight);
        const offset = 2 * this.size;
        this.data[offset + 0] = block;
        this.data[offset + 1] = this.last;
        this.size++;
    }
    getNthBlock(n, bedrock) {
        return n < 0 ? bedrock : this.data[2 * n + 0];
    }
    getNthLevel(n) {
        return n < 0 ? 0 : this.data[2 * n + 1];
    }
    getSize() {
        return this.size;
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
        this.shift = shift;
        this.mask = (1 << shift) - 1;
    }
    center(center_x, center_z) {
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
            const done = fn(points[i] + center_x, points[i + 1] + center_z);
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
        return ((cz & mask) << shift) | (cx & mask);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kChunkBits = 4;
const kChunkWidth = 1 << kChunkBits;
const kChunkMask = kChunkWidth - 1;
const kWorldHeight = 256;
const kChunkRadius = 12;
const kNumChunksToLoadPerFrame = 1;
const kNumChunksToMeshPerFrame = 1;
const kNumLODChunksToMeshPerFrame = 1;
const kFrontierLOD = 2;
const kFrontierRadius = 8;
const kFrontierLevels = 6;
const kNeighborOffsets = (() => {
    const W = kChunkWidth;
    const H = kWorldHeight;
    const L = W - 1;
    const N = W + 1;
    return [
        [[0, 0, 0], [1, 2, 1], [0, 0, 0], [W, H, W]],
        [[-1, 0, 0], [0, 2, 1], [L, 0, 0], [1, H, W]],
        [[1, 0, 0], [N, 2, 1], [0, 0, 0], [1, H, W]],
        [[0, 0, -1], [1, 2, 0], [0, 0, L], [W, H, 1]],
        [[0, 0, 1], [1, 2, N], [0, 0, 0], [W, H, 1]],
    ];
})();
class Chunk {
    constructor(cx, cz, world, loader) {
        this.dirty = false;
        this.ready = false;
        this.neighbors = 0;
        this.solid = null;
        this.water = null;
        this.cx = cx;
        this.cz = cz;
        this.world = world;
        this.voxels = new Tensor3(kChunkWidth, kWorldHeight, kChunkWidth);
        this.heightmap = new Tensor2(kChunkWidth, kChunkWidth);
        this.load(loader);
    }
    dispose() {
        this.dropMeshes();
        const { cx, cz } = this;
        const neighbor = (x, z) => {
            const chunk = this.world.chunks.get(x + cx, z + cz);
            if (chunk)
                chunk.notifyNeighborDisposed();
        };
        neighbor(1, 0);
        neighbor(-1, 0);
        neighbor(0, 1);
        neighbor(0, -1);
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
        const xm = x & kChunkMask, zm = z & kChunkMask;
        const old = voxels.get(xm, y, zm);
        if (old === block)
            return;
        const index = voxels.index(xm, y, zm);
        voxels.data[index] = block;
        this.dirty = true;
        this.updateHeightmap(xm, zm, index, y, 1, block);
        const neighbor = (x, y, z) => {
            const { cx, cz } = this;
            const chunk = this.world.chunks.get(x + cx, z + cz);
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
    setColumn(x, z, start, count, block) {
        const voxels = this.voxels;
        const xm = x & kChunkMask, zm = z & kChunkMask;
        assert(voxels.stride[1] === 1);
        const index = voxels.index(xm, start, zm);
        voxels.data.fill(block, index, index + count);
        this.updateHeightmap(xm, zm, index, start, count, block);
    }
    hasMesh() {
        return !!(this.solid || this.water);
    }
    needsRemesh() {
        return this.dirty && this.ready;
    }
    remeshChunk() {
        assert(this.dirty);
        this.remeshTerrain();
        this.dirty = false;
    }
    load(loader) {
        const { cx, cz, world } = this;
        const column = world.column;
        const dx = cx << kChunkBits;
        const dz = cz << kChunkBits;
        for (let x = 0; x < kChunkWidth; x++) {
            for (let z = 0; z < kChunkWidth; z++) {
                loader(x + dx, z + dz, column);
                column.fillChunk(x + dx, z + dz, this);
                column.clear();
            }
        }
        const neighbor = (x, z) => {
            const chunk = this.world.chunks.get(x + cx, z + cz);
            if (!chunk)
                return;
            chunk.notifyNeighborLoaded();
            this.neighbors++;
        };
        neighbor(1, 0);
        neighbor(-1, 0);
        neighbor(0, 1);
        neighbor(0, -1);
        this.dirty = true;
        this.ready = this.checkReady();
    }
    checkReady() {
        return this.neighbors === 4;
    }
    dropMeshes() {
        if (this.solid)
            this.solid.dispose();
        if (this.water)
            this.water.dispose();
        this.solid = null;
        this.water = null;
        this.dirty = true;
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
        assert(this.neighbors < 4);
        this.neighbors++;
        this.ready = this.checkReady();
    }
    remeshTerrain() {
        const { cx, cz, world } = this;
        const { bedrock, buffer, heightmap } = world;
        for (const offset of kNeighborOffsets) {
            const [c, dstPos, srcPos, size] = offset;
            const chunk = world.chunks.get(cx + c[0], cz + c[2]);
            if (chunk) {
                this.copyHeightmap(heightmap, dstPos, chunk.heightmap, srcPos, size);
                this.copyVoxels(buffer, dstPos, chunk.voxels, srcPos, size);
            }
            else {
                this.zeroHeightmap(heightmap, dstPos, size, dstPos[1] - srcPos[1]);
                this.zeroVoxels(buffer, dstPos, size);
            }
        }
        const x = cx << kChunkBits, z = cz << kChunkBits;
        const meshed = world.mesher.meshChunk(buffer, heightmap, this.solid, this.water);
        const [solid, water] = meshed;
        if (solid)
            solid.setPosition(x, -1, z);
        if (water)
            water.setPosition(x, -1, z);
        this.solid = solid;
        this.water = water;
    }
    updateHeightmap(xm, zm, index, start, count, block) {
        const end = start + count;
        const offset = this.heightmap.index(xm, zm);
        const height = this.heightmap.data[offset];
        const voxels = this.voxels;
        if (block === kEmptyBlock && start < height && height <= end) {
            assert(voxels.stride[1] === 1);
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
    copyHeightmap(dst, dstPos, src, srcPos, size) {
        const ni = size[0], nk = size[2];
        const di = dstPos[0], dk = dstPos[2];
        const si = srcPos[0], sk = srcPos[2];
        const offset = dstPos[1] - srcPos[1];
        for (let i = 0; i < ni; i++) {
            for (let k = 0; k < nk; k++) {
                const sindex = src.index(si + i, sk + k);
                const dindex = dst.index(di + i, dk + k);
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
                const sindex = src.index(si + i, sj, sk + k);
                const dindex = dst.index(di + i, dj, dk + k);
                dst.data.set(src.data.subarray(sindex, sindex + nj), dindex);
            }
        }
    }
    zeroHeightmap(dst, dstPos, size, offset) {
        const ni = size[0], nk = size[2];
        const di = dstPos[0], dk = dstPos[2];
        for (let i = 0; i < ni; i++) {
            for (let k = 0; k < nk; k++) {
                dst.set(di + i, dk + k, offset);
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
//////////////////////////////////////////////////////////////////////////////
const kMultiMeshBits = 2;
const kMultiMeshSide = 1 << kMultiMeshBits;
const kMultiMeshArea = kMultiMeshSide * kMultiMeshSide;
const kLODSingleMask = (1 << 4) - 1;
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
        if (!this.enabled[index])
            return;
        this.setMask(index, kLODSingleMask);
        this.enabled[index] = false;
        if (this.enabled.some(x => x))
            return;
        for (let i = 0; i < this.meshed.length; i++)
            this.meshed[i] = false;
        if (this.solid)
            this.solid.dispose();
        if (this.water)
            this.water.dispose();
        this.solid = null;
        this.water = null;
        this.mask[0] = this.mask[1] = -1;
    }
    index(chunk) {
        const mask = kMultiMeshSide - 1;
        return ((chunk.cz & mask) << kMultiMeshBits) | (chunk.cx & mask);
    }
    show(index, mask) {
        assert(this.meshed[index]);
        this.setMask(index, mask);
        this.enabled[index] = true;
    }
    setMask(index, mask) {
        const mask_index = index >> 3;
        const mask_shift = (index & 7) * 4;
        this.mask[mask_index] &= ~(kLODSingleMask << mask_shift);
        this.mask[mask_index] |= mask << mask_shift;
        const shown = (this.mask[0] & this.mask[1]) !== -1;
        if (this.solid)
            this.solid.show(this.mask, shown);
        if (this.water)
            this.water.show(this.mask, shown);
    }
}
;
class FrontierChunk {
    constructor(cx, cz, level, mesh) {
        this.cx = cx;
        this.cz = cz;
        this.level = level;
        this.mesh = mesh;
    }
    dispose() {
        const mesh = this.mesh;
        mesh.disable(mesh.index(this));
    }
    hasMesh() {
        const mesh = this.mesh;
        return mesh.meshed[mesh.index(this)];
    }
}
;
class Frontier {
    constructor(world) {
        this.world = world;
        this.meshes = new Map();
        this.levels = [];
        let radius = (kChunkRadius | 0) + 0.5;
        for (let i = 0; i < kFrontierLevels; i++) {
            radius = (radius + kFrontierRadius) / 2;
            this.levels.push(new Circle(radius));
        }
        assert(kChunkWidth % kFrontierLOD === 0);
        const side = kChunkWidth / kFrontierLOD;
        const size = (side + 2) * (side + 2) * 2;
        this.solid_heightmap = new Uint32Array(size);
        this.water_heightmap = new Uint32Array(size);
        this.side = side;
    }
    center(cx, cz) {
        for (const level of this.levels) {
            cx >>= 1;
            cz >>= 1;
            level.center(cx, cz);
        }
    }
    remeshFrontier() {
        for (let i = 0; i < kFrontierLevels; i++) {
            this.computeLODAtLevel(i);
        }
    }
    computeLODAtLevel(l) {
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
        level.each((cx, cz) => {
            let mask = 0;
            for (let i = 0; i < 4; i++) {
                const dx = (cx << 1) + (i & 1 ? 1 : 0);
                const dz = (cz << 1) + (i & 2 ? 1 : 0);
                if (meshed(dx, dz))
                    mask |= (1 << i);
            }
            const shown = mask !== 15;
            const extra = counter < kNumLODChunksToMeshPerFrame;
            const create = shown && (extra || mask !== 0);
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
                counter++;
            }
            lod.mesh.show(lod.mesh.index(lod), mask);
            return false;
        });
    }
    createLODMeshes(chunk) {
        const { side, world } = this;
        const { cx, cz, level, mesh } = chunk;
        const { bedrock, column, loadFrontier, registry } = world;
        const { solid_heightmap, water_heightmap } = this;
        if (!loadFrontier)
            return;
        assert(kFrontierLOD % 2 === 0);
        assert(registry.solid[bedrock]);
        const lshift = kChunkBits + level;
        const lod = kFrontierLOD << level;
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
                    loadFrontier(ax + i * lod, az + j * lod, column);
                    const offset = 2 * ((i + 1) + (j + 1) * (side + 2));
                    const size = column.getSize();
                    const last_block = column.getNthBlock(size - 1, bedrock);
                    const last_level = column.getNthLevel(size - 1);
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
                            const block = column.getNthBlock(i - 2, bedrock);
                            const level = column.getNthLevel(i - 2);
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
            const n = side + 2;
            const px = x + dx - mx - lod;
            const pz = z + dz - mz - lod;
            const mask = k + 4 * mesh.index(chunk);
            mesh.solid = this.world.mesher.meshFrontier(solid_heightmap, mask, px, pz, n, n, lod, mesh.solid, true);
            mesh.water = this.world.mesher.meshFrontier(water_heightmap, mask, px, pz, n, n, lod, mesh.water, false);
        }
        if (mesh.solid)
            mesh.solid.setPosition(mx, 0, mz);
        if (mesh.water)
            mesh.water.setPosition(mx, 0, mz);
        mesh.meshed[mesh.index(chunk)] = true;
    }
    createFrontierChunk(cx, cz, level) {
        const bits = kMultiMeshBits;
        const mesh = this.getOrCreateMultiMesh(cx >> bits, cz >> bits, level);
        return new FrontierChunk(cx, cz, level, mesh);
    }
    getOrCreateMultiMesh(cx, cz, level) {
        const shift = 12;
        const mask = (1 << shift) - 1;
        const base = ((cz & mask) << shift) | (cx & mask);
        const key = base * kFrontierLevels + level;
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
        const w = kChunkWidth + 2;
        const h = kWorldHeight + 3;
        this.buffer = new Tensor3(w, h, w);
        this.heightmap = new Tensor2(w, w);
    }
    getBlock(x, y, z) {
        if (y < 0)
            return this.bedrock;
        if (y >= kWorldHeight)
            return kEmptyBlock;
        const cx = x >> kChunkBits, cz = z >> kChunkBits;
        const chunk = this.chunks.get(cx, cz);
        return chunk ? chunk.getBlock(x, y, z) : kUnknownBlock;
    }
    setBlock(x, y, z, block) {
        if (!(0 <= y && y < kWorldHeight))
            return;
        const cx = x >> kChunkBits, cz = z >> kChunkBits;
        const chunk = this.chunks.get(cx, cz);
        if (chunk)
            chunk.setBlock(x, y, z, block);
    }
    setLoader(bedrock, loadChunk, loadFrontier) {
        this.bedrock = bedrock;
        this.loadChunk = loadChunk;
        this.loadFrontier = loadFrontier || loadChunk;
        const buffer = this.buffer;
        for (let x = 0; x < buffer.shape[0]; x++) {
            for (let z = 0; z < buffer.shape[2]; z++) {
                buffer.set(x, 0, z, bedrock);
                buffer.set(x, 1, z, bedrock);
            }
        }
    }
    recenter(x, y, z) {
        const { chunks, frontier, loadChunk } = this;
        const cx = (x >> kChunkBits);
        const cz = (z >> kChunkBits);
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
        let meshed = 0, total = 0;
        chunks.each((cx, cz) => {
            total++;
            if (total > 9 && meshed >= kNumChunksToMeshPerFrame)
                return true;
            const chunk = chunks.get(cx, cz);
            if (!chunk || !chunk.needsRemesh())
                return false;
            chunk.remeshChunk();
            meshed++;
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
}
;
//////////////////////////////////////////////////////////////////////////////
const kTmpMin = Vec3.create();
const kTmpMax = Vec3.create();
const kTmpDelta = Vec3.create();
const kTmpImpacts = Vec3.create();
const kMinZLowerBound = 0.001;
const kMinZUpperBound = 0.1;
class Env {
    constructor(id) {
        this.cameraAlpha = 0;
        this.cameraBlock = kEmptyBlock;
        this.cameraColor = kWhite;
        this.highlightSide = -1;
        this.shouldMesh = true;
        this.frame = 0;
        this.container = new Container(id);
        this.entities = new EntityComponentSystem();
        this.registry = new Registry();
        this.renderer = new Renderer(this.container.canvas);
        this.world = new World(this.registry, this.renderer);
        this.highlight = this.world.mesher.meshHighlight();
        this.highlightMask = new Int32Array(2);
        this.highlightPosition = Vec3.create();
        this.timing = new Timing(this.render.bind(this), this.update.bind(this));
    }
    getTargetedBlock() {
        return this.highlightSide < 0 ? null : this.highlightPosition;
    }
    getTargetedBlockSide() {
        return this.highlightSide;
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
        this.frame += 1;
        if (this.frame === 65536)
            this.frame = 0;
        const pos = this.frame / 256;
        const rad = 2 * Math.PI * pos;
        const move = 0.25 * (Math.cos(rad) * 0.5 + pos);
        const wave = 0.05 * (Math.sin(rad) + 3);
        const camera = this.renderer.camera;
        const deltas = this.container.deltas;
        camera.applyInputs(deltas.x, deltas.y, deltas.scroll);
        deltas.x = deltas.y = deltas.scroll = 0;
        this.entities.render(dt);
        this.setSafeZoomDistance();
        this.updateHighlightMesh();
        this.updateOverlayColor(wave);
        const renderer_stats = this.renderer.render(move, wave);
        this.shouldMesh = true;
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
        if (!this.shouldMesh)
            return;
        this.shouldMesh = false;
        this.world.remesh();
    }
    formatStat(perf) {
        const format = (x) => (x / 1000).toFixed(2);
        return `${format(perf.mean())}ms / ${format(perf.max())}ms`;
    }
    getRenderBlock(x, y, z) {
        const result = this.world.getBlock(x, y, z);
        return result === kUnknownBlock ? kEmptyBlock : result;
    }
    setSafeZoomDistance() {
        const camera = this.renderer.camera;
        const { direction, target, zoom } = camera;
        const check = (pos) => {
            const block = this.world.getBlock(pos[0], pos[1], pos[2]);
            return !this.registry.solid[block];
        };
        const [x, y, z] = target;
        const buffer = kMinZUpperBound;
        Vec3.set(kTmpMin, x - buffer, y - buffer, z - buffer);
        Vec3.set(kTmpMax, x + buffer, y + buffer, z + buffer);
        Vec3.scale(kTmpDelta, direction, -zoom);
        sweep(kTmpMin, kTmpMax, kTmpDelta, kTmpImpacts, check, true);
        Vec3.add(kTmpDelta, kTmpMin, kTmpMax);
        Vec3.scale(kTmpDelta, kTmpDelta, 0.5);
        Vec3.sub(kTmpDelta, kTmpDelta, target);
        camera.setSafeZoomDistance(Vec3.length(kTmpDelta));
    }
    updateHighlightMesh() {
        const camera = this.renderer.camera;
        const { direction, target, zoom } = camera;
        let move = false;
        this.highlightMask[0] = (1 << 6) - 1;
        const check = (pos) => {
            const [x, y, z] = pos;
            const block = this.world.getBlock(pos[0], pos[1], pos[2]);
            if (!this.registry.solid[block])
                return true;
            let mask = 0;
            for (let d = 0; d < 3; d++) {
                pos[d] += 1;
                const b0 = this.world.getBlock(pos[0], pos[1], pos[2]);
                if (this.registry.solid[b0])
                    mask |= (1 << (2 * d + 0));
                pos[d] -= 2;
                const b1 = this.world.getBlock(pos[0], pos[1], pos[2]);
                if (this.registry.solid[b1])
                    mask |= (1 << (2 * d + 1));
                pos[d] += 1;
            }
            move = pos[0] !== this.highlightPosition[0] ||
                pos[1] !== this.highlightPosition[1] ||
                pos[2] !== this.highlightPosition[2];
            this.highlightMask[0] = mask;
            Vec3.copy(this.highlightPosition, pos);
            return false;
        };
        const buffer = 1 / kSweepResolution;
        const x = ((target[0] * kSweepResolution) | 0) / kSweepResolution;
        const y = ((target[1] * kSweepResolution) | 0) / kSweepResolution;
        const z = ((target[2] * kSweepResolution) | 0) / kSweepResolution;
        Vec3.set(kTmpMin, x - buffer, y - buffer, z - buffer);
        Vec3.set(kTmpMax, x + buffer, y + buffer, z + buffer);
        Vec3.scale(kTmpDelta, direction, 10);
        sweep(kTmpMin, kTmpMax, kTmpDelta, kTmpImpacts, check, true);
        for (let i = 0; i < 3; i++) {
            const impact = kTmpImpacts[i];
            if (impact === 0)
                continue;
            this.highlightSide = 2 * i + (impact < 0 ? 0 : 1);
            break;
        }
        if (move) {
            const pos = this.highlightPosition;
            this.highlight.setPosition(pos[0], pos[1], pos[2]);
        }
        this.highlight.show(this.highlightMask, true);
    }
    updateOverlayColor(wave) {
        const [x, y, z] = this.renderer.camera.position;
        const xi = Math.floor(x), zi = Math.floor(z);
        const yi = Math.floor(y + wave);
        const yf = y + wave - yi;
        const old_block = this.cameraBlock;
        const new_block = this.getRenderBlock(xi, yi, zi);
        this.cameraBlock = new_block;
        const max = kMinZUpperBound;
        const min = kMinZLowerBound;
        const focus = new_block === kEmptyBlock && yf < 2 * max &&
            this.getRenderBlock(xi, yi - 1, zi) !== kEmptyBlock;
        this.renderer.camera.setMinZ(focus ? Math.max(yf / 2, min) : max);
        if (new_block === kEmptyBlock) {
            const changed = new_block !== old_block;
            if (changed)
                this.renderer.setOverlayColor(kWhite);
            return;
        }
        if (new_block !== old_block) {
            const material = this.registry.getBlockFaceMaterial(new_block, 3);
            const color = this.registry.getMaterialData(material).color;
            this.cameraColor = color.slice();
            this.cameraAlpha = color[3];
        }
        const falloff = (() => {
            const max = 2, step = 32;
            const limit = max * step;
            for (let i = 1; i < limit; i++) {
                const other = this.world.getBlock(xi, yi + i, zi);
                if (other === kEmptyBlock)
                    return Math.pow(2, i / step);
            }
            return Math.pow(2, max);
        })();
        this.cameraColor[3] = 1 - (1 - this.cameraAlpha) / falloff;
        this.renderer.setOverlayColor(this.cameraColor);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { Column, Env };
export { kChunkWidth, kEmptyBlock, kWorldHeight };
//# sourceMappingURL=engine.js.map