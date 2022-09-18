import { assert, int, nonnull } from './base.js';
//////////////////////////////////////////////////////////////////////////////
class Point {
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }
    add(o) {
        return new Point(int(this.x + o.x), int(this.y + o.y), int(this.z + o.z));
    }
    sub(o) {
        return new Point(int(this.x - o.x), int(this.y - o.y), int(this.z - o.z));
    }
    distanceL2(o) {
        return Math.sqrt(this.distanceSquared(o));
    }
    distanceSquared(o) {
        const dx = this.x - o.x;
        const dy = this.y - o.y;
        const dz = this.z - o.z;
        return int(dx * dx + dy * dy + dz * dz);
    }
    equal(o) {
        return this.x === o.x && this.y === o.y && this.z === o.z;
    }
    toString() { return `Point(${this.x}, ${this.y}, ${this.z})`; }
}
Point.origin = new Point(0, 0, 0);
;
//////////////////////////////////////////////////////////////////////////////
class Direction extends Point {
    constructor(x, y, z) { super(x, y, z); }
    static assert(point) {
        if (point.equal(Direction.none))
            return Direction.none;
        return nonnull(Direction.all.filter(x => x.equal(point))[0]);
    }
}
Direction.none = new Direction(0, 0, 0);
Direction.n = new Direction(0, 0, -1);
Direction.ne = new Direction(1, 0, -1);
Direction.e = new Direction(1, 0, 0);
Direction.se = new Direction(1, 0, 1);
Direction.s = new Direction(0, 0, 1);
Direction.sw = new Direction(-1, 0, 1);
Direction.w = new Direction(-1, 0, 0);
Direction.nw = new Direction(-1, 0, -1);
Direction.up = new Direction(0, 1, 0);
Direction.down = new Direction(0, -1, 0);
Direction.all = [Direction.n, Direction.ne, Direction.e, Direction.se,
    Direction.s, Direction.sw, Direction.w, Direction.nw];
