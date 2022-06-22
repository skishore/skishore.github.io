import { assert, Vec3 } from './base.js';
import { Geometry } from './renderer.js';
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
    return result;
};
//////////////////////////////////////////////////////////////////////////////
const kCachedGeometryA = Geometry.empty();
const kCachedGeometryB = Geometry.empty();
const kTmpPos = Vec3.create();
let kMaskData = new Int32Array();
let kMaskUnion = new Int32Array();
const kIndexOffsets = {
    A: pack_indices([0, 1, 2, 0, 2, 3]),
    B: pack_indices([1, 2, 3, 0, 1, 3]),
    C: pack_indices([0, 2, 1, 0, 3, 2]),
    D: pack_indices([3, 1, 0, 3, 2, 1]),
};
const kHeightmapSides = [
    [0, 1, 2, 1, 0, 0x82],
    [0, 1, 2, -1, 0, 0x82],
    [2, 0, 1, 0, 1, 0x06],
    [2, 0, 1, 0, -1, 0x06],
];
class TerrainMesher {
    constructor(registry, renderer) {
        this.solid = registry.solid;
        this.opaque = registry.opaque;
        this.getBlockFaceMaterial = registry.getBlockFaceMaterial.bind(registry);
        this.getMaterialData = registry.getMaterialData.bind(registry);
        this.renderer = renderer;
    }
    meshChunk(voxels, solid, water) {
        const solid_geo = solid ? solid.getGeometry() : kCachedGeometryA;
        const water_geo = water ? water.getGeometry() : kCachedGeometryB;
        solid_geo.clear();
        water_geo.clear();
        this.computeChunkGeometry(solid_geo, water_geo, voxels);
        return [
            this.buildMesh(solid_geo, solid, true),
            this.buildMesh(water_geo, water, false),
        ];
    }
    meshFrontier(heightmap, mask, px, pz, sx, sz, scale, old, solid) {
        const geo = old ? old.getGeometry() : kCachedGeometryA;
        if (old)
            geo.dirty = true;
        if (!old)
            geo.clear();
        const { OffsetPos, OffsetMask, Stride } = Geometry;
        const source = Stride * geo.num_quads;
        this.computeFrontierGeometry(geo, heightmap, sx, sz, scale, solid);
        const target = Stride * geo.num_quads;
        for (let offset = source; offset < target; offset += Stride) {
            geo.quads[offset + OffsetPos + 0] += px;
            geo.quads[offset + OffsetPos + 2] += pz;
            geo.quads[offset + OffsetMask] = mask;
        }
        return this.buildMesh(geo, old, solid);
    }
    buildMesh(geo, old, solid) {
        if (geo.num_quads === 0) {
            if (old)
                old.dispose();
            return null;
        }
        else if (old) {
            old.setGeometry(geo);
            return old;
        }
        return this.renderer.addBasicMesh(Geometry.clone(geo), solid);
    }
    computeChunkGeometry(solid_geo, water_geo, voxels) {
        const { data, shape, stride } = voxels;
        for (let d = 0; d < 3; d++) {
            const dir = d * 2;
            const u = (d + 1) % 3;
            const v = (d + 2) % 3;
            const ld = shape[d] - 1, lu = shape[u] - 2, lv = shape[v] - 2;
            const sd = stride[d], su = stride[u], sv = stride[v];
            const base = su + sv;
            Vec3.set(kTmpPos, 0, 0, 0);
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
                        // direction opposite `dir`.
                        //
                        // When we enable ambient occlusion, we shift these masks left by
                        // 8 bits and pack AO values for each vertex into the lower byte.
                        const block0 = data[index];
                        const block1 = data[index + sd];
                        if (block0 === block1)
                            continue;
                        const facing = this.getFaceDir(block0, block1, dir);
                        if (facing === 0)
                            continue;
                        const material = facing > 0
                            ? this.getBlockFaceMaterial(block0, dir)
                            : -this.getBlockFaceMaterial(block1, dir + 1);
                        const ao = facing > 0
                            ? this.packAOMask(data, index + sd, index, su, sv)
                            : this.packAOMask(data, index, index + sd, su, sv);
                        const mask = (material << 8) | ao;
                        kMaskData[n] = mask;
                        kMaskUnion[iu] |= mask;
                        complete_union |= mask;
                    }
                }
                if (complete_union === 0)
                    continue;
                if (id === 0) {
                    for (let i = 0; i < area; i++) {
                        if (kMaskData[i] > 0)
                            kMaskData[i] = 0;
                    }
                }
                else if (id === ld - 1) {
                    for (let i = 0; i < area; i++) {
                        if (kMaskData[i] < 0)
                            kMaskData[i] = 0;
                    }
                }
                n = 0;
                kTmpPos[d] = id;
                for (let iu = 0; iu < lu; iu++) {
                    if (kMaskUnion[iu] === 0) {
                        n += lv;
                        continue;
                    }
                    let h = 1;
                    for (let iv = 0; iv < lv; iv += h, n += h) {
                        const mask = kMaskData[n];
                        if (mask === 0) {
                            h = 1;
                            continue;
                        }
                        for (h = 1; h < lv - iv; h++) {
                            if (mask != kMaskData[n + h])
                                break;
                        }
                        let w = 1, nw = n + lv;
                        OUTER: for (; w < lu - iu; w++, nw += lv) {
                            for (let x = 0; x < h; x++) {
                                if (mask != kMaskData[nw + x])
                                    break OUTER;
                            }
                        }
                        kTmpPos[u] = iu;
                        kTmpPos[v] = iv;
                        const id = Math.abs(mask >> 8);
                        const material = this.getMaterialData(id);
                        const geo = material.color[3] < 1 ? water_geo : solid_geo;
                        this.addQuad(geo, material, d, u, v, w, h, mask, kTmpPos);
                        if (material.texture && material.texture.alphaTest) {
                            const alt = (-1 * (mask & ~0xff)) | (mask & 0xff);
                            this.addQuad(geo, material, d, u, v, w, h, alt, kTmpPos);
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
    computeFrontierGeometry(geo, heightmap, sx, sz, scale, solid) {
        const stride = 2 * sx;
        for (let x = 0; x < sx; x++) {
            for (let z = 0; z < sz; z++) {
                const offset = 2 * (x + z * sx);
                const block = heightmap[offset + 0];
                const height = heightmap[offset + 1];
                if (block === kEmptyBlock || (block & kSentinel))
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
                    let index = offset + 2 * h;
                    for (let i = 0; i < w; i++, index += stride) {
                        const match = heightmap[index + 0] === block &&
                            heightmap[index + 1] === height;
                        if (!match)
                            break OUTER;
                    }
                }
                const d = 1;
                const dir = 2 * d;
                const id = this.getBlockFaceMaterial(block, dir);
                const material = this.getMaterialData(id);
                Vec3.set(kTmpPos, x * scale, height, z * scale);
                const sw = scale * w, sh = scale * h, mask = id << 8;
                this.addQuad(geo, material, 1, 2, 0, sw, sh, mask, kTmpPos);
                for (let wi = 0; wi < w; wi++) {
                    let index = offset + stride * wi;
                    for (let hi = 0; hi < h; hi++, index += 2) {
                        heightmap[index] |= kSentinel;
                    }
                }
                z += (w - 1);
            }
        }
        const limit = 2 * sx * sz;
        for (let i = 0; i < limit; i += 2) {
            heightmap[i] &= ~kSentinel;
        }
        if (!solid)
            return;
        for (let i = 0; i < 4; i++) {
            const sign = i & 0x1 ? -1 : 1;
            const d = i & 0x2 ? 2 : 0;
            const [u, v, ao, li, lj, si, sj] = d === 0
                ? [1, 2, 0x82, sx, sz, 2, stride]
                : [0, 1, 0x06, sz, sx, stride, 2];
            const di = sign > 0 ? si : -si;
            for (let i = 1; i < li; i++) {
                let offset = (i - (sign > 0 ? 1 : 0)) * si;
                for (let j = 0; j < lj; j++, offset += sj) {
                    const block = heightmap[offset + 0];
                    const height = heightmap[offset + 1];
                    if (block === kEmptyBlock)
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
                    // We could use the material at the side of the block with:
                    //  const dir = 2 * d + ((1 - sign) >> 1);
                    //
                    // But doing so muddles grass, etc. textures at a distance.
                    const id = this.getBlockFaceMaterial(block, 2);
                    const mask = ((sign * id) << 8) | ao;
                    const material = this.getMaterialData(id);
                    this.addQuad(geo, material, d, u, v, wi, hi, mask, kTmpPos);
                    const extra = w - 1;
                    offset += extra * sj;
                    j += extra;
                }
            }
        }
    }
    addQuad(geo, material, d, u, v, w, h, mask, pos) {
        const { num_quads } = geo;
        geo.allocateQuads(num_quads + 1);
        const { quads } = geo;
        const Stride = Geometry.Stride;
        const base = Stride * num_quads;
        const offset_pos = base + Geometry.OffsetPos;
        quads[offset_pos + 0] = pos[0];
        quads[offset_pos + 1] = pos[1];
        quads[offset_pos + 2] = pos[2];
        const offset_size = base + Geometry.OffsetSize;
        quads[offset_size + 0] = w;
        quads[offset_size + 1] = h;
        const color = material.color;
        const offset_color = base + Geometry.OffsetColor;
        quads[offset_color + 0] = color[0];
        quads[offset_color + 1] = color[1];
        quads[offset_color + 2] = color[2];
        quads[offset_color + 3] = color[3];
        let textureIndex = material.textureIndex;
        if (textureIndex === 0 && material.texture) {
            textureIndex = this.renderer.atlas.addTexture(material.texture);
            material.textureIndex = textureIndex;
            assert(textureIndex !== 0);
        }
        const triangleHint = this.getTriangleHint(mask);
        const indices = mask > 0
            ? (triangleHint ? kIndexOffsets.C : kIndexOffsets.D)
            : (triangleHint ? kIndexOffsets.A : kIndexOffsets.B);
        quads[base + Geometry.OffsetAOs] = mask & 0xff;
        quads[base + Geometry.OffsetDim] = d;
        quads[base + Geometry.OffsetDir] = Math.sign(mask);
        quads[base + Geometry.OffsetMask] = 0;
        quads[base + Geometry.OffsetWave] = material.liquid ? 1 : 0;
        quads[base + Geometry.OffsetTexture] = material.textureIndex;
        quads[base + Geometry.OffsetIndices] = indices;
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
        const material1 = this.getBlockFaceMaterial(block1, dir + 1);
        if (material0 === material1)
            return 0;
        if (material0 === kNoMaterial)
            return -1;
        if (material1 === kNoMaterial)
            return 1;
        return 0;
    }
    getTriangleHint(mask) {
        const a00 = (mask >> 0) & 3;
        const a10 = (mask >> 2) & 3;
        const a11 = (mask >> 4) & 3;
        const a01 = (mask >> 6) & 3;
        if (a00 === a11)
            return (a10 === a01) ? a10 === 3 : true;
        return (a10 === a01) ? false : (a00 + a11 > a10 + a01);
    }
    packAOMask(data, ipos, ineg, dj, dk) {
        let a00 = 0;
        let a01 = 0;
        let a10 = 0;
        let a11 = 0;
        if (this.solid[data[ipos + dj]]) {
            a10++;
            a11++;
        }
        if (this.solid[data[ipos - dj]]) {
            a00++;
            a01++;
        }
        if (this.solid[data[ipos + dk]]) {
            a01++;
            a11++;
        }
        if (this.solid[data[ipos - dk]]) {
            a00++;
            a10++;
        }
        if (a00 === 0 && this.solid[data[ipos - dj - dk]])
            a00++;
        if (a01 === 0 && this.solid[data[ipos - dj + dk]])
            a01++;
        if (a10 === 0 && this.solid[data[ipos + dj - dk]])
            a10++;
        if (a11 === 0 && this.solid[data[ipos + dj + dk]])
            a11++;
        // Order here matches the order in which we push vertices in addQuad.
        return (a01 << 6) | (a11 << 4) | (a10 << 2) | a00;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { TerrainMesher };
//# sourceMappingURL=mesher.js.map