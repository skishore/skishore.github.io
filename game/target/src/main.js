import { int, nonnull, Vec3 } from './base.js';
import { Env } from './engine.js';
import { kEmptyBlock, kNoMaterial, kWorldHeight } from './engine.js';
import { kNoEntity } from './ecs.js';
import { AStar, Point as AStarPoint } from './pathing.js';
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
        this.inputs = ents.registerComponent('inputs', Inputs(this));
        this.pathing = ents.registerComponent('pathing', Pathing(this));
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
        const x = int(d[0] + p[0]), y = int(d[1] + p[1]), z = int(d[2] + p[2]);
        const block = env.world.getBlock(x, y, z);
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
            const n = [int(p[0] - d[0]), int(p[1] - d[1]), int(p[2] - d[2])];
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
const tryAutoStepping = (env, dt, state, min, max, check) => {
    if (state.resting[1] > 0 && !state.inFluid)
        return;
    const { resting, vel } = state;
    const { opaque, solid } = env.registry;
    const threshold = 16;
    const speed_x = Math.abs(vel[0]);
    const speed_z = Math.abs(vel[2]);
    const step_x = (() => {
        if (resting[0] === 0)
            return false;
        if (threshold * speed_x <= speed_z)
            return false;
        const x = int(Math.floor(vel[0] > 0 ? max[0] + 0.5 : min[0] - 0.5));
        const y = int(Math.floor(min[1]));
        const z = int(Math.floor((min[2] + max[2]) / 2));
        const block = env.world.getBlock(x, y, z);
        return opaque[block] && solid[block];
    })();
    const step_z = (() => {
        if (resting[2] === 0)
            return false;
        if (threshold * speed_z <= speed_x)
            return false;
        const x = int(Math.floor((min[0] + max[0]) / 2));
        const y = int(Math.floor(min[1]));
        const z = int(Math.floor(vel[2] > 0 ? max[2] + 0.5 : min[2] - 0.5));
        const block = env.world.getBlock(x, y, z);
        return opaque[block] && solid[block];
    })();
    if (!step_x && !step_z)
        return;
    const height = 1 - min[1] + Math.floor(min[1]);
    if (height > state.autoStepMax)
        return;
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
    const check = (x, y, z) => {
        const block = env.world.getBlock(x, y, z);
        return !env.registry.solid[block];
    };
    const { min, max } = state;
    const x = int(Math.floor((min[0] + max[0]) / 2));
    const y = int(Math.floor(min[1]));
    const z = int(Math.floor((min[2] + max[2]) / 2));
    const block = env.world.getBlock(x, y, z);
    state.inFluid = block !== kEmptyBlock;
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
        tryAutoStepping(env, dt, state, kTmpMin, kTmpMax, check);
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
        autoStep: 0.0625,
        autoStepMax: 0.5,
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
    Vec3.set(kTmpDelta, state.inputX * speed, 0, state.inputZ * speed);
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
    const texture = (() => {
        const mesh = env.registry.getBlockMesh(block);
        if (mesh) {
            const { frame, sprite: { url, x: w, y: h } } = mesh;
            const x = frame % w, y = Math.floor(frame / w);
            return { alphaTest: true, sparkle: false, url, x, y, w, h };
        }
        const adjusted = side === 2 || side === 3 ? 0 : side;
        const material = env.registry.getBlockFaceMaterial(block, adjusted);
        if (material === kNoMaterial)
            return;
        return env.registry.getMaterialData(material).texture;
    })();
    if (!texture)
        return;
    const count = Math.min(kNumParticles, kMaxNumParticles - env.particles);
    env.particles += count;
    for (let i = 0; i < count; i++) {
        const particle = env.entities.addEntity();
        const position = env.position.add(particle);
        const size = Math.floor(3 * Math.random() + 1) / 16;
        position.x = x + (1 - size) * Math.random() + size / 2;
        position.y = y + (1 - size) * Math.random() + size / 2;
        position.z = z + (1 - size) * Math.random() + size / 2;
        position.w = position.h = size;
        const kParticleSpeed = 8;
        const body = env.physics.add(particle);
        body.impulses[0] = kParticleSpeed * (Math.random() - 0.5);
        body.impulses[1] = kParticleSpeed * Math.random();
        body.impulses[2] = kParticleSpeed * (Math.random() - 0.5);
        body.friction = 10;
        body.restitution = 0.5;
        const mesh = env.meshes.add(particle);
        const sprite = { url: texture.url, x: texture.w, y: texture.h };
        mesh.mesh = env.renderer.addSpriteMesh(size, sprite);
        mesh.mesh.setFrame(int(texture.x + texture.y * texture.w));
        const epsilon = 0.01;
        const s = Math.floor(16 * (1 - size) * Math.random()) / 16;
        const t = Math.floor(16 * (1 - size) * Math.random()) / 16;
        const uv = size - 2 * epsilon;
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
        const intersect = env.movement.some(state => {
            const body = env.physics.get(state.id);
            if (!body)
                return false;
            const { max, min } = body;
            for (let i = 0; i < 3; i++) {
                const pos = kTmpPos[i];
                if (pos < max[i] && min[i] < pos + 1)
                    continue;
                return false;
            }
            return true;
        });
        if (intersect)
            return;
    }
    const x = int(kTmpPos[0]), y = int(kTmpPos[1]), z = int(kTmpPos[2]);
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
    const body = env.physics.getX(state.id);
    const grounded = body.resting[1] < 0;
    if (grounded)
        state._jumpCount = 0;
    if (state.hovering) {
        const force = body.vel[1] < 0 ? state.hoverFallForce : state.hoverRiseForce;
        body.forces[1] += force;
    }
    if (state.jumping) {
        handleJumping(dt, state, body, grounded);
        state.jumping = false;
    }
    else {
        state._jumped = false;
    }
    if (state.inputX || state.inputZ) {
        handleRunning(dt, state, body, grounded);
        body.friction = state.runningFriction;
        state.inputX = state.inputZ = 0;
    }
    else {
        body.friction = state.standingFriction;
    }
};
const Movement = (env) => ({
    init: () => ({
        id: kNoEntity,
        index: 0,
        inputX: 0,
        inputZ: 0,
        jumping: false,
        hovering: false,
        maxSpeed: 7.5,
        moveForce: 30,
        swimPenalty: 0.5,
        responsiveness: 15,
        runningFriction: 0,
        standingFriction: 2,
        airMoveMultiplier: 0.5,
        airJumps: 0,
        jumpTime: 0.2,
        jumpForce: 10,
        jumpImpulse: 7.5,
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
// An entity with an input component processes inputs.
const runInputs = (env, id) => {
    const state = env.movement.get(id);
    if (!state)
        return;
    // Process the inputs to get a heading, running, and jumping state.
    const inputs = env.container.inputs;
    const fb = (inputs.up ? 1 : 0) - (inputs.down ? 1 : 0);
    const lr = (inputs.right ? 1 : 0) - (inputs.left ? 1 : 0);
    state.jumping = inputs.space;
    state.hovering = inputs.hover;
    if (fb || lr) {
        let heading = env.renderer.camera.heading;
        if (fb) {
            if (fb === -1)
                heading += Math.PI;
            heading += fb * lr * Math.PI / 4;
        }
        else {
            heading += lr * Math.PI / 2;
        }
        state.inputX = Math.sin(heading);
        state.inputZ = Math.cos(heading);
        const mesh = env.meshes.get(id);
        if (mesh) {
            const row = mesh.row;
            const option_a = fb > 0 ? 0 : fb < 0 ? 2 : -1;
            const option_b = lr > 0 ? 3 : lr < 0 ? 1 : -1;
            if (row !== option_a && row !== option_b) {
                mesh.row = Math.max(option_a, option_b);
            }
        }
    }
    // Call any followers.
    const body = env.physics.get(state.id);
    if (body && (inputs.call || true)) {
        const { min, max } = body;
        const x = (min[0] + max[0]) / 2;
        const y = (min[1] + body.autoStepMax);
        const z = (min[2] + max[2]) / 2;
        const ix = int(Math.floor(x));
        const iy = int(Math.floor(y));
        const iz = int(Math.floor(z));
        env.pathing.each(other => {
            other.target = [ix, iy, iz];
            other.soft_target = [x, y, z];
        });
    }
    inputs.call = false;
    // Turn mouse inputs into actions.
    if (inputs.mouse0 || inputs.mouse1) {
        const body = env.physics.get(id);
        if (body)
            tryToModifyBlock(env, body, !inputs.mouse0);
        inputs.mouse0 = false;
        inputs.mouse1 = false;
    }
};
const Inputs = (env) => ({
    init: () => ({ id: kNoEntity, index: 0 }),
    onUpdate: (dt, states) => {
        for (const state of states)
            runInputs(env, state.id);
    }
});
;
const solid = (env, x, y, z) => {
    const block = env.world.getBlock(x, y, z);
    return env.registry.solid[block];
};
const hasDirectPath = (env, start, end) => {
    if (start[1] !== end[1])
        return false;
    if (start[0] === end[0] && start[2] === end[2])
        return true;
    const [sx, y, sz] = start;
    const [ex, _, ez] = end;
    const dx = Math.abs(ex - sx);
    const dz = Math.abs(ez - sz);
    const elements = [];
    if (dx <= dz) {
        const extra = dx === 0 ? 1 : 0;
        for (let i = 0; i < dz; i++) {
            const a = Math.floor(i * dx / dz);
            const b = Math.ceil((i + 1) * dx / dz) + extra;
            for (let j = a; j < b; j++) {
                const x = int(ex >= sx ? sx + j : sx - j - 1);
                const z = int(ez >= sz ? sz + i : sz - i - 1);
                elements.push([x, y, z]);
            }
        }
    }
    else {
        const extra = dz === 0 ? 1 : 0;
        for (let i = 0; i < dx; i++) {
            const a = Math.floor(i * dz / dx);
            const b = Math.ceil((i + 1) * dz / dx) + extra;
            for (let j = a; j < b; j++) {
                const x = int(ex >= sx ? sx + i : sx - i - 1);
                const z = int(ez >= sz ? sz + j : sz - j - 1);
                elements.push([x, y, z]);
            }
        }
    }
    const n = dx && dz ? 4 : 1;
    for (const element of elements) {
        const [x, y, z] = element;
        for (let i = 0; i < n; i++) {
            const ix = int(x + (i & 1));
            const iz = int(z + ((i >> 1) & 1));
            if (solid(env, ix, y, iz))
                return false;
            if (!solid(env, ix, int(y - 1), iz))
                return false;
        }
    }
    return true;
};
const findPath = (env, state, body) => {
    const grounded = body.resting[1] < 0;
    if (!grounded)
        return;
    const { min, max } = body;
    const sx = int(Math.floor((min[0] + max[0]) / 2));
    const sy = int(Math.floor(min[1]));
    const sz = int(Math.floor((min[2] + max[2]) / 2));
    const [tx, ty, tz] = nonnull(state.target);
    const path = AStar(new AStarPoint(sx, sy, sz), new AStarPoint(tx, ty, tz), p => !solid(env, p.x, p.y, p.z));
    if (path.length === 0)
        return;
    const full = path.map((p) => [p.x, p.y, p.z]);
    const result = [full[0]];
    for (let i = 2; i < full.length; i++) {
        const last = result[result.length - 1];
        if (hasDirectPath(env, last, full[i]))
            continue;
        result.push(full[i - 1]);
    }
    if (full.length > 1) {
        result.push(full[full.length - 1]);
        result.shift();
    }
    const last = result[result.length - 1];
    const use_soft = last[0] === tx && last[2] === tz;
    state.path = result;
    state.path_index = 0;
    state.path_soft_target = use_soft ? state.soft_target : null;
    state.target = state.soft_target = null;
    //console.log(JSON.stringify(state.path));
};
const PIDController = (error, derror, grounded) => {
    const dfactor = grounded ? 1.00 : 2.00;
    return 20.00 * error + dfactor * derror;
};
const followPath = (env, state, body) => {
    const path = nonnull(state.path);
    if (state.path_index === path.length) {
        state.path = null;
        return;
    }
    const movement = env.movement.get(state.id);
    if (!movement)
        return;
    const grounded = body.resting[1] < 0;
    const node = path[state.path_index];
    const E = state.path_index + 1 === path.length
        ? 0.4 * (1 - (body.max[0] - body.min[0]))
        : -0.4 * (body.max[0] - body.min[0]);
    if (node[0] + E <= body.min[0] && body.max[0] <= node[0] + 1 - E &&
        node[1] + 0 <= body.min[1] && body.min[1] <= node[1] + 1 - 0 &&
        node[2] + E <= body.min[2] && body.max[2] <= node[2] + 1 - E &&
        grounded) {
        state.path_index++;
    }
    const path_index = state.path_index;
    if (path_index === path.length) {
        state.path = null;
        return;
    }
    const soft = state.path_soft_target;
    const last = path_index === path.length - 1;
    const cur = path[path_index];
    const cx = (body.min[0] + body.max[0]) / 2;
    const cz = (body.min[2] + body.max[2]) / 2;
    const dx = (last && soft ? soft[0] : cur[0] + 0.5) - cx;
    const dz = (last && soft ? soft[2] : cur[2] + 0.5) - cz;
    const penalty = body.inFluid ? movement.swimPenalty : 1;
    const speed = penalty * movement.maxSpeed;
    const inverse_speed = speed ? 1 / speed : 1;
    let inputX = PIDController(dx, -body.vel[0], grounded) * inverse_speed;
    let inputZ = PIDController(dz, -body.vel[2], grounded) * inverse_speed;
    const length = Math.sqrt(inputX * inputX + inputZ * inputZ);
    const normalization = length > 1 ? 1 / length : 1;
    movement.inputX = inputX * normalization;
    movement.inputZ = inputZ * normalization;
    if (grounded)
        movement._jumped = false;
    movement.jumping = (() => {
        if (cur[1] > body.min[1])
            return true;
        if (!grounded)
            return false;
        const x = int(Math.floor(cx));
        const y = int(body.min[1] - 1);
        const z = int(Math.floor(cz));
        const fx = cx - Math.floor(cx);
        const fz = cz - Math.floor(cz);
        const J = 0.5, K = 1 - J;
        return (dx > 1 && fx > K && !solid(env, int(x + 1), y, z)) ||
            (dx < -1 && fx < J && !solid(env, int(x - 1), y, z)) ||
            (dz > 1 && fz > K && !solid(env, x, y, int(z + 1))) ||
            (dz < -1 && fz < J && !solid(env, x, y, int(z - 1)));
    })();
    const mesh = env.meshes.get(state.id);
    if (!mesh)
        return;
    const vx = path_index > 0 ? cur[0] - path[path_index - 1][0] : dx;
    const vz = path_index > 0 ? cur[2] - path[path_index - 1][2] : dz;
    mesh.heading = Math.atan2(vx, vz);
};
const runPathing = (env, state) => {
    if (!state.path && !state.target)
        return;
    const body = env.physics.get(state.id);
    if (!body)
        return;
    if (state.target)
        findPath(env, state, body);
    if (state.path)
        followPath(env, state, body);
};
const Pathing = (env) => ({
    init: () => ({
        id: kNoEntity,
        index: 0,
        path: null,
        path_index: 0,
        path_soft_target: null,
        target: null,
        soft_target: null,
    }),
    onUpdate: (dt, states) => {
        for (const state of states)
            runPathing(env, state);
    }
});
;
const Meshes = (env) => ({
    init: () => ({
        id: kNoEntity,
        index: 0,
        mesh: null,
        heading: null,
        columns: 0,
        column: 0,
        frame: 0,
        row: 0,
    }),
    onRemove: (state) => { var _a; return (_a = state.mesh) === null || _a === void 0 ? void 0 : _a.dispose(); },
    onRender: (dt, states) => {
        const camera = env.renderer.camera;
        let cx = camera.position[0], cz = camera.position[2];
        env.target.each(state => {
            const { x, y, z, h, w } = env.position.getX(state.id);
            cx = x - camera.zoom * Math.sin(camera.heading);
            cz = z - camera.zoom * Math.cos(camera.heading);
        });
        for (const state of states) {
            if (!state.mesh)
                continue;
            const { x, y, z, h } = env.position.getX(state.id);
            const lit = env.world.isBlockLit(int(Math.floor(x)), int(Math.floor(y)), int(Math.floor(z)));
            state.mesh.setPosition(x, y - h / 2, z);
            state.mesh.setLight(lit ? 1 : 0.64);
            state.mesh.setHeight(h);
            if (state.heading !== null) {
                const camera_heading = Math.atan2(x - cx, z - cz);
                const delta = state.heading - camera_heading;
                state.row = Math.floor(8.5 - 2 * delta / Math.PI) & 3;
                state.mesh.setFrame(int(state.column + state.row * state.columns));
            }
        }
    },
    onUpdate: (dt, states) => {
        for (const state of states) {
            if (!state.mesh || !state.columns)
                return;
            const body = env.physics.get(state.id);
            if (!body)
                return;
            state.column = (() => {
                if (body.resting[1] >= 0)
                    return 1;
                const distance = dt * Vec3.length(body.vel);
                state.frame = distance ? (state.frame + 0.75 * distance) % 4 : 0;
                if (!distance)
                    return 0;
                const value = Math.floor(state.frame);
                return value & 1 ? 0 : (value + 2) >> 1;
            })();
            state.mesh.setFrame(int(state.column + state.row * state.columns));
        }
    },
});
;
const Shadow = (env) => ({
    init: () => ({ id: kNoEntity, index: 0, mesh: null, extent: 16, height: 0 }),
    onRemove: (state) => { var _a; return (_a = state.mesh) === null || _a === void 0 ? void 0 : _a.dispose(); },
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
            const x = int(Math.floor(position.x));
            const y = int(Math.floor(position.y));
            const z = int(Math.floor(position.z));
            state.height = (() => {
                for (let i = 0; i < state.extent; i++) {
                    const h = y - i;
                    if (solid(env, x, int(h - 1), z))
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
    for (let x = int(ax); x <= bx; x++) {
        for (let z = int(az); z <= bz; z++) {
            height = Math.max(height, getHeight(x, z));
        }
    }
    return height + 0.5 * (position.h + 1);
};
const addEntity = (env, image, size, x, z, h, w, maxSpeed, moveForceFactor, jumpForce, jumpImpulse) => {
    const entity = env.entities.addEntity();
    const position = env.position.add(entity);
    position.x = x + 0.5;
    position.z = z + 0.5;
    position.w = w;
    position.h = h;
    position.y = safeHeight(position);
    const movement = env.movement.add(entity);
    movement.maxSpeed = maxSpeed;
    movement.moveForce = maxSpeed * moveForceFactor;
    movement.jumpForce = jumpForce;
    movement.jumpImpulse = jumpImpulse;
    const mesh = env.meshes.add(entity);
    const sprite = { url: `images/${image}.png`, x: int(32), y: int(32) };
    mesh.mesh = env.renderer.addSpriteMesh(size, sprite);
    mesh.columns = 3;
    env.physics.add(entity);
    env.shadow.add(entity);
    return entity;
};
const main = () => {
    const env = new TypedEnv('container');
    const size = 1;
    const player = addEntity(env, 'player', size, 1, 1, 0.8, 0.6, 8, 4, 10, 7.5);
    env.inputs.add(player);
    env.target.add(player);
    const follower = addEntity(env, 'follower', size, 1, 1, 0.6, 0.6, 12, 8, 15, 10);
    env.meshes.getX(follower).heading = 0;
    env.pathing.add(follower);
    const texture = (x, y, alphaTest = false, sparkle = false) => {
        const url = 'images/frlg.png';
        return { alphaTest, sparkle, url, x, y, w: 16, h: 16 };
    };
    const block = (x, y) => {
        const url = 'images/frlg.png';
        const frame = int(x + 16 * y);
        return env.renderer.addInstancedMesh(frame, { url, x: 16, y: 16 });
    };
    const registry = env.registry;
    registry.addMaterialOfColor('blue', [0.1, 0.1, 0.4, 0.6], true);
    registry.addMaterialOfTexture('water', texture(13, 12, false, true), [1, 1, 1, 0.8], true);
    const textures = [
        ['bedrock', 1, 1],
        ['dirt', 2, 0],
        ['grass', 0, 0],
        ['grass-side', 3, 0],
        ['stone', 1, 0],
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
        bush: registry.addBlockMesh(block(4, 3), true),
        dirt: registry.addBlock(['dirt'], true),
        grass: registry.addBlock(['grass', 'dirt', 'grass-side'], true),
        rock: registry.addBlockMesh(block(1, 3), true),
        sand: registry.addBlock(['sand'], true),
        snow: registry.addBlock(['snow'], true),
        stone: registry.addBlock(['stone'], true),
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