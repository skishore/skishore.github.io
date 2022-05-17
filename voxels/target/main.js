import { Vec3 } from './base.js';
import { Env, kEmptyBlock, kWorldHeight } from './engine.js';
import { kNoEntity } from './ecs.js';
import { sweep } from './sweep.js';
//////////////////////////////////////////////////////////////////////////////
// The game code:
class TypedEnv extends Env {
    constructor(id) {
        super(id);
        const ents = this.entities;
        this.position = ents.registerComponent('position', Position);
        this.movement = ents.registerComponent('movement', Movement(this));
        this.physics = ents.registerComponent('physics', Physics(this));
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
    // Update our state based on the computations above.
    Vec3.add(state.vel, state.vel, kTmpDelta);
    Vec3.scale(state.vel, state.vel, left);
    Vec3.scale(kTmpDelta, state.vel, dt);
    sweep(state.min, state.max, kTmpDelta, state.resting, (p) => {
        const block = env.world.getBlock(p[0], p[1], p[2]);
        return !env.registry.solid[block];
    });
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
        inFluid: false,
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
        airJumps: 9999,
        jumpTime: 0.2,
        jumpForce: 15,
        jumpImpulse: 10,
        _jumped: false,
        _jumpCount: 0,
        _jumpTimeLeft: 0,
    }),
    onUpdate: (dt, states) => {
        for (const state of states)
            runMovement(env, dt, state);
    }
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
// Perlin noise implementation:
const perlin2D = () => {
    const getPermutation = (x) => {
        const result = [];
        for (let i = 0; i < x; i++) {
            result.push(i);
            const idx = Math.floor(Math.random() * result.length);
            result[result.length - 1] = result[idx];
            result[idx] = i;
        }
        return result;
    };
    const count = 256;
    const table = getPermutation(count);
    table.slice().forEach(x => table.push(x));
    const gradients = [];
    for (let i = 0; i < count; i++) {
        const angle = 2 * Math.PI * i / count;
        gradients.push([Math.cos(angle), Math.sin(angle)]);
    }
    const dot = (gradient, x, y) => {
        return gradient[0] * x + gradient[1] * y;
    };
    const fade = (x) => {
        return x * x * x * (x * (x * 6 - 15) + 10);
    };
    const lerp = (x, a, b) => {
        return a + x * (b - a);
    };
    const noise = (x, y) => {
        let ix = Math.floor(x);
        let iy = Math.floor(y);
        x -= ix;
        y -= iy;
        ix &= 255;
        iy &= 255;
        const g00 = table[ix + table[iy]];
        const g10 = table[ix + 1 + table[iy]];
        const g01 = table[ix + table[iy + 1]];
        const g11 = table[ix + 1 + table[iy + 1]];
        const n00 = dot(gradients[g00], x, y);
        const n10 = dot(gradients[g10], x - 1, y);
        const n01 = dot(gradients[g01], x, y - 1);
        const n11 = dot(gradients[g11], x - 1, y - 1);
        const fx = fade(x);
        const fy = fade(y);
        const y1 = lerp(fx, n00, n10);
        const y2 = lerp(fx, n01, n11);
        return lerp(fy, y1, y2);
    };
    return noise;
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
    position.w = 0.8;
    position.h = 1.6;
    env.physics.add(player);
    env.movement.add(player);
    env.target.add(player);
    const registry = env.registry;
    registry.addMaterialOfColor('blue', [0.1, 0.1, 0.4, 0.4], true);
    registry.addMaterialOfTexture('water', 'images/mc_water.png', [1, 1, 1, 0.8], true);
    const textures = ['bedrock', 'grass', 'grass_dirt', 'dirt', 'sand', 'snow', 'stone'];
    for (const texture of textures) {
        registry.addMaterialOfTexture(texture, `images/mc_${texture}.png`);
    }
    const rock = registry.addBlock(['stone'], true);
    const dirt = registry.addBlock(['dirt'], true);
    const sand = registry.addBlock(['sand'], true);
    const snow = registry.addBlock(['snow'], true);
    const grass = registry.addBlock(['grass', 'dirt', 'grass_dirt'], true);
    const bedrock = registry.addBlock(['bedrock'], true);
    const water = registry.addBlock(['water', 'blue', 'blue'], false);
    const H = kWorldHeight;
    const S = Math.floor(kWorldHeight / 2);
    const tiles = [[dirt, S - 2], [sand, S + 1], [grass, S + 31], [dirt, S + 33], [snow, H]];
    const noise = fractalPerlin2D(2, 8, 1.0, 6);
    const loader = (x, z, column) => {
        let last = 0;
        const target = Math.max(Math.round(noise(x, z) + H / 2), 0);
        for (const [tile, height] of tiles) {
            const next = Math.min(height, target);
            column.push(tile, next - last);
            if ((last = next) === target)
                break;
        }
        column.push(water, S - last);
    };
    env.world.setLoader(bedrock, loader);
    env.refresh();
};
window.onload = main;
//# sourceMappingURL=main.js.map