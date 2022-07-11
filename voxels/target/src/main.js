import { makeNoise2D } from '../lib/open-simplex-2d.js';
import { Vec3 } from './base.js';
import { Env } from './engine.js';
import { kEmptyBlock, kWorldHeight } from './engine.js';
import { kNoEntity } from './ecs.js';
import { sweep } from './sweep.js';
//////////////////////////////////////////////////////////////////////////////
// The game code:
class TypedEnv extends Env {
    constructor(id) {
        super(id);
        this.addedBlock = kEmptyBlock;
        const ents = this.entities;
        this.position = ents.registerComponent('position', Position);
        this.movement = ents.registerComponent('movement', Movement(this));
        this.physics = ents.registerComponent('physics', Physics(this));
        this.meshes = ents.registerComponent('meshes', Meshes(this));
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
        inFluid: false,
        friction: 0,
        mass: 1,
        autoStep: 0.25,
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
const tryToModifyBlock = (env, body, add) => {
    const target = env.getTargetedBlock();
    if (target === null)
        return;
    Vec3.copy(kTmpPos, target);
    if (add) {
        const side = env.getTargetedBlockSide();
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
    const block = add ? env.addedBlock : kEmptyBlock;
    env.world.setBlock(kTmpPos[0], kTmpPos[1], kTmpPos[2], block);
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
            state.mesh.setPosition(x, y - h / 2, z);
        }
    },
    onUpdate: (dt, states) => {
        for (const state of states) {
            if (!state.mesh)
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
// CameraTarget signifies that the camera will follow an entity.
const CameraTarget = (env) => ({
    init: () => ({ id: kNoEntity, index: 0 }),
    onRender: (dt, states) => {
        for (const state of states) {
            const { x, y, z, h } = env.position.getX(state.id);
            env.renderer.camera.setTarget(x, y + h / 3, z);
        }
    },
    onUpdate: (dt, states) => {
        for (const state of states) {
            const { x, y, z } = env.position.getX(state.id);
            env.world.recenter(x, y, z);
        }
    },
});
// Noise helpers:
let noise_counter = (Math.random() * (1 << 30)) | 0;
const perlin2D = () => {
    return makeNoise2D(noise_counter++);
};
const fractalPerlin2D = (amplitude, radius, growth, count) => {
    const factor = Math.pow(2, growth);
    const components = new Array(count).fill(null).map(perlin2D);
    return (x, y) => {
        let result = 0;
        let r = radius;
        let a = amplitude;
        for (const component of components) {
            result += a * component(x / r, y / r);
            a *= factor;
            r *= 2;
        }
        return result;
    };
};
// Putting it all together:
const main = () => {
    const env = new TypedEnv('container');
    const player = env.entities.addEntity();
    const position = env.position.add(player);
    position.x = 1;
    position.y = kWorldHeight;
    position.z = 1;
    position.w = 0.7;
    position.h = 1.4;
    const size = 1.25 * position.h;
    const mesh = env.meshes.add(player);
    const sprite = { url: 'images/player.png', size, x: 32, y: 32 };
    mesh.mesh = env.renderer.addSpriteMesh(sprite);
    env.physics.add(player);
    env.movement.add(player);
    env.target.add(player);
    const texture = (x, y, alphaTest = false) => {
        return { alphaTest, url: 'images/rhodox-edited.png', x, y, w: 16, h: 16 };
    };
    const registry = env.registry;
    registry.addMaterialOfColor('blue', [0.1, 0.1, 0.4, 0.4], true);
    registry.addMaterialOfTexture('water', texture(13, 12), [1, 1, 1, 0.8], true);
    registry.addMaterialOfTexture('leaves', texture(4, 3, true));
    const textures = [
        ['bedrock', 1, 1],
        ['dirt', 2, 0],
        ['grass', 0, 0],
        ['grass-side', 3, 0],
        ['sand', 0, 11],
        ['snow', 2, 4],
        ['stone', 1, 0],
        ['trunk', 5, 1],
        ['trunk-side', 4, 1],
    ];
    for (const [name, x, y] of textures) {
        registry.addMaterialOfTexture(name, texture(x, y));
    }
    const rock = registry.addBlock(['stone'], true);
    const dirt = registry.addBlock(['dirt'], true);
    const sand = registry.addBlock(['sand'], true);
    const snow = registry.addBlock(['snow'], true);
    const grass = registry.addBlock(['grass', 'dirt', 'grass-side'], true);
    const bedrock = registry.addBlock(['bedrock'], true);
    const water = registry.addBlock(['water', 'blue', 'blue'], false);
    const trunk = registry.addBlock(['trunk', 'trunk-side'], true);
    const leaves = registry.addBlock(['leaves'], true);
    env.addedBlock = dirt;
    // Composite noise functions.
    const minetest_noise_2d = (offset, scale, spread, octaves, persistence, lacunarity) => {
        const components = new Array(octaves).fill(null).map(perlin2D);
        return (x, y) => {
            let f = 1, g = 1;
            let result = 0;
            x /= spread;
            y /= spread;
            for (let i = 0; i < octaves; i++) {
                result += g * components[i](x * f, y * f);
                f *= lacunarity;
                g *= persistence;
            }
            return scale * result + offset;
        };
    };
    const ridgeNoise = (octaves, persistence, scale) => {
        const components = new Array(4).fill(null).map(perlin2D);
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
    const mgv7_np_cliff_select = minetest_noise_2d(0, 1, 512, 4, 0.7, 2.0);
    const mgv7_np_mountain_select = minetest_noise_2d(0, 1, 512, 4, 0.7, 2.0);
    const mgv7_np_terrain_ground = minetest_noise_2d(2, 8, 512, 6, 0.6, 2.0);
    const mgv7_np_terrain_cliff = minetest_noise_2d(8, 16, 512, 6, 0.6, 2.0);
    const mgv7_mountain_ridge = ridgeNoise(8, 0.5, 0.002);
    // Cave generation.
    const kIslandRadius = 1024;
    const kSeaLevel = (kWorldHeight / 4) | 0;
    const kCaveLevels = 3;
    const kCaveDeltaY = 0;
    const kCaveHeight = 8;
    const kCaveRadius = 16;
    const kCaveCutoff = 0.25;
    const kCaveWaveHeight = 16;
    const kCaveWaveRadius = 256;
    const cave_noises = new Array(2 * kCaveLevels).fill(null).map(perlin2D);
    const carve_caves = (x, z, column) => {
        const start = kSeaLevel - kCaveDeltaY * (kCaveLevels - 1) / 2;
        for (let i = 0; i < kCaveLevels; i++) {
            const carver_noise = cave_noises[2 * i + 0];
            const height_noise = cave_noises[2 * i + 1];
            const carver = carver_noise(x / kCaveRadius, z / kCaveRadius);
            if (carver > kCaveCutoff) {
                const dy = start + i * kCaveDeltaY;
                const height = height_noise(x / kCaveWaveRadius, z / kCaveWaveRadius);
                const offset = (dy + kCaveWaveHeight * height) | 0;
                const blocks = ((carver - kCaveCutoff) * kCaveHeight) | 0;
                for (let i = 0; i < 2 * blocks + 3; i++) {
                    column.overwrite(kEmptyBlock, offset + i - blocks);
                }
            }
        }
    };
    // Tree generation.
    const hash_fnv32 = (k) => {
        let result = 2166136261;
        for (let i = 0; i < 4; i++) {
            result ^= (k & 255);
            result *= 16777619;
            k = k >> 8;
        }
        return result;
    };
    const kMask = (1 << 15) - 1;
    const has_tree = (x, z) => {
        const base = hash_fnv32(((x & kMask) << 15) | (z & kMask));
        return (base & 63) <= 3;
    };
    // Terrain generation.
    const loadChunk = (x, z, column, lod) => {
        const base = Math.sqrt(x * x + z * z) / kIslandRadius;
        const falloff = 16 * base * base;
        if (falloff >= kSeaLevel)
            return column.push(water, kSeaLevel);
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
                return dirt;
            if (height_mountain > height_ground) {
                const base = height - (72 - 8 * mountain);
                return base > 0 ? snow : rock;
            }
            if (height_cliff > height_ground)
                return dirt;
            return truncated < 1 ? sand : grass;
        })();
        if (lod) {
            column.push(tile, abs_height);
            column.push(water, kSeaLevel);
            return;
        }
        if (tile === snow) {
            const base = height - (72 - 8 * mountain);
            const depth = Math.min(3, Math.floor(base / 8) + 1);
            column.push(rock, abs_height - depth);
        }
        else if (tile !== rock) {
            column.push(rock, abs_height - 4);
            column.push(dirt, abs_height - 1);
        }
        column.push(tile, abs_height);
        column.push(water, kSeaLevel);
        if (tile === grass && has_tree(x, z)) {
            column.push(leaves, abs_height + 1);
        }
        carve_caves(x, z, column);
    };
    env.world.setLoader(bedrock, (x, z, column) => loadChunk(x, z, column, false), (x, z, column) => loadChunk(x, z, column, true));
    env.refresh();
};
window.onload = main;
//# sourceMappingURL=main.js.map