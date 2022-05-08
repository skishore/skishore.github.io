import { Vec3 } from './base.js';
import { Geometry } from './renderer.js';
const kNoMaterial = 0;
const kEmptyBlock = 0;
;
;
//////////////////////////////////////////////////////////////////////////////
const kCachedGeometryA = Geometry.empty();
const kCachedGeometryB = Geometry.empty();
const kTmpPos = Vec3.create();
let kMaskData = new Int16Array();
const kIndexOffsets = {
    A: [0, 1, 2, 0, 2, 3],
    B: [1, 2, 3, 0, 1, 3],
    C: [0, 2, 1, 0, 3, 2],
    D: [3, 1, 0, 3, 2, 1],
};
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
        this.computeChunkGeometry(solid_geo, water_geo, voxels);
        return [
            this.buildMesh(solid_geo, solid, true),
            this.buildMesh(water_geo, water, false),
        ];
    }
    buildMesh(geo, old, solid) {
        if (geo.num_indices === 0) {
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
        solid_geo.clear();
        water_geo.clear();
        for (let d = 0; d < 3; d++) {
            const dir = d * 2;
            const u = (d + 1) % 3;
            const v = (d + 2) % 3;
            const ld = shape[d] - 2, lu = shape[u] - 2, lv = shape[v] - 2;
            const sd = stride[d], su = stride[u], sv = stride[v];
            const base = su + sv;
            Vec3.set(kTmpPos, 0, 0, 0);
            const area = lu * lv;
            if (kMaskData.length < area) {
                kMaskData = new Int16Array(area);
            }
            for (let id = 0; id < ld; id++) {
                let n = 0;
                for (let iu = 0; iu < lu; iu++) {
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
                        const mask = facing > 0
                            ? this.getBlockFaceMaterial(block0, dir)
                            : -this.getBlockFaceMaterial(block1, dir + 1);
                        const ao = facing > 0
                            ? this.packAOMask(data, index + sd, index, su, sv)
                            : this.packAOMask(data, index, index + sd, su, sv);
                        kMaskData[n] = (mask << 8) | ao;
                    }
                }
                n = 0;
                kTmpPos[d] = id;
                for (let iu = 0; iu < lu; iu++) {
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
    addQuad(geo, material, d, u, v, w, h, mask, pos) {
        const { num_indices, num_vertices } = geo;
        geo.allocateVertices(num_vertices + 4);
        geo.allocateIndices(num_indices + 6);
        const dir = Math.sign(mask);
        const { indices, vertices } = geo;
        const Stride = Geometry.Stride;
        const base = Stride * num_vertices;
        const positions_offset = base + Geometry.PositionsOffset;
        const normals_offset = base + Geometry.NormalsOffset;
        const colors_offset = base + Geometry.ColorsOffset;
        const uvws_offset = base + Geometry.UVWsOffset;
        for (let i = 0; i < 3; i++) {
            const p = pos[i];
            vertices[positions_offset + Stride * 0 + i] = p;
            vertices[positions_offset + Stride * 1 + i] = p;
            vertices[positions_offset + Stride * 2 + i] = p;
            vertices[positions_offset + Stride * 3 + i] = p;
            const x = i === d ? dir : 0;
            vertices[normals_offset + Stride * 0 + i] = x;
            vertices[normals_offset + Stride * 1 + i] = x;
            vertices[normals_offset + Stride * 2 + i] = x;
            vertices[normals_offset + Stride * 3 + i] = x;
        }
        vertices[positions_offset + Stride * 1 + u] += w;
        vertices[positions_offset + Stride * 2 + u] += w;
        vertices[positions_offset + Stride * 2 + v] += h;
        vertices[positions_offset + Stride * 3 + v] += h;
        const triangleHint = this.getTriangleHint(mask);
        const offsets = mask > 0
            ? (triangleHint ? kIndexOffsets.C : kIndexOffsets.D)
            : (triangleHint ? kIndexOffsets.A : kIndexOffsets.B);
        for (let i = 0; i < 6; i++) {
            indices[num_indices + i] = num_vertices + offsets[i];
        }
        let textureIndex = material.textureIndex;
        if (textureIndex === 0 && material.texture) {
            textureIndex = this.renderer.atlas.addImage(material.texture);
            material.textureIndex = textureIndex;
        }
        const color = material.color;
        for (let i = 0; i < 4; i++) {
            const ao = 1 - 0.3 * (mask >> (2 * i) & 3);
            vertices[colors_offset + Stride * i + 0] = color[0] * ao;
            vertices[colors_offset + Stride * i + 1] = color[1] * ao;
            vertices[colors_offset + Stride * i + 2] = color[2] * ao;
            vertices[colors_offset + Stride * i + 3] = color[3];
        }
        for (let i = 0; i < 4; i++) {
            vertices[uvws_offset + Stride * i + 0] = 0;
            vertices[uvws_offset + Stride * i + 1] = 0;
            vertices[uvws_offset + Stride * i + 2] = textureIndex;
        }
        if (d === 2) {
            const wd = -dir * w;
            vertices[uvws_offset + Stride * 0 + 1] = h;
            vertices[uvws_offset + Stride * 1 + 1] = h;
            vertices[uvws_offset + Stride * 1 + 0] = wd;
            vertices[uvws_offset + Stride * 2 + 0] = wd;
        }
        else {
            const hd = dir * h;
            vertices[uvws_offset + Stride * 0 + 1] = w;
            vertices[uvws_offset + Stride * 3 + 1] = w;
            vertices[uvws_offset + Stride * 2 + 0] = hd;
            vertices[uvws_offset + Stride * 3 + 0] = hd;
        }
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