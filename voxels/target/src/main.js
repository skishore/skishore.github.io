import { Vec3 } from './base.js';
import { Env } from './engine.js';
import { kEmptyBlock, kWorldHeight } from './engine.js';
import { kNoEntity } from './ecs.js';
import { sweep } from './sweep.js';
import { getHeight, loadChunk, loadFrontier } from './worldgen.js';
//////////////////////////////////////////////////////////////////////////////
const kNumParticles = 16;
const kMaxNumParticles = 64;
const kWaterDelay = 200;
const kWaterDisplacements = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [-1, 0, 0],
    [0, 0, -1],
];
//////////////////////////////////////////////////////////////////////////////
class TypedEnv extends Env {
    constructor(id) {
        super(id);
        this.particles = 0;
        this.blocks = null;
        const ents = this.entities;
        this.lifetime = ents.registerComponent('lifetime', Lifetime);
        this.position = ents.registerComponent('position', Position);
        this.movement = ents.registerComponent('movement', Movement(this));
        this.physics = ents.registerComponent('physics', Physics(this));
        this.meshes = ents.registerComponent('meshes', Meshes(this));
        this.shadow = ents.registerComponent('shadow', Shadow(this));
        this.target = ents.registerComponent('camera-target', CameraTarget(this));
    }
}
;
const hasWaterNeighbor = (env, water, p) => {
    for (const d of kWaterDisplacements) {
        const block = env.world.getBlock(d[0] + p[0], d[1] + p[1], d[2] + p[2]);
        if (block === water)
            return true;
    }
    return false;
};
const flowWater = (env, water, points) => {
    const next = [];
    const visited = new Set();
    for (const p of points) {
        const block = env.world.getBlock(p[0], p[1], p[2]);
        if (block !== kEmptyBlock || !hasWaterNeighbor(env, water, p))
            continue;
        env.world.setBlock(p[0], p[1], p[2], water);
        for (const d of kWaterDisplacements) {
            const n = [p[0] - d[0], p[1] - d[1], p[2] - d[2]];
            const key = `${n[0]}-${n[1]}-${n[2]}`;
            if (visited.has(key))
                continue;
            visited.add(key);
            next.push(n);
        }
    }
    if (next.length === 0)
        return;
    setTimeout(() => flowWater(env, water, next), kWaterDelay);
};
;
const Lifetime = {
    init: () => ({ id: kNoEntity, index: 0, lifetime: 0, cleanup: null }),
    onUpdate: (dt, states) => {
        dt = dt / 1000;
        for (const state of states) {
            state.lifetime -= dt;
            if (state.lifetime < 0 && state.cleanup)
                state.cleanup();
        }
    },
};
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
const kTmpMax = Vec3.create();
const kTmpMin = Vec3.create();
const kTmpPos = Vec3.create();
const kTmpResting = Vec3.create();
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
const tryAutoStepping = (dt, state, min, max, check) => {
    if (state.resting[1] > 0 && !state.inFluid)
        return;
    const threshold = 4;
    const speed_x = Math.abs(state.vel[0]);
    const speed_z = Math.abs(state.vel[2]);
    const step_x = (state.resting[0] !== 0 && threshold * speed_x > speed_z);
    const step_z = (state.resting[2] !== 0 && threshold * speed_z > speed_x);
    if (!step_x && !step_z)
        return;
    const height = 1 - min[1] + Math.floor(min[1]);
    Vec3.set(kTmpDelta, 0, height, 0);
    sweep(min, max, kTmpDelta, kTmpResting, check);
    if (kTmpResting[1] !== 0)
        return;
    Vec3.scale(kTmpDelta, state.vel, dt);
    kTmpDelta[1] = 0;
    sweep(min, max, kTmpDelta, kTmpResting, check);
    if (min[0] === state.min[0] && min[2] === state.min[2])
        return;
    if (height > state.autoStep) {
        Vec3.set(kTmpDelta, 0, state.autoStep, 0);
        sweep(state.min, state.max, kTmpDelta, state.resting, check);
        if (!step_x)
            state.vel[0] = 0;
        if (!step_z)
            state.vel[2] = 0;
        state.vel[1] = 0;
        return;
    }
    Vec3.copy(state.min, min);
    Vec3.copy(state.max, max);
    Vec3.copy(state.resting, kTmpResting);
};
const runPhysics = (env, dt, state) => {
    if (state.mass <= 0)
        return;
    const check = (pos) => {
        const block = env.world.getBlock(pos[0], pos[1], pos[2]);
        return !env.registry.solid[block];
    };
    const [x, y, z] = state.min;
    const block = env.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    state.inFluid = block !== kEmptyBlock;
    dt = dt / 1000;
    const drag = state.inFluid ? 2 : 0;
    const left = Math.max(1 - drag * dt, 0);
    const gravity = state.inFluid ? 0.25 : 1;
    Vec3.scale(kTmpAcceleration, state.forces, 1 / state.mass);
    Vec3.scaleAndAdd(kTmpAcceleration, kTmpAcceleration, kTmpGravity, gravity);
    Vec3.scale(kTmpDelta, kTmpAcceleration, dt);
    Vec3.scaleAndAdd(kTmpDelta, kTmpDelta, state.impulses, 1 / state.mass);
    if (state.friction) {
        applyFriction(0, state, kTmpDelta);
        applyFriction(1, state, kTmpDelta);
        applyFriction(2, state, kTmpDelta);
    }
    if (state.autoStep) {
        Vec3.copy(kTmpMax, state.max);
        Vec3.copy(kTmpMin, state.min);
    }
    // Update our state based on the computations above.
    Vec3.add(state.vel, state.vel, kTmpDelta);
    Vec3.scale(state.vel, state.vel, left);
    Vec3.scale(kTmpDelta, state.vel, dt);
    sweep(state.min, state.max, kTmpDelta, state.resting, check);
    Vec3.set(state.forces, 0, 0, 0);
    Vec3.set(state.impulses, 0, 0, 0);
    if (state.autoStep) {
        tryAutoStepping(dt, state, kTmpMin, kTmpMax, check);
    }
    for (let i = 0; i < 3; i++) {
        if (state.resting[i] === 0)
            continue;
        state.vel[i] = -state.restitution * state.vel[i];
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
        inFluid: false,
        friction: 0,
        restitution: 0,
        mass: 1,
        autoStep: 0,
    }),
    onAdd: (state) => {
        setPhysicsFromPosition(env.position.getX(state.id), state);
    },
    onRemove: (state) => {
        const position = env.position.get(state.id);
        if (position)
            setPositionFromPhysics(position, state);
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
    if (state._jumped) {
        if (state._jumpTimeLeft <= 0)
            return;
        const delta = state._jumpTimeLeft <= dt ? state._jumpTimeLeft / dt : 1;
        const force = state.jumpForce * delta;
        state._jumpTimeLeft -= dt;
        body.forces[1] += force;
        return;
    }
    const hasAirJumps = state._jumpCount < state.airJumps;
    const canJump = grounded || body.inFluid || hasAirJumps;
    if (!canJump)
        return;
    const height = body.min[1];
    const factor = height / kWorldHeight;
    const density = factor > 1 ? Math.exp(1 - factor) : 1;
    const penalty = body.inFluid ? state.swimPenalty : density;
    state._jumped = true;
    state._jumpTimeLeft = state.jumpTime;
    body.impulses[1] += state.jumpImpulse * penalty;
    if (grounded)
        return;
    body.vel[1] = Math.max(body.vel[1], 0);
    state._jumpCount++;
};
const handleRunning = (dt, state, body, grounded) => {
    const penalty = body.inFluid ? state.swimPenalty : 1;
    const speed = penalty * state.maxSpeed;
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
const generateParticles = (env, block, x, y, z, side) => {
    const adjusted = side === 2 || side === 3 ? 0 : side;
    const material = env.registry.getBlockFaceMaterial(block, adjusted);
    const data = env.registry.getMaterialData(material);
    if (!data.texture)
        return;
    const count = Math.min(kNumParticles, kMaxNumParticles - env.particles);
    env.particles += count;
    for (let i = 0; i < count; i++) {
        const particle = env.entities.addEntity();
        const position = env.position.add(particle);
        const side = Math.floor(3 * Math.random() + 1) / 16;
        position.x = x + (1 - side) * Math.random() + side / 2;
        position.y = y + (1 - side) * Math.random() + side / 2;
        position.z = z + (1 - side) * Math.random() + side / 2;
        position.w = position.h = side;
        const kParticleSpeed = 8;
        const body = env.physics.add(particle);
        body.impulses[0] = kParticleSpeed * (Math.random() - 0.5);
        body.impulses[1] = kParticleSpeed * Math.random();
        body.impulses[2] = kParticleSpeed * (Math.random() - 0.5);
        body.friction = 10;
        body.restitution = 0.5;
        const size = position.h;
        const mesh = env.meshes.add(particle);
        const sprite = { url: 'images/rhodox-edited.png', size, x: 16, y: 16 };
        mesh.mesh = env.renderer.addSpriteMesh(sprite);
        mesh.mesh.setFrame(data.texture.x + 16 * data.texture.y);
        const epsilon = 0.01;
        const s = Math.floor(16 * (1 - side) * Math.random()) / 16;
        const t = Math.floor(16 * (1 - side) * Math.random()) / 16;
        const uv = side - 2 * epsilon;
        mesh.mesh.setSTUV(s + epsilon, t + epsilon, uv, uv);
        const lifetime = env.lifetime.add(particle);
        lifetime.lifetime = 1.0 * Math.random() + 0.5;
        lifetime.cleanup = () => {
            env.entities.removeEntity(particle);
            env.particles--;
        };
    }
};
const tryToModifyBlock = (env, body, add) => {
    const target = env.getTargetedBlock();
    if (target === null)
        return;
    const side = env.getTargetedBlockSide();
    Vec3.copy(kTmpPos, target);
    if (add) {
        kTmpPos[side >> 1] += (side & 1) ? -1 : 1;
        let intersect = true;
        const { max, min } = body;
        for (let i = 0; i < 3; i++) {
            const pos = kTmpPos[i];
            if (pos < max[i] && min[i] < pos + 1)
                continue;
            intersect = false;
        }
        if (intersect)
            return;
    }
    const x = kTmpPos[0], y = kTmpPos[1], z = kTmpPos[2];
    const old_block = add ? kEmptyBlock : env.world.getBlock(x, y, z);
    const block = add && env.blocks ? env.blocks.dirt : kEmptyBlock;
    env.world.setBlock(x, y, z, block);
    const new_block = add ? kEmptyBlock : env.world.getBlock(x, y, z);
    if (env.blocks) {
        const water = env.blocks.water;
        setTimeout(() => flowWater(env, water, [[x, y, z]]), kWaterDelay);
    }
    if (old_block !== kEmptyBlock && old_block !== new_block) {
        generateParticles(env, old_block, x, y, z, side);
    }
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
    if (grounded)
        state._jumpCount = 0;
    if (inputs.hover) {
        const force = body.vel[1] < 0 ? state.hoverFallForce : state.hoverRiseForce;
        body.forces[1] += force;
    }
    if (state.jumping) {
        handleJumping(dt, state, body, grounded);
    }
    else {
        state._jumped = false;
    }
    if (state.running) {
        handleRunning(dt, state, body, grounded);
        body.friction = state.runningFriction;
    }
    else {
        body.friction = state.standingFriction;
    }
    // Turn mouse inputs into actions.
    if (inputs.mouse0 || inputs.mouse1) {
        tryToModifyBlock(env, body, !inputs.mouse0);
        inputs.mouse0 = false;
        inputs.mouse1 = false;
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
        swimPenalty: 0.5,
        responsiveness: 15,
        runningFriction: 0,
        standingFriction: 2,
        airMoveMultiplier: 0.5,
        airJumps: 0,
        jumpTime: 0.2,
        jumpForce: 15,
        jumpImpulse: 10,
        _jumped: false,
        _jumpCount: 0,
        _jumpTimeLeft: 0,
        hoverFallForce: 160,
        hoverRiseForce: 80,
    }),
    onUpdate: (dt, states) => {
        for (const state of states)
            runMovement(env, dt, state);
    }
});
;
const Meshes = (env) => ({
    init: () => ({ id: kNoEntity, index: 0, mesh: null, frame: 0 }),
    onRemove: (state) => { if (state.mesh)
        state.mesh.dispose(); },
    onRender: (dt, states) => {
        for (const state of states) {
            if (!state.mesh)
                continue;
            const { x, y, z, h } = env.position.getX(state.id);
            const lit = env.world.isBlockLit(Math.floor(x), Math.floor(y), Math.floor(z));
            state.mesh.setPosition(x, y - h / 2, z);
            state.mesh.setLight(lit ? 1 : 0.64);
        }
    },
    onUpdate: (dt, states) => {
        for (const state of states) {
            if (!state.mesh)
                return;
            if (!env.movement.get(state.id))
                return;
            const body = env.physics.get(state.id);
            if (!body)
                return;
            const setting = (() => {
                if (!body.resting[1])
                    return 1;
                const speed = Vec3.length(body.vel);
                state.frame = speed ? (state.frame + 0.025 * speed) % 4 : 0;
                if (!speed)
                    return 0;
                const value = Math.floor(state.frame);
                return value & 1 ? 0 : (value + 2) >> 1;
            })();
            state.mesh.setFrame(setting);
        }
    },
});
;
const Shadow = (env) => ({
    init: () => ({ id: kNoEntity, index: 0, mesh: null, extent: 16, height: 0 }),
    onRemove: (state) => { if (state.mesh)
        state.mesh.dispose(); },
    onRender: (dt, states) => {
        for (const state of states) {
            if (!state.mesh)
                state.mesh = env.renderer.addShadowMesh();
            const { x, y, z, w, h } = env.position.getX(state.id);
            const fraction = 1 - (y - 0.5 * h - state.height) / state.extent;
            const size = 0.5 * w * Math.max(0, Math.min(1, fraction));
            state.mesh.setPosition(x, state.height + 0.01, z);
            state.mesh.setSize(size);
        }
    },
    onUpdate: (dt, states) => {
        for (const state of states) {
            const position = env.position.getX(state.id);
            const x = Math.floor(position.x);
            const y = Math.floor(position.y);
            const z = Math.floor(position.z);
            state.height = (() => {
                for (let i = 0; i < state.extent; i++) {
                    const h = y - i;
                    const block = env.world.getBlock(x, h - 1, z);
                    if (env.registry.solid[block])
                        return h;
                }
                return 0;
            })();
        }
    },
});
// CameraTarget signifies that the camera will follow an entity.
const CameraTarget = (env) => ({
    init: () => ({ id: kNoEntity, index: 0 }),
    onRender: (dt, states) => {
        for (const state of states) {
            const { x, y, z, h, w } = env.position.getX(state.id);
            env.setCameraTarget(x, y + h / 3, z);
            const mesh = env.meshes.get(state.id);
            const zoom = env.renderer.camera.safe_zoom;
            if (mesh && mesh.mesh)
                mesh.mesh.enabled = zoom > 2 * w;
        }
    },
    onUpdate: (dt, states) => {
        for (const state of states) {
            const { x, y, z } = env.position.getX(state.id);
            env.world.recenter(x, y, z);
        }
    },
});
// Putting it all together:
const safeHeight = (position) => {
    const radius = 0.5 * (position.w + 1);
    const ax = Math.floor(position.x - radius);
    const az = Math.floor(position.z - radius);
    const bx = Math.ceil(position.x + radius);
    const bz = Math.ceil(position.z + radius);
    let height = 0;
    for (let x = ax; x <= bx; x++) {
        for (let z = az; z <= bz; z++) {
            height = Math.max(height, getHeight(x, z));
        }
    }
    return height + 0.5 * (position.h + 1);
};
const main = () => {
    const env = new TypedEnv('container');
    const player = env.entities.addEntity();
    const position = env.position.add(player);
    position.x = 1;
    position.z = 1;
    position.w = 0.6;
    position.h = 0.8;
    position.y = safeHeight(position);
    const size = 1.25 * position.h;
    const mesh = env.meshes.add(player);
    const sprite = { url: 'images/player.png', size, x: 32, y: 32 };
    mesh.mesh = env.renderer.addSpriteMesh(sprite);
    env.physics.add(player);
    env.movement.add(player);
    env.shadow.add(player);
    env.target.add(player);
    const texture = (x, y, alphaTest = false, sparkle = false) => {
        const url = 'images/rhodox-edited.png';
        return { alphaTest, sparkle, url, x, y, w: 16, h: 16 };
    };
    const registry = env.registry;
    registry.addMaterialOfColor('blue', [0.1, 0.1, 0.4, 0.6], true);
    registry.addMaterialOfTexture('water', texture(13, 12, false, true), [1, 1, 1, 0.8], true);
    registry.addMaterialOfTexture('leaves', texture(4, 3, true));
    const textures = [
        ['bedrock', 1, 1],
        ['dirt', 2, 0],
        ['grass', 0, 0],
        ['grass-side', 3, 0],
        ['rock', 1, 0],
        ['sand', 0, 11],
        ['snow', 2, 4],
        ['trunk', 5, 1],
        ['trunk-side', 4, 1],
    ];
    for (const [name, x, y] of textures) {
        registry.addMaterialOfTexture(name, texture(x, y));
    }
    const blocks = {
        bedrock: registry.addBlock(['bedrock'], true),
        dirt: registry.addBlock(['dirt'], true),
        grass: registry.addBlock(['grass', 'dirt', 'grass-side'], true),
        leaves: registry.addBlock(['leaves'], true),
        rock: registry.addBlock(['rock'], true),
        sand: registry.addBlock(['sand'], true),
        snow: registry.addBlock(['snow'], true),
        trunk: registry.addBlock(['trunk', 'trunk-side'], true),
        water: registry.addBlock(['water', 'blue', 'blue'], false),
    };
    env.blocks = blocks;
    const loadChunkFn = loadChunk(blocks);
    const loadFrontierFn = loadFrontier(blocks);
    env.world.setLoader(blocks.bedrock, loadChunkFn, loadFrontierFn);
    env.refresh();
};
window.onload = main;
//# sourceMappingURL=main.js.map