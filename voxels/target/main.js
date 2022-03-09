import { sweep } from './sweep.js';
const assert = (x, message) => {
    if (x)
        return;
    throw new Error(message ? message() : 'Assertion failed!');
};
const drop = (xs, x) => {
    for (let i = 0; i < xs.length; i++) {
        if (xs[i] !== x)
            continue;
        xs[i] = xs[xs.length - 1];
        xs.pop();
        return;
    }
};
const nonnull = (x, message) => {
    if (x !== null)
        return x;
    throw new Error(message ? message() : 'Unexpected null!');
};
const Vec3 = {
    create: () => [0, 0, 0],
    from: (x, y, z) => [x, y, z],
    copy: (d, a) => {
        d[0] = a[0];
        d[1] = a[1];
        d[2] = a[2];
    },
    set: (d, x, y, z) => {
        d[0] = x;
        d[1] = y;
        d[2] = z;
    },
    add: (d, a, b) => {
        d[0] = a[0] + b[0];
        d[1] = a[1] + b[1];
        d[2] = a[2] + b[2];
    },
    sub: (d, a, b) => {
        d[0] = a[0] - b[0];
        d[1] = a[1] - b[1];
        d[2] = a[2] - b[2];
    },
    rotateX: (d, a, r) => {
        const sin = Math.sin(r);
        const cos = Math.cos(r);
        const ax = a[0], ay = a[1], az = a[2];
        d[0] = ax;
        d[1] = ay * cos - az * sin;
        d[2] = ay * sin + az * cos;
    },
    rotateY: (d, a, r) => {
        const sin = Math.sin(r);
        const cos = Math.cos(r);
        const ax = a[0], ay = a[1], az = a[2];
        d[0] = az * sin + ax * cos;
        d[1] = ay;
        d[2] = az * cos - ax * sin;
    },
    rotateZ: (d, a, r) => {
        const sin = Math.sin(r);
        const cos = Math.cos(r);
        const ax = a[0], ay = a[1], az = a[2];
        d[0] = ax * cos - ay * sin;
        d[1] = ax * sin + ay * cos;
        d[2] = az;
    },
    scale: (d, a, k) => {
        d[0] = a[0] * k;
        d[1] = a[1] * k;
        d[2] = a[2] * k;
    },
    scaleAndAdd: (d, a, b, k) => {
        d[0] = a[0] + b[0] * k;
        d[1] = a[1] + b[1] * k;
        d[2] = a[2] + b[2] * k;
    },
    length: (a) => {
        const x = a[0], y = a[1], z = a[2];
        return Math.sqrt(x * x + y * y + z * z);
    },
    normalize: (d, a) => {
        const length = Vec3.length(a);
        if (length !== 0)
            Vec3.scale(d, a, 1 / length);
    },
};
class Tensor3 {
    constructor(x, y, z) {
        this.data = new Uint32Array(x * y * z);
        this.shape = [x, y, z];
        this.stride = [1, x, x * y];
    }
    get(x, y, z) {
        return this.data[this.index(x, y, z)];
    }
    set(x, y, z, value) {
        this.data[this.index(x, y, z)] = value;
    }
    index(x, y, z) {
        return x * this.stride[0] + y * this.stride[1] + z * this.stride[2];
    }
}
;
//////////////////////////////////////////////////////////////////////////////
// The game engine:
const Constants = {
    CHUNK_SIZE: 16,
    CHUNK_KEY_BITS: 8,
    TICK_RESOLUTION: 4,
    TICKS_PER_FRAME: 4,
    TICKS_PER_SECOND: 30,
    CAMERA_SENSITIVITY: 10,
};
class Container {
    constructor(id) {
        this.element = nonnull(document.getElementById(id), () => id);
        this.canvas = nonnull(this.element.querySelector('canvas'));
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
        element.addEventListener('keydown', e => this.onKeyInput(e, true));
        element.addEventListener('keyup', e => this.onKeyInput(e, false));
        element.addEventListener('click', () => element.requestPointerLock());
        document.addEventListener('pointerlockchange', e => this.onPointerInput(e));
        document.addEventListener('mousemove', e => this.onMouseMove(e));
        document.addEventListener('wheel', e => this.onMouseWheel(e));
    }
    onKeyInput(e, down) {
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
const kBlack = [0, 0, 0];
const kWhite = [1, 1, 1];
const kNoMaterial = 0;
class Registry {
    constructor() {
        this._opaque = [false];
        this._solid = [false];
        this._meshes = [null];
        this._faces = [];
        for (let i = 0; i < 6; i++)
            this._faces.push(kNoMaterial);
        this._materials = [];
        this._ids = new Map();
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
        const result = this._opaque.length;
        this._opaque.push(solid);
        this._solid.push(solid);
        this._meshes.push(null);
        materials.forEach(x => {
            const material = this._ids.get(x);
            if (material === undefined)
                throw new Error(`Unknown material: ${x}`);
            this._faces.push(material + 1);
        });
        return result;
    }
    addBlockSprite(url, solid, scene) {
        const mode = BABYLON.Texture.NEAREST_SAMPLINGMODE;
        const texture = new BABYLON.Texture(url, scene, true, true, mode);
        texture.uScale = texture.vScale = 0.99;
        texture.hasAlpha = true;
        const material = new BABYLON.StandardMaterial(`material-${url}`, scene);
        material.specularColor.copyFromFloats(0, 0, 0);
        material.emissiveColor.copyFromFloats(1, 1, 1);
        material.backFaceCulling = false;
        material.diffuseTexture = texture;
        const mesh = BABYLON.Mesh.CreatePlane(`block-${url}`, 1, scene);
        mesh.material = material;
        const result = this._opaque.length;
        this._opaque.push(false);
        this._solid.push(solid);
        this._meshes.push(mesh);
        for (let i = 0; i < 6; i++)
            this._faces.push(kNoMaterial);
        return result;
    }
    addMaterialOfColor(name, color, alpha = 1.0) {
        this.addMaterialHelper(name, alpha, color, null, false);
    }
    addMaterialOfTexture(name, texture, textureAlpha = false) {
        this.addMaterialHelper(name, 1, kWhite, texture, textureAlpha);
    }
    // faces has 6 elements for each block type: [+x, -x, +y, -y, +z, -z]
    getBlockFaceMaterial(id, face) {
        return this._faces[id * 6 + face];
    }
    getMaterial(id) {
        assert(0 < id && id <= this._materials.length);
        return this._materials[id - 1];
    }
    addMaterialHelper(name, alpha, color, texture, textureAlpha) {
        assert(name.length > 0, () => 'Empty material name!');
        assert(!this._ids.has(name), () => `Duplicate material: ${name}`);
        this._ids.set(name, this._materials.length);
        this._materials.push({ alpha, color, texture, textureAlpha });
    }
}
;
//////////////////////////////////////////////////////////////////////////////
class Camera {
    constructor(scene) {
        const origin = new BABYLON.Vector3(0, 0, 0);
        this.holder = new BABYLON.TransformNode('holder', scene);
        this.camera = new BABYLON.FreeCamera('camera', origin, scene);
        this.camera.parent = this.holder;
        this.camera.minZ = 0.01;
        this.pitch = 0;
        this.heading = 0;
        this.zoom = 0;
        this.direction = Vec3.create();
    }
    applyInputs(dx, dy, dscroll) {
        let pitch = this.holder.rotation.x;
        let heading = this.holder.rotation.y;
        // Overwatch uses the same constant values to do this conversion.
        const conversion = 0.0066 * Math.PI / 180;
        dx = dx * Constants.CAMERA_SENSITIVITY * conversion;
        dy = dy * Constants.CAMERA_SENSITIVITY * conversion;
        this.heading += dx;
        const T = 2 * Math.PI;
        while (this.heading < 0)
            this.heading += T;
        while (this.heading > T)
            this.heading -= T;
        const U = Math.PI / 2 - 0.01;
        this.pitch = Math.max(-U, Math.min(U, this.pitch + dy));
        this.holder.rotation.x = this.pitch;
        this.holder.rotation.y = this.heading;
        const dir = this.direction;
        Vec3.set(dir, 0, 0, 1);
        Vec3.rotateX(dir, dir, this.pitch);
        Vec3.rotateY(dir, dir, this.heading);
        // Scrolling is trivial to apply: add and clamp.
        if (dscroll === 0)
            return;
        this.zoom = Math.max(0, Math.min(10, this.zoom + Math.sign(dscroll)));
    }
    setTarget(x, y, z) {
        Vec3.set(kTmpPos, x, y, z);
        Vec3.scaleAndAdd(kTmpPos, kTmpPos, this.direction, -this.zoom);
        this.holder.position.copyFromFloats(kTmpPos[0], kTmpPos[1], kTmpPos[2]);
    }
}
;
class Renderer {
    constructor(container) {
        const antialias = true;
        const options = { preserveDrawingBuffer: true };
        this.engine = new BABYLON.Engine(container.canvas, antialias, options);
        this.scene = new BABYLON.Scene(this.engine);
        const source = new BABYLON.Vector3(0.1, 1.0, 0.3);
        this.light = new BABYLON.HemisphericLight('light', source, this.scene);
        this.scene.clearColor = new BABYLON.Color4(0.8, 0.9, 1.0);
        this.scene.ambientColor = new BABYLON.Color3(1, 1, 1);
        this.light.diffuse = new BABYLON.Color3(1, 1, 1);
        this.light.specular = new BABYLON.Color3(1, 1, 1);
        const scene = this.scene;
        scene.detachControl();
        scene._addComponent(new BABYLON.OctreeSceneComponent(scene));
        this.camera = new Camera(scene);
        this.octree = new BABYLON.Octree(() => { });
        this.octree.blocks = [];
        scene._selectionOctree = this.octree;
        this.blocks = new Map();
    }
    addMesh(mesh, dynamic) {
        if (dynamic) {
            const meshes = this.octree.dynamicContent;
            mesh.onDisposeObservable.add(() => drop(meshes, mesh));
            meshes.push(mesh);
            return;
        }
        const key = this.getMeshKey(mesh);
        const block = this.getMeshBlock(mesh, key);
        mesh.onDisposeObservable.add(() => {
            drop(block.entries, mesh);
            if (block.entries.length)
                return;
            drop(this.octree.blocks, block);
            this.blocks.delete(key);
        });
        block.entries.push(mesh);
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.freezeWorldMatrix();
        mesh.freezeNormals();
    }
    render() {
        this.engine.beginFrame();
        this.scene.render();
        this.engine.endFrame();
    }
    getMeshKey(mesh) {
        assert(!mesh.parent);
        const pos = mesh.position;
        const mod = Constants.CHUNK_SIZE;
        assert(pos.x % mod === 0);
        assert(pos.y % mod === 0);
        assert(pos.z % mod === 0);
        const bits = Constants.CHUNK_KEY_BITS;
        const mask = (1 << bits) - 1;
        return (((pos.x / mod) & mask) << (0 * bits)) |
            (((pos.y / mod) & mask) << (1 * bits)) |
            (((pos.z / mod) & mask) << (2 * bits));
    }
    getMeshBlock(mesh, key) {
        const cached = this.blocks.get(key);
        if (cached)
            return cached;
        const pos = mesh.position;
        const mod = Constants.CHUNK_SIZE;
        const min = new BABYLON.Vector3(pos.x, pos.y, pos.z);
        const max = new BABYLON.Vector3(pos.x + mod, pos.y + mod, pos.z + mod);
        const block = new BABYLON.OctreeBlock(min, max, 0, 0, 0, () => { });
        this.octree.blocks.push(block);
        this.blocks.set(key, block);
        return block;
    }
}
;
class TerrainMesher {
    constructor(scene, registry) {
        this.scene = scene;
        this.flatMaterial = this.makeStandardMaterial('flat-material');
        this.registry = registry;
        this.requests = 0;
        const shim = {
            registry: {
                _solidityLookup: registry._solid,
                _opacityLookup: registry._opaque,
                getBlockFaceMaterial: registry.getBlockFaceMaterial.bind(registry),
                getMaterialData: (x) => registry.getMaterial(x),
                getMaterialTexture: (x) => registry.getMaterial(x).texture,
                _getMaterialVertexColor: (x) => registry.getMaterial(x).color,
            },
            rendering: {
                useAO: true,
                aoVals: [0.93, 0.8, 0.5],
                revAoVal: 1.0,
                flatMaterial: this.flatMaterial,
                addMeshToScene: () => { },
                makeStandardMaterial: this.makeStandardMaterial.bind(this),
                getScene: () => scene,
            },
        };
        this.mesher = new NoaTerrainMesher(shim);
    }
    makeStandardMaterial(name) {
        const result = new BABYLON.StandardMaterial(name, this.scene);
        result.specularColor.copyFromFloats(0, 0, 0);
        result.ambientColor.copyFromFloats(1, 1, 1);
        result.diffuseColor.copyFromFloats(1, 1, 1);
        return result;
    }
    mesh(voxels) {
        const requestID = this.requests++;
        const meshes = [];
        const chunk = {
            voxels,
            requestID,
            pos: null,
            _isFull: false,
            _isEmpty: false,
            _terrainMeshes: meshes,
            _neighbors: { get: (x, y, z) => {
                    const self = x === 0 && y === 0 && z === 0;
                    return self ? { voxels } : null;
                } },
        };
        this.mesher.meshChunk(chunk);
        assert(meshes.length <= 1, () => `Unexpected: ${meshes.length} meshes`);
        return meshes.length === 1 ? meshes[0] : null;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
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
        this.updateDelay = 1000 / Constants.TICKS_PER_SECOND;
        this.updateLimit = this.updateDelay * Constants.TICKS_PER_FRAME;
        const updateInterval = this.updateDelay / Constants.TICK_RESOLUTION;
        setInterval(this.updateHandler.bind(this), updateInterval);
    }
    renderHandler() {
        requestAnimationFrame(this.renderBinding);
        this.updateHandler();
        const now = this.now.now();
        const dt = now - this.lastRender;
        this.lastRender = now;
        const fraction = (now - this.lastUpdate) / this.updateDelay;
        try {
            this.render(dt, fraction);
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
                this.update(delay);
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
;
const kNoEntity = 0;
;
class ComponentStore {
    constructor(component, definition) {
        this.component = component;
        this.definition = definition;
        this.lookup = new Map();
        this.states = [];
    }
    get(entity) {
        const result = this.lookup.get(entity);
        return result ? result : null;
    }
    getX(entity) {
        const result = this.lookup.get(entity);
        if (!result)
            throw new Error(`${entity} missing ${this.component}`);
        return result;
    }
    add(entity) {
        if (this.lookup.has(entity)) {
            throw new Error(`Duplicate for ${entity}: ${this.component}`);
        }
        const index = this.states.length;
        const state = this.definition.init();
        state.id = entity;
        state.index = index;
        this.lookup.set(entity, state);
        this.states.push(state);
        const callback = this.definition.onAdd;
        if (callback)
            callback(state);
        return state;
    }
    remove(entity) {
        const state = this.lookup.get(entity);
        if (!state)
            return;
        this.lookup.delete(entity);
        const popped = this.states.pop();
        assert(popped.index === this.states.length);
        if (popped.id === entity)
            return;
        const index = state.index;
        assert(index < this.states.length);
        this.states[index] = popped;
        popped.index = index;
        const callback = this.definition.onRemove;
        if (callback)
            callback(state);
    }
    render(dt) {
        const callback = this.definition.onRender;
        if (!callback)
            throw new Error(`render called: ${this.component}`);
        callback(dt, this.states);
    }
    update(dt) {
        const callback = this.definition.onUpdate;
        if (!callback)
            throw new Error(`update called: ${this.component}`);
        callback(dt, this.states);
    }
}
;
class EntityComponentSystem {
    constructor() {
        this.last = 0;
        this.components = new Map();
        this.onRenders = [];
        this.onUpdates = [];
    }
    addEntity() {
        return this.last = (this.last + 1);
    }
    removeEntity(entity) {
        this.components.forEach(x => x.remove(entity));
    }
    registerComponent(component, definition) {
        const exists = this.components.has(component);
        if (exists)
            throw new Error(`Duplicate component: ${component}`);
        const store = new ComponentStore(component, definition);
        this.components.set(component, store);
        if (definition.onRender)
            this.onRenders.push(store);
        if (definition.onUpdate)
            this.onUpdates.push(store);
        return store;
    }
    render(dt) {
        for (const store of this.onRenders)
            store.render(dt);
    }
    update(dt) {
        for (const store of this.onUpdates)
            store.update(dt);
    }
}
;
;
const kMinCapacity = 4;
const kTmpReset = new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
]);
const kTmpTransform = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
]);
class TerrainSprites {
    constructor(renderer) {
        this.renderer = renderer;
        this.kinds = new Map();
        this.root = new BABYLON.TransformNode('sprites', renderer.scene);
        this.root.position.copyFromFloats(0.5, 0.5, 0.5);
    }
    add(x, y, z, block, mesh) {
        let data = this.kinds.get(block);
        if (!data) {
            const capacity = kMinCapacity;
            const buffer = new Float32Array(capacity * 16);
            data = { dirty: false, mesh, buffer, capacity, size: 0 };
            this.kinds.set(block, data);
            mesh.parent = this.root;
            mesh.position.setAll(0);
            mesh.alwaysSelectAsActiveMesh = true;
            mesh.doNotSyncBoundingInfo = true;
            mesh.thinInstanceSetBuffer('matrix', buffer);
            this.renderer.addMesh(mesh, true);
        }
        if (data.size === data.capacity) {
            this.reallocate(data, data.capacity * 2);
        }
        kTmpTransform[12] = x;
        kTmpTransform[13] = y;
        kTmpTransform[14] = z;
        this.copy(kTmpTransform, 0, data.buffer, data.size);
        data.size++;
        data.dirty = true;
    }
    remove(x, y, z, block) {
        const data = this.kinds.get(block);
        if (!data)
            throw new Error(`Unknown block ${block} at (${x}, ${y}, ${z})`);
        const buffer = data.buffer;
        const index = (() => {
            for (let i = 0; i < data.size; i++) {
                if (buffer[i * 16 + 12] !== x)
                    continue;
                if (buffer[i * 16 + 13] !== y)
                    continue;
                if (buffer[i * 16 + 14] !== z)
                    continue;
                return i;
            }
            throw new Error(`Missing block ${block} at (${x}, ${y}, ${z})`);
        })();
        const last = data.size - 1;
        if (index !== last)
            this.copy(buffer, last, buffer, index);
        data.size--;
        if (data.capacity > Math.max(kMinCapacity, 4 * data.size)) {
            this.reallocate(data, data.capacity / 2);
        }
        data.dirty = true;
    }
    update() {
        for (const data of this.kinds.values()) {
            if (!data.dirty)
                continue;
            data.mesh.thinInstanceCount = data.size;
            data.mesh.thinInstanceBufferUpdated('matrix');
            data.mesh.isVisible = data.size > 0;
            data.dirty = false;
        }
    }
    copy(src, srcOff, dst, dstOff) {
        srcOff *= 16;
        dstOff *= 16;
        for (let i = 0; i < 16; i++) {
            dst[dstOff + i] = src[srcOff + i];
        }
    }
    reallocate(data, capacity) {
        data.capacity = capacity;
        const buffer = new Float32Array(capacity * 16);
        for (let i = 0; i < data.size * 16; i++)
            buffer[i] = data.buffer[i];
        data.mesh.thinInstanceSetBuffer('matrix', buffer);
        data.buffer = buffer;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
class Env {
    constructor(id) {
        this.container = new Container(id);
        this.entities = new EntityComponentSystem();
        this.registry = new Registry();
        this.renderer = new Renderer(this.container);
        this.sprites = new TerrainSprites(this.renderer);
        this.mesher = new TerrainMesher(this.renderer.scene, this.registry);
        this.timing = new Timing(this.render.bind(this), this.update.bind(this));
        const size = Constants.CHUNK_SIZE;
        this.voxels = new Tensor3(size, size, size);
        this._spritesDirty = true;
        this._terrainDirty = true;
        this._mesh = null;
    }
    getBlock(x, y, z) {
        return this.voxels.get(x, y, z);
    }
    setBlock(x, y, z, block) {
        const old = this.voxels.get(x, y, z);
        if (old === block)
            return;
        const old_mesh = this.registry._meshes[old];
        const new_mesh = this.registry._meshes[block];
        if (old_mesh)
            this.sprites.remove(x, y, z, old);
        if (new_mesh)
            this.sprites.add(x, y, z, block, new_mesh);
        this.voxels.set(x, y, z, block);
        this._spritesDirty || (this._spritesDirty = !!(old_mesh || new_mesh));
        this._terrainDirty || (this._terrainDirty = !(old_mesh || old === 0) ||
            !(new_mesh || block === 0));
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
        const transform = BABYLON.Matrix.RotationY(camera.holder.rotation.y);
        for (const data of this.sprites.kinds.values()) {
            if (data.size === 0)
                continue;
            data.mesh.setVerticesData('position', kTmpReset);
            data.mesh.bakeTransformIntoVertices(transform);
        }
        this.entities.render(dt);
        this.renderer.render();
    }
    update(dt) {
        if (!this.container.inputs.pointer)
            return;
        if (this._spritesDirty) {
            this.sprites.update();
            this._spritesDirty = false;
        }
        if (this._terrainDirty) {
            if (this._mesh)
                this._mesh.dispose();
            this._mesh = this.mesher.mesh(this.voxels);
            if (this._mesh)
                this.renderer.addMesh(this._mesh, false);
            this._terrainDirty = false;
        }
        this.entities.update(dt);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
// The game code:
class TypedEnv extends Env {
    constructor(id) {
        super(id);
        const ents = this.entities;
        this.position = ents.registerComponent('position', Position);
        this.movement = ents.registerComponent('movement', Movement(this));
        this.physics = ents.registerComponent('physics', Physics(this));
        this.mesh = ents.registerComponent('mesh', Mesh(this));
        this.target = ents.registerComponent('camera-target', CameraTarget(this));
    }
}
;
;
const Position = {
    init: () => ({ id: kNoEntity, index: 0, x: 0, y: 0, z: 0, h: 0, w: 0 }),
};
;
const kTmpGravity = Vec3.from(0, -40, 0);
const kTmpAcceleration = Vec3.create();
const kTmpFriction = Vec3.create();
const kTmpDelta = Vec3.create();
const kTmpSize = Vec3.create();
const kTmpPush = Vec3.create();
const kTmpPos = Vec3.create();
const setPhysicsFromPosition = (a, b) => {
    Vec3.set(kTmpPos, a.x, a.y, a.z);
    Vec3.set(kTmpSize, a.w / 2, a.h / 2, a.w / 2);
    Vec3.sub(b.min, kTmpPos, kTmpSize);
    Vec3.add(b.max, kTmpPos, kTmpSize);
};
const setPositionFromPhysics = (a, b) => {
    a.x = (b.min[0] + b.max[0]) / 2;
    a.y = (b.min[1] + b.max[1]) / 2;
    a.z = (b.min[2] + b.max[2]) / 2;
};
const applyFriction = (axis, state, dv) => {
    const resting = state.resting[axis];
    if (resting === 0 || resting * dv[axis] <= 0)
        return;
    Vec3.copy(kTmpFriction, state.vel);
    kTmpFriction[axis] = 0;
    const length = Vec3.length(kTmpFriction);
    if (length === 0)
        return;
    const loss = Math.abs(state.friction * dv[axis]);
    const scale = length < loss ? 0 : (length - loss) / length;
    state.vel[(axis + 1) % 3] *= scale;
    state.vel[(axis + 2) % 3] *= scale;
};
const runPhysics = (env, dt, state) => {
    if (state.mass <= 0)
        return;
    dt = dt / 1000;
    Vec3.scale(kTmpAcceleration, state.forces, 1 / state.mass);
    Vec3.add(kTmpAcceleration, kTmpAcceleration, kTmpGravity);
    Vec3.scale(kTmpDelta, kTmpAcceleration, dt);
    Vec3.scaleAndAdd(kTmpDelta, kTmpDelta, state.impulses, 1 / state.mass);
    if (state.friction) {
        applyFriction(0, state, kTmpDelta);
        applyFriction(1, state, kTmpDelta);
        applyFriction(2, state, kTmpDelta);
    }
    // Update our state based on the computations above.
    Vec3.add(state.vel, state.vel, kTmpDelta);
    Vec3.scale(kTmpDelta, state.vel, dt);
    sweep(state.min, state.max, kTmpDelta, state.resting, (p) => env.getBlock(p[0], p[1], p[2]) === 0);
    Vec3.set(state.forces, 0, 0, 0);
    Vec3.set(state.impulses, 0, 0, 0);
    for (let i = 0; i < 3; i++) {
        if (state.resting[i] !== 0)
            state.vel[i] = 0;
    }
};
const Physics = (env) => ({
    init: () => ({
        id: kNoEntity,
        index: 0,
        min: Vec3.create(),
        max: Vec3.create(),
        vel: Vec3.create(),
        forces: Vec3.create(),
        impulses: Vec3.create(),
        resting: Vec3.create(),
        friction: 0,
        mass: 1,
    }),
    onAdd: (state) => {
        setPhysicsFromPosition(env.position.getX(state.id), state);
    },
    onRemove: (state) => {
        setPositionFromPhysics(env.position.getX(state.id), state);
    },
    onRender: (dt, states) => {
        for (const state of states) {
            setPositionFromPhysics(env.position.getX(state.id), state);
        }
    },
    onUpdate: (dt, states) => {
        for (const state of states)
            runPhysics(env, dt, state);
    },
});
;
const handleJumping = (dt, state, body, grounded) => {
    if (state._isJumping) {
        if (state._jumpTimeLeft <= 0)
            return;
        const delta = state._jumpTimeLeft <= dt ? state._jumpTimeLeft / dt : 1;
        const force = state.jumpForce * delta;
        Vec3.add(body.forces, body.forces, [0, force, 0]);
        return;
    }
    const hasAirJumps = state._jumpCount < state.airJumps;
    const canJump = grounded || hasAirJumps;
    if (!canJump)
        return;
    state._isJumping = true;
    state._jumpTimeLeft = state.jumpTime;
    Vec3.add(body.impulses, body.impulses, [0, state.jumpImpulse, 0]);
    if (grounded)
        return;
    body.vel[1] = Math.max(body.vel[1], 0);
    state._jumpCount++;
};
const handleRunning = (dt, state, body, grounded) => {
    const speed = state.maxSpeed;
    Vec3.set(kTmpDelta, 0, 0, speed);
    Vec3.rotateY(kTmpDelta, kTmpDelta, state.heading);
    Vec3.sub(kTmpPush, kTmpDelta, body.vel);
    kTmpPush[1] = 0;
    const length = Vec3.length(kTmpPush);
    if (length === 0)
        return;
    const bound = state.moveForce * (grounded ? 1 : state.airMoveMultiplier);
    const input = state.responsiveness * length;
    Vec3.scale(kTmpPush, kTmpPush, Math.min(bound, input) / length);
    Vec3.add(body.forces, body.forces, kTmpPush);
};
const runMovement = (env, dt, state) => {
    dt = dt / 1000;
    // Process the inputs to get a heading, running, and jumping state.
    const inputs = env.container.inputs;
    const fb = (inputs.up ? 1 : 0) - (inputs.down ? 1 : 0);
    const lr = (inputs.right ? 1 : 0) - (inputs.left ? 1 : 0);
    state.running = fb !== 0 || lr !== 0;
    state.jumping = inputs.space;
    if (state.running) {
        let heading = env.renderer.camera.heading;
        if (fb) {
            if (fb === -1)
                heading += Math.PI;
            heading += fb * lr * Math.PI / 4;
        }
        else {
            heading += lr * Math.PI / 2;
        }
        state.heading = heading;
    }
    // All inputs processed; update the entity's PhysicsState.
    const body = env.physics.getX(state.id);
    const grounded = body.resting[1] < 0;
    if (grounded) {
        state._isJumping = false;
        state._jumpCount = 0;
    }
    if (state.jumping) {
        handleJumping(dt, state, body, grounded);
    }
    else {
        state._isJumping = false;
    }
    if (state.running) {
        handleRunning(dt, state, body, grounded);
        body.friction = state.runningFriction;
    }
    else {
        body.friction = state.standingFriction;
    }
};
const Movement = (env) => ({
    init: () => ({
        id: kNoEntity,
        index: 0,
        heading: 0,
        running: false,
        jumping: false,
        maxSpeed: 10,
        moveForce: 30,
        responsiveness: 15,
        runningFriction: 0,
        standingFriction: 2,
        airMoveMultiplier: 0.5,
        airJumps: 1,
        jumpTime: 500,
        jumpForce: 15,
        jumpImpulse: 10,
        _isJumping: false,
        _jumpCount: 0,
        _jumpTimeLeft: 0,
    }),
    onUpdate: (dt, states) => {
        for (const state of states)
            runMovement(env, dt, state);
    }
});
;
const Mesh = (env) => ({
    init: () => ({ id: kNoEntity, index: 0, mesh: null }),
    onAdd: (state) => {
        const position = env.position.getX(state.id);
        const mesh = BABYLON.Mesh.CreateBox('box', 1, env.renderer.scene);
        mesh.scaling.x = position.w;
        mesh.scaling.y = position.h;
        mesh.scaling.z = position.w;
        env.renderer.addMesh(mesh, true);
        state.mesh = mesh;
    },
    onRemove: (state) => {
        if (state.mesh)
            state.mesh.dispose();
    },
    onRender: (dt, states) => {
        for (const state of states) {
            const { x, y, z } = env.position.getX(state.id);
            if (state.mesh)
                state.mesh.position.copyFromFloats(x, y, z);
        }
    },
});
// CameraTarget signifies that the camera will follow an entity.
const CameraTarget = (env) => ({
    init: () => ({ id: kNoEntity, index: 0 }),
    onRender: (dt, states) => {
        for (const state of states) {
            const position = env.position.getX(state.id);
            env.renderer.camera.setTarget(position.x, position.y, position.z);
        }
    },
    onUpdate: (dt, states) => {
        const inputs = env.container.inputs;
        const ud = (inputs.up ? 1 : 0) - (inputs.down ? 1 : 0);
        const speed = 0.5 * ud;
        const camera = env.renderer.camera;
        const direction = camera.direction;
        for (const state of states) {
            const position = env.position.getX(state.id);
            position.x += speed * direction[0];
            position.y += speed * direction[1];
            position.z += speed * direction[2];
        }
    },
});
// Putting it all together:
const main = () => {
    const env = new TypedEnv('container');
    const player = env.entities.addEntity();
    const position = env.position.add(player);
    position.x = 8;
    position.y = 5;
    position.z = 1.5;
    position.w = 0.6;
    position.h = 1.2;
    env.physics.add(player);
    env.movement.add(player);
    env.mesh.add(player);
    env.target.add(player);
    const registry = env.registry;
    const scene = env.renderer.scene;
    const textures = ['dirt', 'grass', 'ground', 'wall'];
    for (const texture of textures) {
        registry.addMaterialOfTexture(texture, `images/${texture}.png`);
    }
    const wall = registry.addBlock(['wall'], true);
    const grass = registry.addBlock(['grass', 'dirt', 'dirt'], true);
    const ground = registry.addBlock(['ground', 'dirt', 'dirt'], true);
    const rock = registry.addBlockSprite('images/rock.png', true, scene);
    const tree = registry.addBlockSprite('images/tree.png', true, scene);
    const tree0 = registry.addBlockSprite('images/tree0.png', true, scene);
    const tree1 = registry.addBlockSprite('images/tree1.png', true, scene);
    const size = Constants.CHUNK_SIZE;
    const pl = size / 4;
    const pr = 3 * size / 4;
    const layers = [ground, ground, grass, wall, tree0, tree1];
    for (let x = 0; x < size; x++) {
        for (let z = 0; z < size; z++) {
            const edge = x === 0 || x === size - 1 || z === 0 || z === size - 1;
            const pool = (pl <= x && x < pr && 4 && pl <= z && z < pr);
            const height = Math.min(edge ? 6 : 3, size);
            for (let y = 0; y < height; y++) {
                assert(env.getBlock(x, y, z) === 0);
                const tile = y > 0 && pool ? 0 : layers[y];
                env.setBlock(x, y, z, tile);
            }
        }
    }
    env.setBlock(8, 1, 8, rock);
    env.setBlock(7, 1, 8, rock);
    env.setBlock(6, 1, 7, rock);
    env.setBlock(6, 1, 9, rock);
    env.refresh();
};
window.onload = main;
//# sourceMappingURL=main.js.map