import { assert, int, Vec3 } from './base.js';
import { Geometry } from './renderer.js';
// A frontier heightmap has a (tile, height) for each (x, z) pair.
const kHeightmapFields = 2;
const kNoMaterial = 0;
const kEmptyBlock = 0;
const kSentinel = 1 << 30;
;
;
//////////////////////////////////////////////////////////////////////////////
const pack_indices = (xs) => {
    assert(xs.length === 6);
    let result = 0;
    for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        assert(x === (x | 0));
        assert(0 <= x && x < 4);
        result |= x << (i * 2);
    }
    return int(result);
};
//////////////////////////////////////////////////////////////////////////////
const kCachedGeometryA = Geometry.empty();
const kCachedGeometryB = Geometry.empty();
const kTmpPos = Vec3.create();
const kTmpShape = [0, 0, 0];
let kMaskData = new Int32Array();
let kMaskUnion = new Int32Array();
const kWaveValues = [0b0110, 0b1111, 0b1100];
const kIndexOffsets = {
    A: pack_indices([0, 1, 2, 0, 2, 3]),
    B: pack_indices([1, 2, 3, 0, 1, 3]),
    C: pack_indices([0, 2, 1, 0, 3, 2]),
    D: pack_indices([3, 1, 0, 3, 2, 1]),
};
const kHeightmapSides = [
    [0, 1, 2, 1, 0, int(0x82)],
    [0, 1, 2, -1, 0, int(0x82)],
    [2, 0, 1, 0, 1, int(0x06)],
    [2, 0, 1, 0, -1, int(0x06)],
];
class TerrainMesher {
    constructor(registry, renderer) {
        this.solid = registry.solid;
        this.opaque = registry.opaque;
        this.getBlockFaceMaterial = registry.getBlockFaceMaterial.bind(registry);
        this.getMaterialData = registry.getMaterialData.bind(registry);
        this.renderer = renderer;
    }
    meshChunk(voxels, heightmap, equilevels, solid, water) {
        const solid_geo = solid ? solid.getGeometry() : kCachedGeometryA;
        const water_geo = water ? water.getGeometry() : kCachedGeometryB;
        solid_geo.clear();
        water_geo.clear();
        this.computeChunkGeometryWithEquilevels(solid_geo, water_geo, voxels, heightmap, equilevels);
        return [
            this.buildMesh(solid_geo, solid, 0),
            this.buildMesh(water_geo, water, 1),
        ];
    }
    meshFrontier(heightmap, mask, px, pz, sx, sz, scale, old, solid) {
        const geo = old ? old.getGeometry() : kCachedGeometryA;
        if (old)
            geo.dirty = true;
        if (!old)
            geo.clear();
        const Stride = Geometry.StrideInInt32;
        const source = Stride * geo.num_quads;
        this.computeFrontierGeometry(geo, heightmap, sx, sz, scale, solid);
        const quads = geo.quads;
        const target = Stride * geo.num_quads;
        for (let offset = source; offset < target; offset += Stride) {
            // TODO(skishore): Use 20 bits for x and z and 12 for y and indices,
            // because the LOD meshes are bounded to 256 in the y dimension but
            // grow exponentially larger in the x and z dimensions.
            const xy = quads[offset + 0];
            const zi = quads[offset + 1];
            const x = (xy << 16) >> 16;
            const z = (zi << 16) >> 16;
            const nx = x + px;
            const nz = z + pz;
            assert(nx === (nx << 16) >> 16);
            assert(nz === (nz << 16) >> 16);
            quads[offset + 0] = (nx & 0xffff) | ((xy >> 16) << 16);
            quads[offset + 1] = (nz & 0xffff) | ((zi >> 16) << 16);
            quads[offset + 3] |= mask;
        }
        return this.buildMesh(geo, old, solid ? 0 : 1);
    }
    buildMesh(geo, old, phase) {
        if (geo.num_quads === 0) {
            if (old)
                old.dispose();
            return null;
        }
        else if (old) {
            old.setGeometry(geo);
            return old;
        }
        return this.renderer.addVoxelMesh(Geometry.clone(geo), phase);
    }
    computeChunkGeometryWithEquilevels(solid_geo, water_geo, voxels, heightmap, equilevels) {
        let max_height = int(0);
        const heightmap_data = heightmap.data;
        for (let i = 0; i < heightmap_data.length; i++) {
            max_height = int(Math.max(max_height, heightmap_data[i]));
        }
        assert(voxels.stride[1] === 1);
        assert(voxels.shape[1] === equilevels.length);
        const data = voxels.data;
        const limit = equilevels.length - 1;
        const index = voxels.index(1, 0, 1);
        const opaque = this.opaque;
        const skip_level = (i) => {
            const el0 = equilevels[i + 0];
            const el1 = equilevels[i + 1];
            if (el0 + el1 !== 2)
                return false;
            const block0 = data[index + i + 0];
            const block1 = data[index + i + 1];
            if (block0 === block1)
                return true;
            return opaque[block0] && opaque[block1];
        };
        for (let i = int(0); i < limit; i++) {
            if (skip_level(i))
                continue;
            let j = int(i + 1);
            for (; j < limit; j++) {
                if (skip_level(j))
                    break;
            }
            const y_min = i;
            const y_max = int(Math.min(j, max_height) + 1);
            if (y_min >= y_max)
                break;
            this.computeChunkGeometry(solid_geo, water_geo, voxels, y_min, y_max);
            i = j;
        }
    }
    computeChunkGeometry(solid_geo, water_geo, voxels, y_min, y_max) {
        const { data, shape, stride } = voxels;
        kTmpShape[0] = shape[0];
        kTmpShape[1] = int(y_max - y_min);
        kTmpShape[2] = shape[2];
        for (const d of [1, 0, 2]) {
            const face = int(d * 2);
            const v = (d === 1 ? 0 : 1);
            const u = 3 - d - v;
            const ld = kTmpShape[d] - 1, lu = kTmpShape[u] - 2, lv = kTmpShape[v] - 2;
            const sd = stride[d], su = stride[u], sv = stride[v];
            const base = su + sv + y_min * stride[1];
            // d is the dimension that the quad faces. A d of {0, 1, 2} corresponds
            // to a quad with a normal that's a unit vector on the {x, y, z} axis,
            // respectively. u and v are the orthogonal dimensions along which we
            // compute the quad's width and height.
            //
            // The simplest way to handle coordinates here is to let (d, u, v)
            // be consecutive dimensions mod 3. That's how VoxelShader interprets
            // data for a quad facing a given dimension d.
            //
            // However, to optimize greedy meshing, we want to take advantage of
            // the fact that the y-axis is privileged in multiple ways:
            //
            //    1. Our chunks are limited in the x- and z-dimensions, but span
            //       the entire world in the y-dimension, so this axis is longer.
            //
            //    2. The caller may have a heightmap limiting the maximum height
            //       of a voxel by (x, z) coordinate, which we can use to cut the
            //       greedy meshing inner loop short.
            //
            // As a result, we tweak the d = 0 case to use (u, v) = (2, 1) instead
            // of (u, v) = (1, 2). To map back to the standard coordinates used by
            // the shader, we only need to fix up two inputs to addQuad: (w, h) and
            // the bit-packed AO mask. w_fixed, h_fixed, su_fixed, and sv_fixed are
            // the standard-coordinates versions of these values.
            //
            const su_fixed = d > 0 ? su : sv;
            const sv_fixed = d > 0 ? sv : su;
            const area = lu * lv;
            if (kMaskData.length < area) {
                kMaskData = new Int32Array(area);
            }
            if (kMaskUnion.length < lu) {
                kMaskUnion = new Int32Array(lu);
            }
            for (let id = 0; id < ld; id++) {
                let n = 0;
                let complete_union = 0;
                for (let iu = 0; iu < lu; iu++) {
                    kMaskUnion[iu] = 0;
                    let index = base + id * sd + iu * su;
                    for (let iv = 0; iv < lv; iv++, index += sv, n += 1) {
                        // mask[n] is the face between (id, iu, iv) and (id + 1, iu, iv).
                        // Its value is the MaterialId to use, times -1, if it is in the
                        // direction opposite `face`.
                        //
                        // When we enable lighting and ambient occlusion, we pack these
                        // values into the mask, because if the lighting is different for
                        // two adjacent voxels, we can't combine them into the same greedy
                        // meshing quad. The packed layout is:
                        //
                        //    - bits 0:8:  AO value (4 x 2-bit values)
                        //    - bits 8:9:  dir in {0, 1} (0 -> -1, 1 -> +1)
                        //    - bits 9:24: material index
                        //
                        const block0 = data[index];
                        const block1 = data[index + sd];
                        if (block0 === block1)
                            continue;
                        const dir = this.getFaceDir(block0, block1, face);
                        if (dir === 0)
                            continue;
                        const ix = int(index);
                        const nx = int(index + sd);
                        const material = dir > 0
                            ? this.getBlockFaceMaterial(block0, face)
                            : this.getBlockFaceMaterial(block1, int(face + 1));
                        const ao = dir > 0
                            ? this.packAOMask(data, nx, ix, su_fixed, sv_fixed)
                            : this.packAOMask(data, ix, nx, su_fixed, sv_fixed);
                        const mask = (material << 9) | (dir > 0 ? 1 << 8 : 0) | ao;
                        kMaskData[n] = mask;
                        kMaskUnion[iu] |= mask;
                        complete_union |= mask;
                    }
                }
                if (complete_union === 0)
                    continue;
                // Our data includes a 1-voxel-wide border all around our chunk in
                // all directions. In the y direction, this border is synthetic, but
                // in the x and z direction, the border cells come from other chunks.
                //
                // To avoid meshing a block face twice, we mesh a face the face faces
                // into our chunk. This check applies in the x and z directions.
                //
                // We should actually mesh the face that faces out of the chunk. An
                // LOD mesh, by necessity, has solid walls facing out on all sides,
                // because it must work next to an arbitrary LOD or chunk mesh. By
                // meshing faces facing into chunk meshes, we cause z-fighting at the
                // boundary between chunk meshes and LOD meshes.
                //
                // But we don't yet have a 1-cell border in our lighting textures,
                // so we'll stick with this approach until we do smooth lighting.
                if (d !== 1) {
                    if (id === 0) {
                        for (let i = 0; i < area; i++) {
                            if (!(kMaskData[i] & 0x100))
                                kMaskData[i] = 0;
                        }
                    }
                    else if (id === ld - 1) {
                        for (let i = 0; i < area; i++) {
                            if ((kMaskData[i] & 0x100))
                                kMaskData[i] = 0;
                        }
                    }
                }
                n = 0;
                for (let iu = 0; iu < lu; iu++) {
                    if (kMaskUnion[iu] === 0) {
                        n += lv;
                        continue;
                    }
                    let h = int(1);
                    for (let iv = 0; iv < lv; iv += h, n += h) {
                        const mask = kMaskData[n];
                        if (mask === 0) {
                            h = 1;
                            continue;
                        }
                        for (h = int(1); h < lv - iv; h++) {
                            if (mask != kMaskData[n + h])
                                break;
                        }
                        let w = int(1), nw = n + lv;
                        OUTER: for (; w < lu - iu; w++, nw += lv) {
                            for (let x = 0; x < h; x++) {
                                if (mask != kMaskData[nw + x])
                                    break OUTER;
                            }
                        }
                        kTmpPos[d] = id;
                        kTmpPos[u] = iu;
                        kTmpPos[v] = iv;
                        kTmpPos[1] += y_min;
                        const ao = (mask & 0xff);
                        const dir = (mask & 0x100 ? 1 : -1);
                        const material = this.getMaterialData((mask >> 9));
                        const geo = material.texture.color[3] < 1 ? water_geo : solid_geo;
                        const w_fixed = d > 0 ? w : h;
                        const h_fixed = d > 0 ? h : w;
                        if (material.liquid) {
                            if (d === 1) {
                                const pos = kTmpPos;
                                if (dir > 0) {
                                    const wave = kWaveValues[d];
                                    this.addQuad(geo, material, dir, ao, wave, d, w, h, pos);
                                    this.patchLiquidSurfaceQuads(geo, voxels, ao, w, h, pos);
                                }
                                else {
                                    this.addQuad(geo, material, dir, ao, 0, d, w, h, pos);
                                }
                            }
                            else {
                                const wave = kWaveValues[d];
                                if (h === lv - iv) {
                                    this.addQuad(geo, material, dir, ao, wave, d, w_fixed, h_fixed, kTmpPos);
                                }
                                else {
                                    this.splitLiquidSideQuads(geo, material, voxels, dir, ao, wave, d, w, h, kTmpPos);
                                }
                            }
                        }
                        else {
                            this.addQuad(geo, material, dir, ao, 0, d, w_fixed, h_fixed, kTmpPos);
                            if (material.texture && material.texture.alphaTest) {
                                this.addQuad(geo, material, int(-dir), ao, 0, d, w_fixed, h_fixed, kTmpPos);
                            }
                        }
                        nw = n;
                        for (let wx = 0; wx < w; wx++, nw += lv) {
                            for (let hx = 0; hx < h; hx++) {
                                kMaskData[nw + hx] = 0;
                            }
                        }
                    }
                }
            }
        }
    }
    // We displace a liquid's upper surface downward using the `wave` attribute.
    //
    // When a liquid is adjacent to a downward surface, such as a rock that ends
    // right above the water, we have to add small vertical patches to avoid
    // leaving gaps in the liquid's surface.
    //
    // NOTE: The AO values here are not quite right. For each of the faces we
    // consider (-x, +x, -z, +z), we should broadcast a different subset of the
    // input AO. But doing that is tricky and AO doesn't matter much here.
    patchLiquidSurfaceQuads(geo, voxels, ao, w, h, pos) {
        const base_x = pos[0];
        const base_y = pos[1];
        const base_z = pos[2];
        const water = voxels.get(int(base_x + 1), int(base_y), int(base_z + 1));
        const id = this.getBlockFaceMaterial(water, 0);
        if (id === kNoMaterial)
            return;
        const material = this.getMaterialData(id);
        const patch = (x, z, face) => {
            const ax = int(base_x + x + 1);
            const az = int(base_z + z + 1);
            const below = voxels.get(ax, int(base_y + 0), az);
            if (this.opaque[below] ||
                this.getBlockFaceMaterial(below, face) === kNoMaterial) {
                return false;
            }
            const above = voxels.get(ax, int(base_y + 1), az);
            return this.opaque[above] ||
                this.getBlockFaceMaterial(above, 3) !== kNoMaterial;
        };
        for (let face = int(4); face < 6; face++) {
            const dz = face === 4 ? -1 : w;
            const wave = int(kWaveValues[1] - kWaveValues[2]);
            for (let x = int(0); x < h; x++) {
                if (!patch(x, dz, face))
                    continue;
                let start = x;
                for (x = int(x + 1); x < h; x++) {
                    if (!patch(x, dz, face))
                        break;
                }
                kTmpPos[0] = base_x + start;
                kTmpPos[2] = base_z + Math.max(dz, 0);
                this.addQuad(geo, material, 1, ao, wave, 2, x - start, 0, kTmpPos);
            }
        }
        for (let face = int(0); face < 2; face++) {
            const dx = face === 0 ? -1 : h;
            const wave = int(kWaveValues[1] - kWaveValues[0]);
            for (let z = int(0); z < w; z++) {
                if (!patch(dx, z, face))
                    continue;
                let start = z;
                for (z = int(z + 1); z < w; z++) {
                    if (!patch(dx, z, face))
                        break;
                }
                kTmpPos[0] = base_x + Math.max(dx, 0);
                kTmpPos[2] = base_z + start;
                this.addQuad(geo, material, 1, ao, wave, 0, 0, z - start, kTmpPos);
            }
        }
    }
    // For vertical liquid surfaces, we need to check the block right above the
    // surface to check if the top of this quad should get the wave effect. This
    // test may change along the width of the liquid quad, so we may end up
    // splitting one quad into multiple quads here.
    splitLiquidSideQuads(geo, material, voxels, dir, ao, wave, d, w, h, pos) {
        const base_x = pos[0];
        const base_y = pos[1];
        const base_z = pos[2];
        const ax = int(base_x + (d === 0 && dir > 0 ? 0 : 1));
        const az = int(base_z + (d === 2 && dir > 0 ? 0 : 1));
        const ay = int(base_y + h + 1);
        const test = (i) => {
            const above = d === 0 ? voxels.get(ax, ay, int(az + i))
                : voxels.get(int(ax + i), ay, az);
            const result = !this.opaque[above] &&
                this.getBlockFaceMaterial(above, 3) === kNoMaterial;
            return result;
        };
        let last = test(0);
        for (let i = 0; i < w; i++) {
            let j = int(i + 1);
            for (; j < w && test(j) === last; j++) { }
            const w_fixed = d > 0 ? j - i : h;
            const h_fixed = d > 0 ? h : j - i;
            this.addQuad(geo, material, dir, ao, last ? wave : 0, d, w_fixed, h_fixed, kTmpPos);
            kTmpPos[2 - d] += j - i;
            last = !last;
            i = j - 1;
        }
    }
    computeFrontierGeometry(geo, heightmap, sx, sz, scale, solid) {
        const stride = kHeightmapFields * sx;
        for (let x = 0; x < sx; x++) {
            for (let z = 0; z < sz; z++) {
                const offset = kHeightmapFields * (x + z * sx);
                const block = heightmap[offset + 0];
                const height = heightmap[offset + 1];
                if (block & kSentinel)
                    continue;
                const id = this.getBlockFaceMaterial(block, 2);
                if (id === kNoMaterial)
                    continue;
                const lx = sx - x, lz = sz - z;
                let w = 1, h = 1;
                for (let index = offset + stride; w < lz; w++, index += stride) {
                    const match = heightmap[index + 0] === block &&
                        heightmap[index + 1] === height;
                    if (!match)
                        break;
                }
                OUTER: for (; h < lx; h++) {
                    let index = offset + kHeightmapFields * h;
                    for (let i = 0; i < w; i++, index += stride) {
                        const match = heightmap[index + 0] === block &&
                            heightmap[index + 1] === height;
                        if (!match)
                            break OUTER;
                    }
                }
                Vec3.set(kTmpPos, x * scale, height, z * scale);
                const material = this.getMaterialData(id);
                const sw = scale * w, sh = scale * h;
                const wave = material.liquid ? 0b1111 : 0;
                this.addQuad(geo, material, 1, 0, wave, 1, sw, sh, kTmpPos);
                for (let wi = 0; wi < w; wi++) {
                    let index = offset + stride * wi;
                    for (let hi = 0; hi < h; hi++, index += kHeightmapFields) {
                        heightmap[index] |= kSentinel;
                    }
                }
                z += (w - 1);
            }
        }
        const limit = kHeightmapFields * sx * sz;
        for (let i = 0; i < limit; i += kHeightmapFields) {
            heightmap[i] &= ~kSentinel;
        }
        if (!solid)
            return;
        for (let i = 0; i < 4; i++) {
            const dir = i & 0x1 ? -1 : 1;
            const d = i & 0x2 ? 2 : 0;
            const [u, v, ao, li, lj, si, sj] = d === 0
                ? [1, 2, int(0x82), sx, sz, kHeightmapFields, stride]
                : [0, 1, int(0x06), sz, sx, stride, kHeightmapFields];
            const di = dir > 0 ? si : -si;
            for (let i = 1; i < li; i++) {
                let offset = (i - (dir > 0 ? 1 : 0)) * si;
                for (let j = 0; j < lj; j++, offset += sj) {
                    const block = heightmap[offset + 0];
                    const height = heightmap[offset + 1];
                    // We could use the material at the side of the block with:
                    //  const face = 2 * d + ((1 - dir) >> 1);
                    //
                    // But doing so muddles grass, etc. textures at a distance.
                    const id = this.getBlockFaceMaterial(block, 2);
                    if (id === kNoMaterial)
                        continue;
                    const neighbor = heightmap[offset + 1 + di];
                    if (neighbor >= height)
                        continue;
                    let w = 1;
                    const limit = lj - j;
                    for (let index = offset + sj; w < limit; w++, index += sj) {
                        const match = heightmap[index + 0] === block &&
                            heightmap[index + 1] === height &&
                            heightmap[index + 1 + di] === neighbor;
                        if (!match)
                            break;
                    }
                    const px = d === 0 ? i * scale : j * scale;
                    const pz = d === 0 ? j * scale : i * scale;
                    const wi = d === 0 ? height - neighbor : scale * w;
                    const hi = d === 0 ? scale * w : height - neighbor;
                    Vec3.set(kTmpPos, px, neighbor, pz);
                    const material = this.getMaterialData(id);
                    const wave = material.liquid ? 0b1111 : 0;
                    this.addQuad(geo, material, dir, ao, wave, d, wi, hi, kTmpPos);
                    const extra = w - 1;
                    offset += extra * sj;
                    j += extra;
                }
            }
        }
    }
    addQuad(geo, material, dir, ao, wave, d, w, h, pos) {
        const { num_quads } = geo;
        geo.allocateQuads(int(num_quads + 1));
        const { quads } = geo;
        const Stride = Geometry.StrideInInt32;
        const base = Stride * num_quads;
        const triangleHint = this.getTriangleHint(ao);
        const indices = dir > 0
            ? (triangleHint ? kIndexOffsets.C : kIndexOffsets.D)
            : (triangleHint ? kIndexOffsets.A : kIndexOffsets.B);
        const x = pos[0];
        const y = pos[1];
        const z = pos[2];
        const textureIndex = material.textureIndex;
        assert(x === ((x << 16) >> 16));
        assert(y === ((y << 16) >> 16));
        assert(z === ((z << 16) >> 16));
        assert(w === ((w << 16) >> 16));
        assert(h === ((h << 16) >> 16));
        quads[base + 0] = (x & 0xffff) | (y << 16);
        quads[base + 1] = (z & 0xffff) | (indices << 16);
        quads[base + 2] = (w & 0xffff) | ((h & 0xffff) << 16);
        quads[base + 3] = ((textureIndex & 0xff) << 8) |
            ((ao & 0xff) << 16) |
            ((wave & 0xf) << 24) |
            ((d & 0x3) << 28) |
            ((dir > 0 ? 1 : 0) << 30);
    }
    getFaceDir(block0, block1, dir) {
        const opaque0 = this.opaque[block0];
        const opaque1 = this.opaque[block1];
        if (opaque0 && opaque1)
            return 0;
        if (opaque0)
            return 1;
        if (opaque1)
            return -1;
        const material0 = this.getBlockFaceMaterial(block0, dir);
        const material1 = this.getBlockFaceMaterial(block1, int(dir + 1));
        if (material0 === material1)
            return 0;
        if (material0 === kNoMaterial)
            return -1;
        if (material1 === kNoMaterial)
            return 1;
        return 0;
    }
    getTriangleHint(ao) {
        const a00 = (ao >> 0) & 3;
        const a10 = (ao >> 2) & 3;
        const a11 = (ao >> 4) & 3;
        const a01 = (ao >> 6) & 3;
        if (a00 === a11)
            return (a10 === a01) ? a10 === 3 : true;
        return (a10 === a01) ? false : (a00 + a11 > a10 + a01);
    }
    packAOMask(data, ipos, ineg, dj, dk) {
        const opaque = this.opaque;
        let a00 = 0;
        let a01 = 0;
        let a10 = 0;
        let a11 = 0;
        const b0 = data[ipos + dj];
        const b1 = data[ipos - dj];
        const b2 = data[ipos + dk];
        const b3 = data[ipos - dk];
        // Optimize for the special case of completely unoccluded blocks.
        if (b0 + b1 + b2 + b3 === kEmptyBlock) {
            const d0 = data[ipos - dj - dk];
            const d1 = data[ipos - dj + dk];
            const d2 = data[ipos + dj - dk];
            const d3 = data[ipos + dj + dk];
            if (d0 + d1 + d2 + d3 === kEmptyBlock)
                return 0;
            if (opaque[d0])
                a00++;
            if (opaque[d1])
                a01++;
            if (opaque[d2])
                a10++;
            if (opaque[d3])
                a11++;
            return ((a01 << 6) | (a11 << 4) | (a10 << 2) | a00);
        }
        if (opaque[b0]) {
            a10++;
            a11++;
        }
        if (opaque[b1]) {
            a00++;
            a01++;
        }
        if (opaque[b2]) {
            a01++;
            a11++;
        }
        if (opaque[b3]) {
            a00++;
            a10++;
        }
        if (a00 === 0 && opaque[data[ipos - dj - dk]])
            a00++;
        if (a01 === 0 && opaque[data[ipos - dj + dk]])
            a01++;
        if (a10 === 0 && opaque[data[ipos + dj - dk]])
            a10++;
        if (a11 === 0 && opaque[data[ipos + dj + dk]])
            a11++;
        // Order here matches the order in which we push vertices in addQuad.
        return ((a01 << 6) | (a11 << 4) | (a10 << 2) | a00);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { TerrainMesher };
//# sourceMappingURL=mesher.js.map