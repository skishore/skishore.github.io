import { assert, int, nonnull } from './base.js';
import { Mat4, Vec3 } from './base.js';
;
const kTmpDelta = Vec3.create();
const kTmpPlane = Vec3.create();
class Camera {
    constructor(width, height) {
        this.heading = 0; // In radians: [0, 2π)
        this.pitch = 0; // In radians: (-π/2, π/2)
        this.zoom = 0;
        this.safe_zoom = 0;
        this.direction = Vec3.from(0, 0, 1);
        this.position = Vec3.create();
        this.target = Vec3.create();
        this.last_dx = 0;
        this.last_dy = 0;
        this.transform_for = Mat4.create();
        this.transform = Mat4.create();
        this.projection = Mat4.create();
        this.view = Mat4.create();
        this.aspect = height ? width / height : 1;
        this.minZ = 0;
        this.setMinZ(0.1);
        this.planes = Array(4).fill(null);
        for (let i = 0; i < 4; i++)
            this.planes[i] = { x: 0, y: 0, z: 0, index: 0 };
    }
    applyInputs(dx, dy, dscroll) {
        // Smooth out large mouse-move inputs.
        const jerkx = Math.abs(dx) > 400 && Math.abs(dx / (this.last_dx || 1)) > 4;
        const jerky = Math.abs(dy) > 400 && Math.abs(dy / (this.last_dy || 1)) > 4;
        if (jerkx || jerky) {
            const saved_x = this.last_dx;
            const saved_y = this.last_dy;
            this.last_dx = (dx + this.last_dx) / 2;
            this.last_dy = (dy + this.last_dy) / 2;
            dx = saved_x;
            dy = saved_y;
        }
        else {
            this.last_dx = dx;
            this.last_dy = dy;
        }
        let pitch = this.pitch;
        let heading = this.heading;
        // Overwatch uses the same constant values to do this conversion.
        const conversion = 0.066 * Math.PI / 180;
        dx = dx * conversion;
        dy = dy * conversion;
        heading += dx;
        const T = 2 * Math.PI;
        while (this.heading < 0)
            this.heading += T;
        while (this.heading > T)
            this.heading -= T;
        const U = Math.PI / 2 - 0.01;
        this.pitch = Math.max(-U, Math.min(U, this.pitch + dy));
        this.heading = heading;
        const dir = this.direction;
        Vec3.set(dir, 0, 0, 1);
        Vec3.rotateX(dir, dir, this.pitch);
        Vec3.rotateY(dir, dir, this.heading);
        // Scrolling is trivial to apply: add and clamp.
        if (dscroll === 0)
            return;
        this.zoom = Math.max(0, Math.min(15, this.zoom + Math.sign(dscroll)));
    }
    getCullingPlanes() {
        const { heading, pitch, planes, projection } = this;
        for (let i = 0; i < 4; i++) {
            const a = i < 2 ? (1 - ((i & 1) << 1)) * projection[0] : 0;
            const b = i > 1 ? (1 - ((i & 1) << 1)) * projection[5] : 0;
            Vec3.set(kTmpPlane, a, b, 1);
            Vec3.rotateX(kTmpPlane, kTmpPlane, pitch);
            Vec3.rotateY(kTmpPlane, kTmpPlane, heading);
            const [x, y, z] = kTmpPlane;
            const plane = planes[i];
            plane.x = x;
            plane.y = y;
            plane.z = z;
            plane.index = int((x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0));
        }
        return planes;
    }
    getTransform() {
        Mat4.view(this.view, this.position, this.direction);
        Mat4.multiply(this.transform, this.projection, this.view);
        return this.transform;
    }
    getTransformFor(offset) {
        Vec3.sub(kTmpDelta, this.position, offset);
        Mat4.view(this.view, kTmpDelta, this.direction);
        Mat4.multiply(this.transform_for, this.projection, this.view);
        return this.transform_for;
    }
    setMinZ(minZ) {
        if (minZ === this.minZ)
            return;
        Mat4.perspective(this.projection, 3 * Math.PI / 8, this.aspect, minZ);
        this.minZ = minZ;
    }
    setSafeZoomDistance(bump, zoom) {
        zoom = Math.max(Math.min(zoom, this.zoom), 0);
        Vec3.scaleAndAdd(this.position, this.target, this.direction, -zoom);
        this.position[1] += bump;
        this.safe_zoom = zoom;
    }
    setTarget(x, y, z) {
        Vec3.set(this.target, x, y, z);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const ARRAY_BUFFER = WebGL2RenderingContext.ARRAY_BUFFER;
const TEXTURE_2D_ARRAY = WebGL2RenderingContext.TEXTURE_2D_ARRAY;
const TEXTURE_3D = WebGL2RenderingContext.TEXTURE_3D;
;
;
class Shader {
    constructor(gl, source) {
        this.gl = gl;
        const parts = source.split('#split');
        const vertex = this.compile(parts[0], gl.VERTEX_SHADER);
        const fragment = this.compile(parts[1], gl.FRAGMENT_SHADER);
        this.program = this.link(vertex, fragment);
        this.uniforms = new Map();
        this.attributes = new Map();
        const program = this.program;
        const uniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniforms; i++) {
            const info = gl.getActiveUniform(program, i);
            if (!info || this.builtin(info.name))
                continue;
            const location = nonnull(gl.getUniformLocation(program, info.name));
            this.uniforms.set(info.name, { info, location });
        }
        const attributes = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < attributes; i++) {
            const info = gl.getActiveAttrib(program, i);
            if (!info || this.builtin(info.name))
                continue;
            const location = gl.getAttribLocation(program, info.name);
            this.attributes.set(info.name, { info, location });
            assert(location >= 0);
        }
    }
    bind() {
        this.gl.useProgram(this.program);
    }
    getAttribLocation(name) {
        const attribute = this.attributes.get(name);
        return attribute ? attribute.location : null;
    }
    getUniformLocation(name) {
        const uniform = this.uniforms.get(name);
        return uniform ? uniform.location : null;
    }
    builtin(name) {
        return name.startsWith('gl_') || name.startsWith('webgl_');
    }
    compile(source, type) {
        const gl = this.gl;
        const result = nonnull(gl.createShader(type));
        gl.shaderSource(result, `#version 300 es
                             precision highp float;
                             precision highp sampler2DArray;
                             precision highp sampler3D;
                             ${source}`);
        gl.compileShader(result);
        if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(result);
            gl.deleteShader(result);
            throw new Error(`Unable to compile shader: ${info}`);
        }
        return result;
    }
    link(vertex, fragment) {
        const gl = this.gl;
        const result = nonnull(gl.createProgram());
        gl.attachShader(result, vertex);
        gl.attachShader(result, fragment);
        gl.linkProgram(result);
        if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(result);
            gl.deleteProgram(result);
            throw new Error(`Unable to link program: ${info}`);
        }
        return result;
    }
}
;
;
class TextureAtlas {
    constructor(gl) {
        this.gl = gl;
        this.texture = nonnull(gl.createTexture());
        this.canvas = null;
        this.images = new Map();
        this.nextResult = 0;
        this.data = new Uint8Array();
        this.sparkle_data = new Uint8Array();
        this.sparkle_last = new Uint8Array();
        this.sparkle_indices = [];
        this.bind();
        const id = TEXTURE_2D_ARRAY;
        gl.texParameteri(id, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(id, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    }
    addTexture(texture) {
        const index = int(this.nextResult++);
        const image = this.image(texture.url);
        if (image.complete) {
            this.loaded(texture, index, image);
        }
        else {
            image.addEventListener('load', () => this.loaded(texture, index, image));
        }
        return index;
    }
    bind() {
        const { gl, texture } = this;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(TEXTURE_2D_ARRAY, this.texture);
    }
    sparkle() {
        if (!this.canvas)
            return;
        if (this.sparkle_indices.length === 0)
            return;
        const size = this.canvas.canvas.width;
        const length = size * size * 4;
        if (this.sparkle_data.length === 0) {
            this.sparkle_data = new Uint8Array(length);
            this.sparkle_last = new Uint8Array(length / 4);
        }
        const { gl, sparkle_data, sparkle_last } = this;
        assert(sparkle_data.length === length);
        const limit = sparkle_last.length;
        for (let i = 0; i < limit; i++) {
            const value = sparkle_last[i];
            if (value > 0) {
                sparkle_last[i] = Math.max(value - 4, 0);
            }
            else if (Math.random() < 0.004) {
                sparkle_last[i] = 128;
            }
        }
        this.bind();
        for (const index of this.sparkle_indices) {
            const offset = length * index;
            const limit = offset + length;
            if (this.data.length < limit)
                continue;
            sparkle_data.set(this.data.subarray(offset, limit));
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    const index = (i * size + j);
                    const value = sparkle_last[index];
                    if (value === 0)
                        continue;
                    const k = 4 * index;
                    sparkle_data[k + 0] = Math.min(sparkle_data[k + 0] + value, 255);
                    sparkle_data[k + 1] = Math.min(sparkle_data[k + 1] + value, 255);
                    sparkle_data[k + 2] = Math.min(sparkle_data[k + 2] + value, 255);
                }
            }
            gl.texSubImage3D(TEXTURE_2D_ARRAY, 0, 0, 0, index, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, sparkle_data, 0);
        }
    }
    image(url) {
        const existing = this.images.get(url);
        if (existing)
            return existing;
        const image = new Image();
        this.images.set(url, image);
        image.src = url;
        return image;
    }
    loaded(texture, index, image) {
        assert(image.complete);
        const { x, y, w, h } = texture;
        if (this.canvas === null) {
            const size = Math.floor(image.width / texture.w);
            const element = document.createElement('canvas');
            element.width = element.height = size;
            const canvas = element.getContext('2d', { willReadFrequently: true });
            this.canvas = nonnull(canvas);
        }
        const canvas = this.canvas;
        const size = canvas.canvas.width;
        if (image.width !== size * w || image.height !== size * h) {
            throw new Error(`${image.src} should be ${size * w} x ${size * h} ` +
                `(${w} x ${h} cells, each ${size} x ${size}) ` +
                `but it was ${image.width} x ${image.height} instead.`);
        }
        canvas.clearRect(0, 0, size, size);
        canvas.drawImage(image, size * x, size * y, size, size, 0, 0, size, size);
        const length = size * size * 4;
        const offset = length * index;
        const pixels = canvas.getImageData(0, 0, size, size).data;
        assert(pixels.length === length);
        const color = texture.color;
        for (let i = 0; i < length; i++) {
            pixels[i] = (pixels[i] * color[i & 3]) & 0xff;
        }
        const capacity = this.data ? this.data.length : 0;
        const required = length + offset;
        const allocate = capacity < required;
        if (allocate) {
            const data = new Uint8Array(Math.max(2 * capacity, required));
            for (let i = 0; i < this.data.length; i++)
                data[i] = this.data[i];
            this.data = data;
        }
        // When we create mip-maps, we'll read the RGB channels of transparent
        // pixels, which are usually set to all 0s. Doing so averages in black
        // values for these pixels. Instead, compute a mean color and use that.
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < length; i += 4) {
            if (pixels[i + 3] === 0)
                continue;
            r += pixels[i + 0];
            g += pixels[i + 1];
            b += pixels[i + 2];
            n++;
        }
        if (n > 0) {
            r = (r / n) & 0xff;
            g = (g / n) & 0xff;
            b = (b / n) & 0xff;
        }
        const data = this.data;
        for (let i = 0; i < length; i += 4) {
            const transparent = pixels[i + 3] === 0;
            data[i + offset + 0] = transparent ? r : pixels[i + 0];
            data[i + offset + 1] = transparent ? g : pixels[i + 1];
            data[i + offset + 2] = transparent ? b : pixels[i + 2];
            data[i + offset + 3] = pixels[i + 3];
        }
        this.bind();
        const gl = this.gl;
        if (allocate) {
            assert(this.data.length % length === 0);
            const depth = this.data.length / length;
            gl.texImage3D(TEXTURE_2D_ARRAY, 0, gl.RGBA, size, size, depth, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.data);
        }
        else {
            gl.texSubImage3D(TEXTURE_2D_ARRAY, 0, 0, 0, index, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.data, offset);
            for (const sindex of this.sparkle_indices) {
                const soffset = length * sindex;
                assert(soffset + length <= this.data.length);
                gl.texSubImage3D(TEXTURE_2D_ARRAY, 0, 0, 0, sindex, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.data, soffset);
            }
        }
        gl.generateMipmap(TEXTURE_2D_ARRAY);
        if (texture.sparkle)
            this.sparkle_indices.push(index);
    }
}
;
;
class SpriteAtlas {
    constructor(gl) {
        this.gl = gl;
        this.canvas = null;
        this.sprites = new Map();
    }
    addSprite(sprite) {
        const url = sprite.url;
        const existing = this.sprites.get(url);
        if (existing)
            return existing;
        const created = nonnull(this.gl.createTexture());
        this.sprites.set(url, created);
        const image = new Image();
        image.src = url;
        image.addEventListener('load', () => this.loaded(sprite, image, created));
        return created;
    }
    loaded(sprite, image, texture) {
        assert(image.complete);
        const { x, y } = sprite;
        const w = image.width;
        const h = image.height;
        if (w % x !== 0 || h % y !== 0) {
            throw new Error(`(${w} x ${h}) image cannot fit (${x} x ${y}) frames.`);
        }
        const cols = w / x, rows = h / y;
        const frames = cols * rows;
        if (this.canvas === null) {
            const element = document.createElement('canvas');
            const canvas = element.getContext('2d', { willReadFrequently: true });
            this.canvas = nonnull(canvas);
        }
        const canvas = this.canvas;
        canvas.canvas.width = x;
        canvas.canvas.height = y * frames;
        const length = w * h * 4;
        canvas.clearRect(0, 0, x, y * frames);
        for (let i = 0; i < frames; i++) {
            const sx = x * (i % cols);
            const sy = y * Math.floor(i / cols);
            canvas.drawImage(image, sx, sy, x, y, 0, y * i, x, y);
        }
        const pixels = canvas.getImageData(0, 0, x, y * frames).data;
        assert(pixels.length === length);
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(TEXTURE_2D_ARRAY, texture);
        gl.texImage3D(TEXTURE_2D_ARRAY, 0, gl.RGBA, x, y, frames, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.generateMipmap(TEXTURE_2D_ARRAY);
        const id = TEXTURE_2D_ARRAY;
        gl.texParameteri(id, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(id, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
        gl.texParameteri(id, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(id, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
class Geometry {
    constructor(quads, num_quads) {
        this.quads = quads;
        this.num_quads = num_quads;
        this.lower_bound = Vec3.create();
        this.upper_bound = Vec3.create();
        this.bounds = new Float64Array(24);
        this.dirty = true;
    }
    clear() {
        this.num_quads = 0;
        this.dirty = true;
    }
    allocateQuads(n) {
        this.num_quads = n;
        const length = this.quads.length;
        const needed = Geometry.StrideInInt32 * n;
        if (length >= needed)
            return;
        const expanded = new Int32Array(Math.max(length * 2, needed));
        expanded.set(this.quads);
        this.quads = expanded;
    }
    getBounds() {
        if (this.dirty)
            this.computeBounds();
        return this.bounds;
    }
    computeBounds() {
        if (!this.dirty)
            return this.bounds;
        const { bounds, lower_bound, upper_bound } = this;
        Vec3.set(lower_bound, Infinity, Infinity, Infinity);
        Vec3.set(upper_bound, -Infinity, -Infinity, -Infinity);
        const quads = this.quads;
        const stride = Geometry.StrideInInt32;
        assert(quads.length % stride === 0);
        for (let i = 0; i < quads.length; i += stride) {
            const xy = quads[i + 0];
            const zi = quads[i + 1];
            const lx = (xy << 16) >> 16;
            const ly = xy >> 16;
            const lz = (zi << 16) >> 16;
            const wh = quads[i + 2];
            const w = (wh << 16) >> 16;
            const h = wh >> 16;
            const extra = quads[i + 3];
            const dim = (extra >> 28) & 0x3;
            const mx = lx + (dim === 2 ? w : dim === 1 ? h : 0);
            const my = ly + (dim === 0 ? w : dim === 2 ? h : 0);
            const mz = lz + (dim === 1 ? w : dim === 0 ? h : 0);
            if (lower_bound[0] > lx)
                lower_bound[0] = lx;
            if (lower_bound[1] > ly)
                lower_bound[1] = ly;
            if (lower_bound[2] > lz)
                lower_bound[2] = lz;
            if (upper_bound[0] < mx)
                upper_bound[0] = mx;
            if (upper_bound[1] < my)
                upper_bound[1] = my;
            if (upper_bound[2] < mz)
                upper_bound[2] = mz;
        }
        lower_bound[1] -= 1; // because of the vertical "wave" shift
        for (let i = 0; i < 8; i++) {
            const offset = 3 * i;
            for (let j = 0; j < 3; j++) {
                bounds[offset + j] = (i & (1 << j)) ? upper_bound[j] : lower_bound[j];
            }
        }
        this.dirty = false;
    }
    static clone(geo) {
        const num_quads = geo.num_quads;
        const quads = geo.quads.slice(0, num_quads * Geometry.StrideInInt32);
        return new Geometry(quads, num_quads);
    }
    static clone_raw(geo) {
        const num_quads = geo.num_quads;
        const quads = geo.quads.slice(0, num_quads * Geometry.StrideInInt32);
        return new Geometry(quads, num_quads);
    }
    static empty() {
        return new Geometry(new Int32Array(), 0);
    }
}
// struct Quad {
//   // int 0
//   int16_t x;
//   int16_t y;
//
//   // int 1
//   int16_t z;
//   int16_t indices; // 6 x 2-bit ints
//
//   // int 2
//   int16_t w;
//   int16_t h;
//
//   // int 3
//   uint8_t mask:    8; // only need 6 bits
//   uint8_t texture: 8; // could use more bits
//   uint8_t ao:      8; // 4 x 2-bit AO values
//   uint8_t wave:    4; // 4 x 1-bit wave flags
//   uint8_t dim:     2;
//   uint8_t dir:     1;
//   uint8_t lit:     1;
// };
Geometry.StrideInInt32 = 4;
Geometry.StrideInBytes = 16;
;
//////////////////////////////////////////////////////////////////////////////
class Buffer {
    constructor(gl, dynamic, length, freeList) {
        this.usage = 0;
        const buffer = nonnull(gl.createBuffer());
        const mode = dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
        gl.bindBuffer(ARRAY_BUFFER, buffer);
        gl.bufferData(ARRAY_BUFFER, length, mode);
        this.freeList = freeList;
        this.buffer = buffer;
        this.length = length;
    }
}
;
class BufferAllocator {
    constructor(gl) {
        this.bytes_total = 0;
        this.bytes_alloc = 0;
        this.bytes_usage = 0;
        this.gl = gl;
        this.freeListsStatics = new Array(32).fill(null).map(() => []);
        this.freeListsDynamic = new Array(32).fill(null).map(() => []);
    }
    alloc(data, dynamic) {
        const gl = this.gl;
        const bytes = int(4 * data.length);
        const sizeClass = this.sizeClass(bytes);
        const freeLists = dynamic ? this.freeListsDynamic : this.freeListsStatics;
        const freeList = freeLists[sizeClass];
        const length = int(1 << sizeClass);
        let buffer = freeList.pop();
        if (buffer) {
            gl.bindBuffer(ARRAY_BUFFER, buffer.buffer);
        }
        else {
            buffer = new Buffer(gl, dynamic, length, freeList);
            this.bytes_total += length;
        }
        buffer.usage = bytes;
        gl.bufferSubData(ARRAY_BUFFER, 0, data, 0, data.length);
        this.bytes_alloc += buffer.length;
        this.bytes_usage += buffer.usage;
        return buffer;
    }
    free(buffer) {
        buffer.freeList.push(buffer);
        this.bytes_alloc -= buffer.length;
        this.bytes_usage -= buffer.usage;
    }
    stats() {
        const { bytes_usage, bytes_alloc, bytes_total } = this;
        const usage = this.formatSize(bytes_usage);
        const alloc = this.formatSize(bytes_alloc);
        const total = this.formatSize(bytes_total);
        return `Buffer: ${usage} / ${alloc} / ${total}Mb`;
    }
    formatSize(bytes) {
        return `${(bytes / (1024 * 1024)).toFixed(2)}`;
    }
    sizeClass(bytes) {
        const result = int(32 - Math.clz32(bytes - 1));
        assert((1 << result) >= bytes);
        return result;
    }
}
;
class LightTexture {
    constructor(data, allocator) {
        this.allocator = allocator;
        this.texture = this.allocator.alloc(data);
    }
    dispose() {
        this.allocator.free(this.texture);
    }
}
;
class TextureAllocator {
    constructor(gl) {
        this.bytes_alloc = 0;
        this.gl = gl;
        this.freeList = [];
    }
    alloc(data) {
        const h = 256, w = 18;
        assert(data.length === h * w * w);
        const gl = this.gl;
        const id = gl.TEXTURE_3D;
        const format = gl.LUMINANCE;
        const type = gl.UNSIGNED_BYTE;
        gl.activeTexture(gl.TEXTURE1);
        if (this.freeList.length > 0) {
            const texture = this.freeList.pop();
            gl.bindTexture(id, texture);
            gl.texSubImage3D(id, 0, 0, 0, 0, h, w, w, format, type, data, 0);
            return texture;
        }
        else {
            const texture = nonnull(gl.createTexture());
            gl.bindTexture(id, texture);
            gl.texImage3D(id, 0, format, h, w, w, 0, format, type, data);
            gl.texParameteri(id, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(id, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(id, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
            gl.texParameteri(id, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(id, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.bytes_alloc += data.length;
            return texture;
        }
    }
    free(texture) {
        this.freeList.push(texture);
    }
    stats() {
        return `Lights: ${(this.bytes_alloc / (1024 * 1024)).toFixed(2)}Mb`;
    }
}
;
;
class Mesh {
    constructor(manager, meshes) {
        this.index = -1;
        this.gl = manager.gl;
        this.shader = manager.shader;
        this.meshes = meshes;
        this.position = Vec3.create();
        this.addToMeshes();
    }
    cull(bounds, camera, planes) {
        const position = this.position;
        const camera_position = camera.position;
        const dx = position[0] - camera_position[0];
        const dy = position[1] - camera_position[1];
        const dz = position[2] - camera_position[2];
        for (const plane of planes) {
            const { x, y, z, index } = plane;
            const offset = 3 * index;
            const bx = bounds[offset + 0];
            const by = bounds[offset + 1];
            const bz = bounds[offset + 2];
            const value = (bx + dx) * x + (by + dy) * y + (bz + dz) * z;
            if (value < 0)
                return true;
        }
        return false;
    }
    dispose() {
        if (this.shown())
            this.removeFromMeshes();
    }
    setPosition(x, y, z) {
        Vec3.set(this.position, x, y, z);
    }
    addToMeshes() {
        assert(this.index === -1);
        this.index = int(this.meshes.length);
        this.meshes.push(this);
    }
    removeFromMeshes() {
        const meshes = this.meshes;
        assert(this === meshes[this.index]);
        const last = meshes.length - 1;
        if (this.index !== last) {
            const swap = meshes[last];
            meshes[this.index] = swap;
            swap.index = this.index;
        }
        meshes.pop();
        this.index = -1;
    }
    shown() {
        return this.index >= 0;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kVoxelShader = `
  uniform ivec2 u_mask;
  uniform float u_move;
  uniform float u_wave;
  uniform mat4 u_transform;

  in ivec3 a_pos;
  in ivec2 a_size;
  in uint  a_indices;
  in uint  a_ao;
  in uint  a_mask;
  in uint  a_texture;
  // 4-bit wave; 2-bit dim; 1-bit dir
  in int   a_wddl;

  out vec3 v_pos;
  out vec3 v_uvw;
  out float v_ao;
  out float v_move;
  flat out int v_dim;

  int unpackI2(uint packed, int index) {
    return (int(packed) >> (2 * index)) & 3;
  }

  void main() {
    int instance = gl_VertexID + 3 * (gl_InstanceID & 1);
    int index = unpackI2(a_indices, instance);

    v_ao = 1.0 - 0.3 * float(unpackI2(a_ao, index));

    int dim = (a_wddl >> 4) & 0x3;
    float dir = ((a_wddl & 64) != 0) ? 1.0 : -1.0;
    float w = float(((index + 1) & 3) >> 1);
    float h = float(((index + 0) & 3) >> 1);

    v_uvw = vec3(0.0, 0.0, float(a_texture));
    const float kTextureBuffer = 0.01;
    if (dim == 2) {
      v_uvw[0] = (float(a_size[0]) - kTextureBuffer) * w * -dir;
      v_uvw[1] = (float(a_size[1]) - kTextureBuffer) * (1.0 - h);
    } else {
      v_uvw[0] = (float(a_size[1]) - kTextureBuffer) * h * dir;
      v_uvw[1] = (float(a_size[0]) - kTextureBuffer) * (1.0 - w);
    }

    float wave = float((a_wddl >> index) & 0x1);
    v_move = wave * u_move;

    vec3 pos = vec3(float(a_pos[0]), float(a_pos[1]), float(a_pos[2]));
    pos[(dim + 1) % 3] += w * float(a_size[0]);
    pos[(dim + 2) % 3] += h * float(a_size[1]);
    pos[1] -= wave * u_wave;
    gl_Position = u_transform * vec4(pos, 1.0);

    v_dim = dim;
    v_pos = pos;
    v_pos[dim] += 0.5 * dir;

    int mask = int(a_mask);
    int mask_index = mask >> 5;
    int mask_value = 1 << (mask & 31);
    bool hide = (u_mask[mask_index] & mask_value) != 0;
    if (hide) gl_Position[3] = 0.0;
  }
#split
  uniform float u_alphaTest;
  uniform vec3 u_fogColor;
  uniform float u_fogDepth;
  uniform int u_hasLight;
  uniform sampler2DArray u_texture;
  uniform sampler3D u_light;

  in vec3 v_pos;
  in vec3 v_uvw;
  in float v_ao;
  in float v_move;
  flat in int v_dim;

  out vec4 o_color;

  float getLightTexel(ivec3 pos) {
    if (pos[0] < 0) return 0.0;
    if (pos[0] >= 0xff) return 15.0;
    return round(256.0 * texelFetch(u_light, pos, 0)[0]);
  }

  float getLightLevel() {
    if (u_hasLight != 1) return 15.0;

    int u = (v_dim + 1) % 3;
    int v = (v_dim + 2) % 3;
    int bu = u == 2 ? u : 1 - u;
    int bv = v == 2 ? v : 1 - v;
    vec3 pos = v_pos;
    pos[u] -= 0.5;
    pos[v] -= 0.5;

    ivec3 base = ivec3(clamp(int(floor(pos[1])) + 0, 0, 0xff),
                       clamp(int(floor(pos[0])) + 1, 0, 0x11),
                       clamp(int(floor(pos[2])) + 1, 0, 0x11));
    ivec3 b0 = base, b1 = base, b2 = base, b3 = base;
    b1[bu] += 1; b2[bv] += 1; b3[bu] += 1; b3[bv] += 1;

    float c0 = getLightTexel(b0);
    float c1 = getLightTexel(b1);
    float c2 = getLightTexel(b2);
    float c3 = getLightTexel(b3);

    for (int i = 0; i < 2; i++) {
      c0 = max(c0, max(c1 - 1.0, c2 - 1.0));
      c1 = max(c1, max(c0 - 1.0, c3 - 1.0));
      c3 = max(c3, max(c2 - 1.0, c1 - 1.0));
      c2 = max(c2, max(c0 - 1.0, c3 - 1.0));
    }

    float du = pos[u] - floor(pos[u]);
    float dv = pos[v] - floor(pos[v]);
    float fu = 1.0 - du;
    float fv = 1.0 - dv;

    return fu * (fv * c0 + dv * c2) + du * (fv * c1 + dv * c3);

    // The simpler "hard-lighting" implementation:
    //ivec3 texel = ivec3(clamp(int(v_pos[1]), 0, 0xff),
    //                    clamp(int(v_pos[0]), 0, 0xf) + 1,
    //                    clamp(int(v_pos[2]), 0, 0xf) + 1);
    //return 256.0 * texelFetch(u_light, texel, 0)[0];
  }

  void main() {
    float level = getLightLevel();
    float light = pow(0.8, 15.0 - level);

    float depth = u_fogDepth * gl_FragCoord.w;
    float fog = clamp(exp2(-depth * depth), 0.0, 1.0);

    vec3 index = v_uvw + vec3(v_move, v_move, 0.0);
    vec4 color = vec4(vec3(light * v_ao), 1.0) * texture(u_texture, index);
    o_color = mix(color, vec4(u_fogColor, color[3]), fog);
    if (o_color[3] < 0.5 * u_alphaTest) discard;
  }
`;
class VoxelShader extends Shader {
    constructor(gl) {
        super(gl, kVoxelShader);
        this.u_mask = this.getUniformLocation('u_mask');
        this.u_move = this.getUniformLocation('u_move');
        this.u_wave = this.getUniformLocation('u_wave');
        this.u_transform = this.getUniformLocation('u_transform');
        this.u_alphaTest = this.getUniformLocation('u_alphaTest');
        this.u_fogColor = this.getUniformLocation('u_fogColor');
        this.u_fogDepth = this.getUniformLocation('u_fogDepth');
        this.u_hasLight = this.getUniformLocation('u_hasLight');
        this.u_light = this.getUniformLocation('u_light');
        this.a_pos = this.getAttribLocation('a_pos');
        this.a_size = this.getAttribLocation('a_size');
        this.a_ao = this.getAttribLocation('a_ao');
        this.a_indices = this.getAttribLocation('a_indices');
        this.a_mask = this.getAttribLocation('a_mask');
        this.a_texture = this.getAttribLocation('a_texture');
        this.a_wddl = this.getAttribLocation('a_wddl');
    }
}
;
class VoxelMesh extends Mesh {
    constructor(manager, meshes, geo) {
        super(manager, meshes);
        this.vao = null;
        this.quads = null;
        this.light = null;
        this.manager = manager;
        this.geo = geo;
        this.mask = new Int32Array(2);
    }
    dispose() {
        super.dispose();
        this.destroyBuffers();
        this.mask[0] = 0;
        this.mask[1] = 0;
    }
    draw(camera, planes) {
        const bounds = this.geo.getBounds();
        if (this.cull(bounds, camera, planes))
            return false;
        this.prepareBuffers();
        const transform = camera.getTransformFor(this.position);
        const gl = this.gl;
        const n = this.geo.num_quads;
        gl.bindVertexArray(this.vao);
        if (this.light) {
            gl.uniform1i(this.manager.shader.u_hasLight, 1);
            gl.bindTexture(TEXTURE_3D, this.light.texture);
        }
        else {
            gl.uniform1i(this.manager.shader.u_hasLight, 0);
        }
        gl.uniform2iv(this.shader.u_mask, this.mask);
        gl.uniformMatrix4fv(this.shader.u_transform, false, transform);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, n * 2);
        return true;
    }
    getGeometry() {
        return this.geo;
    }
    setGeometry(geo) {
        this.destroyBuffers();
        this.geo = geo;
    }
    setLight(light) {
        this.light = light;
    }
    setPosition(x, y, z) {
        Vec3.set(this.position, x, y, z);
    }
    show(m0, m1, shown) {
        this.mask[0] = m0;
        this.mask[1] = m1;
        if (shown === this.shown())
            return;
        shown ? this.addToMeshes() : this.removeFromMeshes();
        assert(shown === this.shown());
    }
    destroyBuffers() {
        const { gl, light, quads } = this;
        gl.deleteVertexArray(this.vao);
        if (quads)
            this.manager.allocator.free(quads);
        this.vao = null;
        this.quads = null;
        this.light = null;
    }
    prepareBuffers() {
        if (this.vao)
            return;
        const { gl, shader } = this;
        this.vao = nonnull(gl.createVertexArray());
        gl.bindVertexArray(this.vao);
        this.prepareQuads(this.geo.quads);
        const { BYTE, SHORT, UNSIGNED_BYTE: UBYTE, UNSIGNED_SHORT: USHORT } = gl;
        this.prepareAttribute(shader.a_pos, SHORT, 3, 0);
        this.prepareAttribute(shader.a_indices, USHORT, 1, 6);
        this.prepareAttribute(shader.a_size, SHORT, 2, 8);
        this.prepareAttribute(shader.a_mask, UBYTE, 1, 12);
        this.prepareAttribute(shader.a_texture, UBYTE, 1, 13);
        this.prepareAttribute(shader.a_ao, UBYTE, 1, 14);
        this.prepareAttribute(shader.a_wddl, BYTE, 1, 15);
    }
    prepareAttribute(location, type, size, offset) {
        if (location === null)
            return;
        const gl = this.gl;
        const stride = Geometry.StrideInBytes;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribIPointer(location, size, type, stride, offset);
        gl.vertexAttribDivisor(location, 2);
    }
    prepareQuads(data) {
        const n = this.geo.num_quads * Geometry.StrideInInt32;
        const subarray = data.length > n ? data.subarray(0, n) : data;
        this.quads = this.manager.allocator.alloc(subarray, false);
    }
}
;
class VoxelManager {
    constructor(gl, allocator) {
        this.gl = gl;
        this.allocator = allocator;
        this.shader = new VoxelShader(gl);
        this.atlas = new TextureAtlas(gl);
        this.phases = [[], [], []];
    }
    addMesh(geo, phase) {
        assert(geo.num_quads > 0);
        assert(0 <= phase && phase < this.phases.length);
        return new VoxelMesh(this, this.phases[phase], geo);
    }
    render(camera, planes, stats, overlay, move, wave, phase) {
        const { atlas, gl, shader } = this;
        let drawn = 0;
        atlas.bind();
        shader.bind();
        const meshes = this.phases[phase];
        const fog_color = overlay.getFogColor();
        const fog_depth = overlay.getFogDepth(camera);
        gl.uniform1f(shader.u_move, move);
        gl.uniform1f(shader.u_wave, wave);
        gl.uniform1f(shader.u_alphaTest, 1);
        gl.uniform3fv(shader.u_fogColor, fog_color);
        gl.uniform1f(shader.u_fogDepth, fog_depth);
        gl.uniform1i(shader.u_light, 1);
        gl.activeTexture(gl.TEXTURE1);
        // Rendering phases:
        //   0) Opaque and alpha-tested voxel meshes.
        //   1) All other alpha-blended voxel meshes. (Should we sort them?)
        if (phase === 0) {
            for (const mesh of meshes) {
                if (mesh.draw(camera, planes))
                    drawn++;
            }
        }
        else {
            gl.enable(gl.BLEND);
            gl.disable(gl.CULL_FACE);
            gl.uniform1f(shader.u_alphaTest, 0);
            for (const mesh of meshes) {
                if (mesh.draw(camera, planes))
                    drawn++;
            }
            gl.enable(gl.CULL_FACE);
            gl.disable(gl.BLEND);
        }
        stats.drawn += drawn;
        stats.total += meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
class Instance {
    constructor(mesh, index) {
        this.mesh = mesh;
        this.index = index;
    }
    dispose() {
        this.mesh.removeInstance(this.index);
    }
    setLight(light) {
        this.mesh.setInstanceLight(this.index, light);
    }
    setPosition(x, y, z) {
        this.mesh.setInstancePosition(this.index, x, y, z);
    }
}
;
const kInstancedShader = `
  uniform vec3 u_origin;
  uniform vec4 u_billboard;
  uniform mat4 u_transform;
  in vec3 a_pos;
  in float a_light;
  out vec2 v_uv;
  out float v_light;

  void main() {
    int index = gl_VertexID + (gl_VertexID > 0 ? gl_InstanceID & 1 : 0);

    float w = float(((index + 1) & 3) >> 1);
    float h = float(((index + 0) & 3) >> 1);
    v_uv = vec2(w, 1.0 - h);
    v_light = a_light;

    float y = 0.5;
    vec3 v0 = vec3(w - 0.5, h, 0.0);
    vec3 v1 = vec3(v0[0],
                   (v0[1] - y) * u_billboard[2] + y,
                   (v0[1] - y) * u_billboard[3]);
    vec3 v2 = vec3(v1[0] * u_billboard[0] - v1[2] * u_billboard[1],
                   v1[1],
                   v1[0] * u_billboard[1] + v1[2] * u_billboard[0]);
    gl_Position = u_transform * vec4(v2 + (a_pos - u_origin), 1.0);
  }
#split
  uniform vec3 u_fogColor;
  uniform float u_fogDepth;
  uniform float u_frame;
  uniform sampler2DArray u_texture;
  in vec2 v_uv;
  in float v_light;
  out vec4 o_color;

  void main() {
    float depth = u_fogDepth * gl_FragCoord.w;
    float fog = clamp(exp2(-depth * depth), 0.0, 1.0);
    vec4 light = vec4(vec3(v_light), 1.0);
    vec4 color = texture(u_texture, vec3(v_uv, u_frame));
    o_color = mix(light * color, vec4(u_fogColor, color[3]), fog);
    if (o_color[3] < 0.5) discard;
  }
`;
class InstancedShader extends Shader {
    constructor(gl) {
        super(gl, kInstancedShader);
        this.u_fogColor = this.getUniformLocation('u_fogColor');
        this.u_fogDepth = this.getUniformLocation('u_fogDepth');
        this.u_frame = this.getUniformLocation('u_frame');
        this.u_frame = this.getUniformLocation('u_frame');
        this.u_origin = this.getUniformLocation('u_origin');
        this.u_billboard = this.getUniformLocation('u_billboard');
        this.u_transform = this.getUniformLocation('u_transform');
        this.a_pos = this.getAttribLocation('a_pos');
        this.a_light = this.getAttribLocation('a_light');
    }
}
;
class InstancedMesh extends Mesh {
    constructor(manager, meshes, frame, sprite) {
        super(manager, meshes);
        this.buffer = null;
        this.vao = null;
        this.manager = manager;
        this.texture = manager.atlas.addSprite(sprite);
        this.frame = frame;
        this.sprite = sprite;
        this.data = new Float32Array(4 * InstancedMesh.Stride);
        this.dirtyInstances = new Set();
        this.instances = [];
    }
    draw(transform, stats) {
        const { data, gl, shader } = this;
        const n = this.instances.length;
        if (n === 0)
            return false;
        this.prepareBuffers();
        gl.bindVertexArray(this.vao);
        gl.bindTexture(TEXTURE_2D_ARRAY, this.texture);
        gl.uniform1f(shader.u_frame, this.frame);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, n * 2);
        stats.drawnInstances += n;
        stats.totalInstances += this.capacity();
        return true;
    }
    addInstance() {
        const capacity = this.capacity();
        const instances = this.instances;
        assert(instances.length <= capacity);
        if (instances.length === capacity) {
            this.destroyBuffers();
            const data = new Float32Array(2 * this.data.length);
            data.set(this.data);
            this.data = data;
            assert(instances.length < this.capacity());
        }
        const index = int(instances.length);
        const instance = new Instance(this, index);
        instances.push(instance);
        return instance;
    }
    removeInstance(index) {
        const instances = this.instances;
        const popped = instances.pop();
        assert(popped.index === instances.length);
        if (popped.index === index)
            return;
        const data = this.data;
        const stride = InstancedMesh.Stride;
        const source = stride * popped.index;
        const target = stride * index;
        for (let i = 0; i < stride; i++) {
            data[target + i] = data[source + i];
        }
        this.dirtyInstances.add(index);
        instances[index] = popped;
        popped.index = index;
    }
    setInstanceLight(index, light) {
        const data = this.data;
        if (data === null)
            return;
        const offset = index * InstancedMesh.Stride;
        if (data[offset + 3] === light)
            return;
        data[offset + 3] = light;
        this.dirtyInstances.add(index);
    }
    setInstancePosition(index, x, y, z) {
        const data = this.data;
        if (data === null)
            return;
        const offset = index * InstancedMesh.Stride;
        data[offset + 0] = x;
        data[offset + 1] = y;
        data[offset + 2] = z;
        this.dirtyInstances.add(index);
    }
    capacity() {
        const length = this.data.length;
        const stride = InstancedMesh.Stride;
        assert(length % stride === 0);
        return int(length / stride);
    }
    destroyBuffers() {
        const { buffer, gl, vao } = this;
        gl.deleteVertexArray(vao);
        if (buffer)
            this.manager.allocator.free(buffer);
        this.vao = null;
        this.buffer = null;
    }
    prepareBuffers() {
        const { buffer, data, dirtyInstances, gl, shader } = this;
        if (!buffer) {
            this.buffer = this.manager.allocator.alloc(data, true);
        }
        else if (dirtyInstances.size > 64) {
            gl.bindBuffer(ARRAY_BUFFER, buffer.buffer);
            gl.bufferSubData(ARRAY_BUFFER, 0, data, 0, data.length);
            dirtyInstances.clear();
        }
        else if (dirtyInstances.size > 0) {
            const stride = InstancedMesh.Stride;
            gl.bindBuffer(ARRAY_BUFFER, buffer.buffer);
            for (const index of dirtyInstances.values()) {
                const offset = index * stride;
                if (offset >= data.length)
                    continue;
                gl.bufferSubData(ARRAY_BUFFER, 4 * offset, data, offset, stride);
            }
            dirtyInstances.clear();
        }
        if (this.vao)
            return;
        this.vao = nonnull(gl.createVertexArray());
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(ARRAY_BUFFER, nonnull(this.buffer).buffer);
        this.prepareAttribute(shader.a_pos, 3, 0);
        this.prepareAttribute(shader.a_light, 1, 3);
    }
    prepareAttribute(location, size, offset_in_floats) {
        if (location === null)
            return;
        const gl = this.gl;
        const offset = 4 * offset_in_floats;
        const stride = 4 * InstancedMesh.Stride;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(location, 2);
    }
}
InstancedMesh.Stride = 4;
;
class InstancedManager {
    constructor(gl, allocator, atlas) {
        this.gl = gl;
        this.allocator = allocator;
        this.atlas = atlas;
        this.shader = new InstancedShader(gl);
        this.billboard = new Float32Array(4);
        this.origin_32 = new Float32Array(3);
        this.meshes = [];
        this.origin = Vec3.create();
    }
    addMesh(frame, sprite) {
        return new InstancedMesh(this, this.meshes, frame, sprite);
    }
    render(camera, planes, stats, overlay) {
        const { billboard, gl, meshes, origin, origin_32, shader } = this;
        let drawn = 0;
        origin_32[0] = origin[0] = Math.floor(camera.position[0]);
        origin_32[1] = origin[1] = Math.floor(camera.position[1]);
        origin_32[2] = origin[2] = Math.floor(camera.position[2]);
        const transform = camera.getTransformFor(origin);
        const pitch = -0.33 * camera.pitch;
        billboard[0] = Math.cos(camera.heading);
        billboard[1] = -Math.sin(camera.heading);
        billboard[2] = Math.cos(pitch);
        billboard[3] = -Math.sin(pitch);
        const fog_color = overlay.getFogColor();
        const fog_depth = overlay.getFogDepth(camera);
        shader.bind();
        gl.uniform3fv(shader.u_origin, origin_32);
        gl.uniform4fv(shader.u_billboard, billboard);
        gl.uniform3fv(shader.u_fogColor, fog_color);
        gl.uniform1f(shader.u_fogDepth, fog_depth);
        gl.uniformMatrix4fv(shader.u_transform, false, transform);
        gl.activeTexture(gl.TEXTURE0);
        for (const mesh of meshes) {
            if (mesh.draw(transform, stats))
                drawn++;
        }
        stats.drawn += drawn;
        stats.total += meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kUnitSquarePos = Float32Array.from([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
const kSpriteShader = `
  uniform float u_size;
  uniform float u_height;
  uniform vec4 u_stuv;
  uniform vec4 u_billboard;
  uniform mat4 u_transform;
  in vec2 a_pos;
  out vec2 v_uv;

  void main() {
    float w = a_pos[0];
    float h = a_pos[1];
    float u = u_stuv[0] + u_stuv[2] * w;
    float v = u_stuv[1] + u_stuv[3] * (1.0 - h);
    v_uv = vec2(u, v);

    float y = 0.5 * u_height;
    vec3 v0 = vec3(u_size * (w - 0.5), u_size * h, 0.0);
    vec3 v1 = vec3(v0[0],
                   (v0[1] - y) * u_billboard[2] + y,
                   (v0[1] - y) * u_billboard[3]);
    vec3 v2 = vec3(v1[0] * u_billboard[0] - v1[2] * u_billboard[1],
                   v1[1],
                   v1[0] * u_billboard[1] + v1[2] * u_billboard[0]);
    gl_Position = u_transform * vec4(v2, 1.0);
  }
#split
  uniform float u_frame;
  uniform float u_light;
  uniform sampler2DArray u_texture;
  in vec2 v_uv;
  out vec4 o_color;

  void main() {
    o_color = texture(u_texture, vec3(v_uv, u_frame));
    if (o_color[3] < 0.5) discard;
    o_color *= u_light;
  }
`;
class SpriteShader extends Shader {
    constructor(gl) {
        super(gl, kSpriteShader);
        this.u_size = this.getUniformLocation('u_size');
        this.u_stuv = this.getUniformLocation('u_stuv');
        this.u_billboard = this.getUniformLocation('u_billboard');
        this.u_transform = this.getUniformLocation('u_transform');
        this.u_frame = this.getUniformLocation('u_frame');
        this.u_light = this.getUniformLocation('u_light');
        this.u_height = this.getUniformLocation('u_height');
    }
}
;
class SpriteMesh extends Mesh {
    constructor(manager, meshes, size, sprite) {
        super(manager, meshes);
        this.enabled = true;
        this.frame = 0;
        this.light = 1;
        this.manager = manager;
        this.size = size;
        this.height = size;
        this.stuv = new Float32Array(4);
        this.stuv[2] = 1;
        this.stuv[3] = 1;
        this.texture = manager.atlas.addSprite(sprite);
    }
    draw(camera, planes) {
        if (!this.enabled)
            return false;
        const bounds = this.manager.getBounds(this.size);
        if (this.cull(bounds, camera, planes))
            return false;
        const transform = camera.getTransformFor(this.position);
        const { gl, shader } = this;
        gl.bindTexture(TEXTURE_2D_ARRAY, this.texture);
        gl.uniform1f(shader.u_size, this.size);
        gl.uniform4fv(shader.u_stuv, this.stuv);
        gl.uniform1f(shader.u_light, this.light);
        gl.uniform1f(shader.u_frame, this.frame);
        gl.uniform1f(shader.u_height, this.height);
        gl.uniformMatrix4fv(shader.u_transform, false, transform);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return true;
    }
    setFrame(frame) {
        this.frame = frame;
    }
    setHeight(height) {
        this.height = height;
    }
    setLight(light) {
        this.light = light;
    }
    setPosition(x, y, z) {
        Vec3.set(this.position, x, y, z);
    }
    setSTUV(s, t, u, v) {
        const stuv = this.stuv;
        stuv[0] = s;
        stuv[1] = t;
        stuv[2] = u;
        stuv[3] = v;
    }
}
;
class SpriteManager {
    constructor(gl, atlas, unit_square_vao) {
        this.gl = gl;
        this.atlas = atlas;
        this.unit_square_vao = unit_square_vao;
        this.shader = new SpriteShader(gl);
        this.billboard = new Float32Array(4);
        this.bounds = new Float64Array(24);
        this.meshes = [];
    }
    addMesh(size, sprite) {
        return new SpriteMesh(this, this.meshes, size, sprite);
    }
    getBounds(size) {
        const result = this.bounds;
        const half_size = 0.5 * size;
        for (let i = 0; i < 8; i++) {
            const offset = 3 * i;
            result[offset + 0] = (i & 1) ? half_size : -half_size;
            result[offset + 1] = (i & 2) ? size : 0;
            result[offset + 2] = (i & 4) ? half_size : -half_size;
        }
        return result;
    }
    render(camera, planes, stats) {
        const { billboard, gl, meshes, shader, unit_square_vao } = this;
        let drawn = 0;
        // All sprite meshes are alpha-tested, for now.
        shader.bind();
        gl.bindVertexArray(unit_square_vao);
        const pitch = -0.33 * camera.pitch;
        billboard[0] = Math.cos(camera.heading);
        billboard[1] = -Math.sin(camera.heading);
        billboard[2] = Math.cos(pitch);
        billboard[3] = -Math.sin(pitch);
        gl.uniform4fv(shader.u_billboard, billboard);
        gl.activeTexture(gl.TEXTURE0);
        for (const mesh of meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        stats.drawn += drawn;
        stats.total += meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kShadowAlpha = 0.25;
const kShadowShader = `
  uniform float u_size;
  uniform mat4 u_transform;
  in vec2 a_pos;
  out vec2 v_pos;

  void main() {
    float w = a_pos[0];
    float h = a_pos[1];
    v_pos = vec2(w - 0.5, h - 0.5);

    float x = 2.0 * u_size * v_pos[0];
    float z = 2.0 * u_size * v_pos[1];
    gl_Position = u_transform * vec4(x, 0.0, z, 1.0);
  }
#split
  in vec2 v_pos;
  out vec4 o_color;

  void main() {
    float radius = length(v_pos);
    if (radius > 0.5) discard;
    o_color = vec4(0.0, 0.0, 0.0, ${kShadowAlpha});
  }
`;
class ShadowShader extends Shader {
    constructor(gl) {
        super(gl, kShadowShader);
        this.u_size = this.getUniformLocation('u_size');
        this.u_transform = this.getUniformLocation('u_transform');
    }
}
;
class ShadowMesh extends Mesh {
    constructor(manager, meshes) {
        super(manager, meshes);
        this.size = 0;
        this.manager = manager;
    }
    draw(camera, planes) {
        const bounds = this.manager.getBounds(this.size);
        if (this.cull(bounds, camera, planes))
            return false;
        const transform = camera.getTransformFor(this.position);
        const { gl, shader } = this;
        gl.uniform1f(shader.u_size, this.size);
        gl.uniformMatrix4fv(shader.u_transform, false, transform);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return true;
    }
    setPosition(x, y, z) {
        Vec3.set(this.position, x, y, z);
    }
    setSize(size) {
        this.size = size;
    }
}
;
class ShadowManager {
    constructor(gl, unit_square_vao) {
        this.gl = gl;
        this.unit_square_vao = unit_square_vao;
        this.shader = new ShadowShader(gl);
        this.bounds = new Float64Array(24);
        this.meshes = [];
    }
    addMesh() {
        return new ShadowMesh(this, this.meshes);
    }
    getBounds(size) {
        const result = this.bounds;
        for (let i = 0; i < 8; i++) {
            const offset = 3 * i;
            result[offset + 0] = (i & 1) ? size : -size;
            result[offset + 2] = (i & 4) ? size : -size;
        }
        return result;
    }
    render(camera, planes, stats) {
        const { gl, meshes, shader, unit_square_vao } = this;
        let drawn = 0;
        // All shadow meshes are alpha-blended.
        shader.bind();
        gl.bindVertexArray(unit_square_vao);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        for (const mesh of meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        stats.drawn += drawn;
        stats.total += meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kHighlightShader = `
  uniform int u_mask;
  uniform mat4 u_transform;
  in vec2 a_pos;

  void main() {
    int dim = gl_InstanceID >> 1;

    const float epsilon = 1.0 / 256.0;
    const float width = 1.0 + 2.0 * epsilon;

    vec4 pos = vec4(0.0, 0.0, 0.0, 1.0);
    float face_dir = 1.0 - float(gl_InstanceID & 1);
    pos[(dim + 0) % 3] = width * face_dir - epsilon;
    pos[(dim + 1) % 3] = width * a_pos[0] - epsilon;
    pos[(dim + 2) % 3] = width * a_pos[1] - epsilon;

    gl_Position = u_transform * pos;

    bool hide = (u_mask & (1 << gl_InstanceID)) != 0;
    if (hide) gl_Position[3] = 0.0;
  }
#split
  out vec4 o_color;

  void main() {
    o_color = vec4(1.0, 1.0, 1.0, 0.4);
  }
`;
class HighlightShader extends Shader {
    constructor(gl) {
        super(gl, kHighlightShader);
        this.u_mask = this.getUniformLocation('u_mask');
        this.u_transform = this.getUniformLocation('u_transform');
    }
}
;
class HighlightMesh extends Mesh {
    constructor(manager, meshes) {
        super(manager, meshes);
        this.mask = 0;
        this.size = 0;
        this.manager = manager;
    }
    draw(camera, planes) {
        if (!this.shown())
            return false;
        const transform = camera.getTransformFor(this.position);
        const { gl, shader } = this;
        gl.uniform1i(shader.u_mask, this.mask);
        gl.uniformMatrix4fv(shader.u_transform, false, transform);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 6);
        return true;
    }
    setPosition(x, y, z) {
        Vec3.set(this.position, x, y, z);
    }
    shown() {
        return this.mask !== (1 << 6) - 1;
    }
}
;
class HighlightManager {
    constructor(gl, unit_square_vao) {
        this.gl = gl;
        this.unit_square_vao = unit_square_vao;
        this.shader = new HighlightShader(gl);
        this.meshes = [];
    }
    addMesh() {
        return new HighlightMesh(this, this.meshes);
    }
    render(camera, planes, stats) {
        const { gl, meshes, shader, unit_square_vao } = this;
        if (!meshes.some(x => x.shown())) {
            stats.total += meshes.length;
            return;
        }
        let drawn = 0;
        // All highlight meshes are alpha-blended. None write to the depth map.
        shader.bind();
        gl.bindVertexArray(unit_square_vao);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.disable(gl.CULL_FACE);
        for (const mesh of meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        gl.enable(gl.CULL_FACE);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        stats.drawn += drawn;
        stats.total += meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kDefaultFogColor = [0.6, 0.8, 1.0];
const kDefaultSkyColor = [0.6, 0.8, 1.0];
const kScreenOverlayShader = `
  in vec2 a_pos;

  void main() {
    float w = a_pos[0];
    float h = a_pos[1];
    gl_Position = vec4(2.0 * w - 1.0, 2.0 * h - 1.0, 1.0, 1.0);
  }
#split
  uniform vec4 u_color;

  out vec4 o_color;

  void main() {
    o_color = u_color;
  }
`;
class ScreenOverlayShader extends Shader {
    constructor(gl) {
        super(gl, kScreenOverlayShader);
        this.u_color = this.getUniformLocation('u_color');
    }
}
;
class ScreenOverlay {
    constructor(gl, unit_square_vao) {
        this.gl = gl;
        this.unit_square_vao = unit_square_vao;
        this.color = new Float32Array([1, 1, 1, 1]);
        this.fog_color = new Float32Array(kDefaultFogColor);
        this.shader = new ScreenOverlayShader(gl);
    }
    draw() {
        const alpha = this.color[3];
        if (alpha === 1)
            return;
        const { color, gl, shader, unit_square_vao } = this;
        shader.bind();
        gl.bindVertexArray(unit_square_vao);
        color[3] = 1;
        gl.uniform4fv(shader.u_color, color);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        color[3] = alpha;
        gl.enable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.uniform4fv(shader.u_color, color);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
    }
    getFogColor() {
        return this.fog_color;
    }
    getFogDepth(camera) {
        if (this.color[3] !== 1)
            return 64;
        return Math.max(256, Math.min(2 * camera.position[1], 1024));
    }
    setColor(color) {
        for (let i = 0; i < 4; i++)
            this.color[i] = color[i];
        if (color[3] < 1) {
            for (let i = 0; i < 3; i++)
                this.fog_color[i] = color[i];
        }
        else {
            this.fog_color.set(kDefaultFogColor);
        }
    }
}
;
;
;
;
;
;
;
;
;
;
class Renderer {
    constructor(canvas) {
        const params = new URLSearchParams(window.location.search);
        const size = params.get('size') || 'small';
        const scale = parseFloat(params.get('scale') || '1');
        const antialias_base = size === 'small' ? '1' : '0';
        const antialias = parseInt(params.get('antialias') || antialias_base);
        const container = nonnull(nonnull(canvas.parentElement).parentElement);
        container.classList.add(size);
        canvas.width = canvas.clientWidth / scale;
        canvas.height = canvas.clientHeight / scale;
        this.camera = new Camera(int(canvas.width), int(canvas.height));
        const gl = nonnull(canvas.getContext('webgl2', { alpha: false, antialias: antialias === 1 }));
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.disable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.balloc = new BufferAllocator(gl);
        this.talloc = new TextureAllocator(gl);
        const atlas = new SpriteAtlas(gl);
        const allocator = this.balloc;
        const unit_square_vao = nonnull(gl.createVertexArray());
        const unit_square_buffer = allocator.alloc(kUnitSquarePos, false);
        gl.bindVertexArray(unit_square_vao);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.gl = gl;
        this.overlay = new ScreenOverlay(gl, unit_square_vao);
        this.highlight_manager = new HighlightManager(gl, unit_square_vao);
        this.instanced_manager = new InstancedManager(gl, allocator, atlas);
        this.shadow_manager = new ShadowManager(gl, unit_square_vao);
        this.sprite_manager = new SpriteManager(gl, atlas, unit_square_vao);
        this.voxels_manager = new VoxelManager(gl, allocator);
    }
    addLightTexture(data) {
        return new LightTexture(data, this.talloc);
    }
    addTexture(texture) {
        return this.voxels_manager.atlas.addTexture(texture);
    }
    addHighlightMesh() {
        return this.highlight_manager.addMesh();
    }
    addInstancedMesh(frame, sprite) {
        return this.instanced_manager.addMesh(frame, sprite);
    }
    addShadowMesh() {
        return this.shadow_manager.addMesh();
    }
    addSpriteMesh(size, sprite) {
        return this.sprite_manager.addMesh(size, sprite);
    }
    addVoxelMesh(geo, phase) {
        return this.voxels_manager.addMesh(geo, phase);
    }
    render(move, wave, sparkle) {
        const { gl, overlay } = this;
        const [r, g, b] = kDefaultSkyColor;
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (sparkle)
            this.voxels_manager.atlas.sparkle();
        const camera = this.camera;
        const planes = camera.getCullingPlanes();
        const stats = { drawn: 0, total: 0, drawnInstances: 0, totalInstances: 0 };
        this.sprite_manager.render(camera, planes, stats);
        this.instanced_manager.render(camera, planes, stats, overlay);
        this.voxels_manager.render(camera, planes, stats, overlay, move, wave, 0);
        this.highlight_manager.render(camera, planes, stats);
        this.shadow_manager.render(camera, planes, stats);
        this.voxels_manager.render(camera, planes, stats, overlay, move, wave, 1);
        overlay.draw();
        return `${this.balloc.stats()}\r\n` +
            `${this.talloc.stats()}\r\n` +
            `Draw calls: ${stats.drawn} / ${stats.total}\r\n` +
            `Instances: ${stats.drawnInstances} / ${stats.totalInstances}`;
    }
    setOverlayColor(color) {
        this.overlay.setColor(color);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { kShadowAlpha, Geometry, Renderer };
//# sourceMappingURL=renderer.js.map