Direction.cardinal = [Direction.n, Direction.e, Direction.s, Direction.w];
Direction.diagonal = [Direction.ne, Direction.se, Direction.sw, Direction.nw];
;
//////////////////////////////////////////////////////////////////////////////
class AStarNode extends Point {
    constructor(p, parent, distance, score) {
        super(p.x, p.y, p.z);
        this.parent = parent;
        this.distance = distance;
        this.score = score;
        this.index = null;
    }
}
const AStarHeapCheckInvariants = (heap) => {
    return; // Comment this line out to enable debug checks.
    heap.map(x => `(${x.index}, ${x.score})`).join('; ');
    heap.forEach((node, index) => {
        const debug = (label) => {
            const contents = heap.map(x => `(${x.index}, ${x.score})`).join('; ');
            return `Violated ${label} at ${index}: ${contents}`;
        };
        assert(node.index === index, () => debug('index'));
        if (index === 0)
            return;
        const parent_index = Math.floor((index - 1) / 2);
        assert(heap[parent_index].score <= node.score, () => debug('ordering'));
    });
};
const AStarHeapPush = (heap, node) => {
    assert(node.index === null);
    heap.push(node);
    AStarHeapify(heap, node, int(heap.length - 1));
};
const AStarHeapify = (heap, node, index) => {
    assert(0 <= index && index < heap.length);
    const score = node.score;
    while (index > 0) {
        const parent_index = int((index - 1) / 2);
        const parent = heap[parent_index];
        if (parent.score <= score)
            break;
        heap[index] = parent;
        parent.index = index;
        index = parent_index;
    }
    heap[index] = node;
    node.index = index;
    AStarHeapCheckInvariants(heap);
};
const AStarHeapExtractMin = (heap) => {
    assert(heap.length > 0);
    const result = heap[0];
    const node = heap.pop();
    result.index = null;
    if (!heap.length)
        return result;
    let index = int(0);
    while (2 * index + 1 < heap.length) {
        const c1 = heap[2 * index + 1];
        const c2 = heap[2 * index + 2] || c1;
        if (node.score <= Math.min(c1.score, c2.score))
            break;
        const child_index = int(2 * index + (c1.score > c2.score ? 2 : 1));
        const child = (c1.score > c2.score ? c2 : c1);
        heap[index] = child;
        child.index = index;
        index = child_index;
    }
    heap[index] = node;
    node.index = index;
    AStarHeapCheckInvariants(heap);
    return result;
};
const AStarUnitCost = 16;
const AStarUpCost = 64;
const AStarDownCost = 4;
const AStarLimit = int(256);
const AStarKey = (p, source) => {
    const result = (((p.x - source.x) & 0x3ff) << 0) |
        (((p.y - source.y) & 0x3ff) << 10) |
        (((p.z - source.z) & 0x3ff) << 20);
    return result;
};
const AStarHeuristic = (source, target) => {
    let dx = target.x - source.x;
    let dy = target.y - source.y;
    let dz = target.z - source.z;
    if (dx !== 0 || dy !== 0 || dz !== 0) {
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= length;
        dy /= length;
        dz /= length;
    }
    return (p) => {
        const ax = p.x - target.x;
        const ay = p.y - target.y;
        const az = p.z - target.z;
        const dot = ax * dx + ay * dy + az * dz;
        const ox = ax - dot * dx;
        const oy = ay - dot * dy;
        const oz = az - dot * dz;
        const off = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const base = AStarUnitCost * (Math.abs(ax) + Math.abs(az) + off);
        return base + ay * (ay > 0 ? AStarDownCost : -AStarUpCost);
    };
};
const AStarHeight = (source, target, check) => {
    const { up, down } = Direction;
    if (!check(target)) {
        const jump = check(source.add(up)) && check(target.add(up));
        return jump ? int(target.y + 1) : null;
    }
    let floor = target.add(down);
    while (floor.y >= 0 && check(floor)) {
        floor = floor.add(down);
    }
    return int(floor.y + 1);
};
const AStarNeighbors = (source, check) => {
    const result = [];
    const { up, down } = Direction;
    const adjust = (p, y) => {
        return y === p.y ? p : new Point(p.x, y, p.z);
    };
    for (const dir of Direction.cardinal) {
        const next = source.add(dir);
        const ny = AStarHeight(source, next, check);
        if (ny === null)
            continue;
        result.push(adjust(next, ny));
        if (ny < next.y && check(source.add(up)) && check(next.add(up))) {
            const jump = next.add(dir);
            if (check(jump) && check(jump.add(up))) {
                let floor = jump.add(down);
                while (floor.y >= 0 && check(floor)) {
                    floor = floor.add(down);
                }
                const jy = int(floor.y + 1);
                if (jy > ny)
                    result.push(adjust(jump, jy));
            }
        }
    }
    return result;
};
const AStar = (source, target, check, limit, record) => {
    console.log(`AStar: ${source.toString()} -> ${target.toString()}`);
    let count = 0;
    limit = limit ? limit : AStarLimit;
    let best = null;
    const map = new Map();
    const heap = [];
    const heuristic = AStarHeuristic(source, target);
    const score = heuristic(source);
    const node = new AStarNode(source, null, 0, score);
    map.set(AStarKey(source, source), node);
    AStarHeapPush(heap, node);
    while (count < limit && heap.length > 0) {
        const cur = AStarHeapExtractMin(heap);
        console.log(`  ${count}: ${cur.toString()}: distance = ${cur.distance}, score = ${cur.score}`);
        if (record)
            record.push(cur);
        count++;
        if (cur.equal(target)) {
            best = cur;
            break;
        }
        for (const next of AStarNeighbors(cur, check)) {
            const dy = next.y - cur.y;
            const xz = Math.abs(next.x - cur.x) + Math.abs(next.z - cur.z);
            const ud = dy * (dy > 0 ? AStarUpCost : -AStarDownCost);
            const distance = cur.distance + xz * AStarUnitCost + ud;
            const key = AStarKey(next, source);
            const existing = map.get(key);
            // index !== null is a check to see if we've already popped this node
            // from the heap. We need it because our heuristic is not admissible.
            //
            // Using such a heuristic substantially speeds up search in easy cases,
            // with the downside that we don't always find an optimal path.
            if (existing && existing.index !== null && existing.distance > distance) {
                existing.score += distance - existing.distance;
                existing.distance = distance;
                existing.parent = cur;
                AStarHeapify(heap, existing, existing.index);
            }
            else if (!existing) {
                const score = distance + heuristic(next);
                const created = new AStarNode(next, cur, distance, score);
                AStarHeapPush(heap, created);
                map.set(key, created);
            }
        }
    }
    if (best === null) {
        const heuristic = (x) => x.score - x.distance;
        for (const node of map.values()) {
            if (!best || heuristic(node) < heuristic(best))
                best = node;
        }
    }
    const result = [];
    while (best) {
        result.push(best);
        best = best.parent;
    }
    console.log(`Found ${result.length}-node path:`);
    for (let i = result.length - 1; i >= 0; i--) {
        console.log(`  ${result[i].toString()}`);
    }
    return result.reverse();
};
//////////////////////////////////////////////////////////////////////////////
export { AStar, Direction, Point };
//# sourceMappingURL=pathing.js.map