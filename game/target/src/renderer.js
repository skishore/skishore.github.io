import { assert, int, nonnull } from './base.js';
import { Mat4, Vec3 } from './base.js';
;
const kTmpDelta = Vec3.create();
const kTmpPlane = Vec3.create();
class Camera {
    constructor(width, height) {
        this.pitch = 0;
        this.heading = 0;
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
        this.zoom = Math.max(0, Math.min(10, this.zoom + Math.sign(dscroll)));
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
    setSafeZoomDistance(zoom) {
        zoom = Math.max(Math.min(zoom, this.zoom), 0);
        Vec3.scaleAndAdd(this.position, this.target, this.direction, -zoom);
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
        const index = int(++this.nextResult);
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
        this.gl.bindTexture(TEXTURE_2D_ARRAY, this.texture);
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
            const canvas = nonnull(element.getContext('2d'));
            this.canvas = canvas;
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
        const capacity = this.data ? this.data.length : 0;
        const required = length + offset;
        const allocate = capacity < required;
        if (allocate) {
            const data = new Uint8Array(Math.max(2 * capacity, required));
            for (let i = 0; i < length; i++)
                data[i] = 255;
            for (let i = length; i < this.data.length; i++)
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
            throw new Error(`({w} x ${h}) image cannot fit (${x} x ${y}) frames.`);
        }
        const cols = w / x, rows = h / y;
        const frames = cols * rows;
        if (this.canvas === null) {
            const element = document.createElement('canvas');
            const canvas = nonnull(element.getContext('2d'));
            this.canvas = canvas;
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
        this.bounds = Array(8).fill(null);
        for (let i = 0; i < 8; i++)
            this.bounds[i] = Vec3.create();
        this.dirty = true;
    }
    clear() {
        this.num_quads = 0;
        this.dirty = true;
    }
    allocateQuads(n) {
        this.num_quads = n;
        const length = this.quads.length;
        const needed = Geometry.Stride * n;
        if (length >= needed)
            return;
        const expanded = new Float32Array(Math.max(length * 2, needed));
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
        const { lower_bound, upper_bound } = this;
        Vec3.set(lower_bound, Infinity, Infinity, Infinity);
        Vec3.set(upper_bound, -Infinity, -Infinity, -Infinity);
        const quads = this.quads;
        const stride = Geometry.Stride;
        assert(Geometry.OffsetPos === 0);
        assert(Geometry.OffsetSize === 3);
        assert(Geometry.OffsetDim === 10);
        assert(quads.length % stride === 0);
        for (let i = 0; i < quads.length; i += stride) {
            const lx = quads[i + 0];
            const ly = quads[i + 1];
            const lz = quads[i + 2];
            const w = quads[i + 3];
            const h = quads[i + 4];
            const dim = quads[i + 10];
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
            const bound = this.bounds[i];
            for (let j = 0; j < 3; j++) {
                bound[j] = (i & (1 << j)) ? upper_bound[j] : lower_bound[j];
            }
        }
        this.dirty = false;
    }
    static clone(geo) {
        const num_quads = geo.num_quads;
        const quads = geo.quads.slice(0, num_quads * Geometry.Stride);
        return new Geometry(quads, num_quads);
    }
    static empty() {
        return new Geometry(new Float32Array(), 0);
    }
}
// position: vec3
Geometry.OffsetPos = 0;
// size: vec2
Geometry.OffsetSize = 3;
// color: vec4
Geometry.OffsetColor = 5;
// ao: float -> int32; 4 packed 2-bit values
Geometry.OffsetAOs = 9;
// dim: float -> int32; {0, 1, 2}
Geometry.OffsetDim = 10;
// dir: float -> int32; {-1, 1}
Geometry.OffsetDir = 11;
// mask: float -> int32; small int
Geometry.OffsetMask = 12;
// wave: float -> int32; 4 packed 1-bit values
Geometry.OffsetWave = 13;
// texture: float -> int32; medium int
Geometry.OffsetTexture = 14;
// indices: float -> int32; 6 packed 2-bit values
Geometry.OffsetIndices = 15;
// Overall stride (in floats)
Geometry.Stride = 16;
;
//////////////////////////////////////////////////////////////////////////////
class Buffer {
    constructor(gl, length, freeList) {
        this.usage = 0;
        const buffer = nonnull(gl.createBuffer());
        gl.bindBuffer(ARRAY_BUFFER, buffer);
        gl.bufferData(ARRAY_BUFFER, length, gl.STATIC_DRAW);
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
        this.freeLists = new Array(32).fill(null).map(() => []);
    }
    alloc(data) {
        const gl = this.gl;
        const bytes = int(4 * data.length);
        const sizeClass = this.sizeClass(bytes);
        const freeList = this.freeLists[sizeClass];
        const length = int(1 << sizeClass);
        let buffer = freeList.pop();
        if (buffer) {
            gl.bindBuffer(ARRAY_BUFFER, buffer.buffer);
        }
        else {
            buffer = new Buffer(gl, length, freeList);
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
        return `VRAM: ${usage} / ${alloc} / ${total}Mb`;
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
            const bound = bounds[index];
            const bx = bound[0], by = bound[1], bz = bound[2];
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

  in vec3 a_pos;
  in vec2 a_size;
  in vec4 a_color;
  in float a_aos;
  in float a_dim;
  in float a_dir;
  in float a_mask;
  in float a_wave;
  in float a_texture;
  in float a_indices;

  out vec4 v_color;
  out vec3 v_uvw;
  out float v_move;

  int unpackI2(float packed, int index) {
    return (int(packed) >> (2 * index)) & 3;
  }

  void main() {
    int instance = gl_VertexID + 3 * (gl_InstanceID & 1);
    int index = unpackI2(a_indices, instance);

    float ao = 1.0 - 0.3 * float(unpackI2(a_aos, index));
    v_color = vec4(ao * vec3(a_color), a_color[3]);

    int dim = int(a_dim);
    float w = float(((index + 1) & 3) >> 1);
    float h = float(((index + 0) & 3) >> 1);

    v_uvw = vec3(0.0, 0.0, a_texture);
    const float kTextureBuffer = 0.01;
    if (dim == 2) {
      v_uvw[0] = (a_size[0] - kTextureBuffer) * w * -a_dir;
      v_uvw[1] = (a_size[1] - kTextureBuffer) * (1.0 - h);
    } else {
      v_uvw[0] = (a_size[1] - kTextureBuffer) * h * a_dir;
      v_uvw[1] = (a_size[0] - kTextureBuffer) * (1.0 - w);
    }

    float wave = float((int(a_wave) >> index) & 0x1);
    v_move = wave * u_move;

    vec3 pos = a_pos;
    pos[(dim + 1) % 3] += w * a_size[0];
    pos[(dim + 2) % 3] += h * a_size[1];
    pos[1] -= wave * u_wave;
    gl_Position = u_transform * vec4(pos, 1.0);

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
  uniform sampler2DArray u_texture;
  in vec4 v_color;
  in vec3 v_uvw;
  in float v_move;
  out vec4 o_color;

  void main() {
    float depth = u_fogDepth * gl_FragCoord.w;
    float fog = clamp(exp2(-depth * depth), 0.0, 1.0);
    vec3 index = v_uvw + vec3(v_move, v_move, 0.0);
    vec4 color = v_color * texture(u_texture, index);
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
        this.a_pos = this.getAttribLocation('a_pos');
        this.a_size = this.getAttribLocation('a_size');
        this.a_color = this.getAttribLocation('a_color');
        this.a_aos = this.getAttribLocation('a_aos');
        this.a_dim = this.getAttribLocation('a_dim');
        this.a_dir = this.getAttribLocation('a_dir');
        this.a_mask = this.getAttribLocation('a_mask');
        this.a_wave = this.getAttribLocation('a_wave');
        this.a_texture = this.getAttribLocation('a_texture');
        this.a_indices = this.getAttribLocation('a_indices');
    }
}
;
const kDefaultMask = new Int32Array(2);
class VoxelMesh extends Mesh {
    constructor(manager, meshes, geo) {
        super(manager, meshes);
        this.vao = null;
        this.quads = null;
        this.mask = kDefaultMask;
        this.allocator = manager.allocator;
        this.geo = geo;
    }
    dispose() {
        super.dispose();
        this.destroyBuffers();
        this.mask = kDefaultMask;
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
    setPosition(x, y, z) {
        Vec3.set(this.position, x, y, z);
    }
    show(mask, shown) {
        this.mask = mask;
        if (shown === this.shown())
            return;
        shown ? this.addToMeshes() : this.removeFromMeshes();
        assert(shown === this.shown());
    }
    destroyBuffers() {
        const { gl, quads } = this;
        const n = this.geo.num_quads * Geometry.Stride;
        gl.deleteVertexArray(this.vao);
        if (quads)
            this.allocator.free(quads);
        this.vao = null;
        this.quads = null;
    }
    prepareBuffers() {
        if (this.vao)
            return;
        const { gl, shader } = this;
        this.vao = nonnull(gl.createVertexArray());
        gl.bindVertexArray(this.vao);
        this.prepareQuads(this.geo.quads);
        this.prepareAttribute(shader.a_pos, 3, Geometry.OffsetPos);
        this.prepareAttribute(shader.a_size, 2, Geometry.OffsetSize);
        this.prepareAttribute(shader.a_color, 4, Geometry.OffsetColor);
        this.prepareAttribute(shader.a_aos, 1, Geometry.OffsetAOs);
        this.prepareAttribute(shader.a_dim, 1, Geometry.OffsetDim);
        this.prepareAttribute(shader.a_dir, 1, Geometry.OffsetDir);
        this.prepareAttribute(shader.a_mask, 1, Geometry.OffsetMask);
        this.prepareAttribute(shader.a_wave, 1, Geometry.OffsetWave);
        this.prepareAttribute(shader.a_texture, 1, Geometry.OffsetTexture);
        this.prepareAttribute(shader.a_indices, 1, Geometry.OffsetIndices);
    }
    prepareAttribute(location, size, offset_in_floats) {
        if (location === null)
            return;
        const gl = this.gl;
        const offset = 4 * offset_in_floats;
        const stride = 4 * Geometry.Stride;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        gl.vertexAttribDivisor(location, 2);
    }
    prepareQuads(data) {
        const n = this.geo.num_quads * Geometry.Stride;
        const subarray = data.length > n ? data.subarray(0, n) : data;
        this.quads = this.allocator.alloc(subarray);
    }
}
;
class VoxelManager {
    constructor(gl) {
        this.gl = gl;
        this.shader = new VoxelShader(gl);
        this.atlas = new TextureAtlas(gl);
        this.allocator = new BufferAllocator(gl);
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
        const fog_depth = overlay.getFogDepth();
        gl.uniform1f(shader.u_move, move);
        gl.uniform1f(shader.u_wave, wave);
        gl.uniform1f(shader.u_alphaTest, 1);
        gl.uniform3fv(shader.u_fogColor, fog_color);
        gl.uniform1f(shader.u_fogDepth, fog_depth);
        // Rendering phases:
        //   0) Opaque and alpha-tested voxel meshes.
        //   1) The highlight mesh, drawn before shadows and other effects.
        //   2) All other alpha-blended voxel meshes. (Should we sort them?)
        if (phase === 0) {
            for (const mesh of meshes) {
                if (mesh.draw(camera, planes))
                    drawn++;
            }
        }
        else {
            gl.enable(gl.BLEND);
            gl.disable(gl.CULL_FACE);
            if (phase === 1)
                gl.depthMask(false);
            gl.uniform1f(shader.u_alphaTest, 0);
            for (const mesh of meshes) {
                if (mesh.draw(camera, planes))
                    drawn++;
            }
            if (phase === 1)
                gl.depthMask(true);
            gl.enable(gl.CULL_FACE);
            gl.disable(gl.BLEND);
        }
        stats.drawn += drawn;
        stats.total += meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kSpriteShader = `
  uniform float u_size;
  uniform float u_height;
  uniform vec4 u_stuv;
  uniform vec4 u_billboard;
  uniform mat4 u_transform;
  out vec2 v_uv;

  void main() {
    int index = gl_VertexID + (gl_VertexID > 0 ? gl_InstanceID : 0);

    float w = float(((index + 1) & 3) >> 1);
    float h = float(((index + 0) & 3) >> 1);

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
    constructor(manager, meshes, sprite) {
        super(manager, meshes);
        this.enabled = true;
        this.frame = 0;
        this.light = 1;
        this.manager = manager;
        this.size = sprite.size;
        this.height = sprite.size;
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
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 2);
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
    constructor(gl) {
        this.gl = gl;
        this.shader = new SpriteShader(gl);
        this.atlas = new SpriteAtlas(gl);
        this.billboard = new Float32Array(4);
        this.bounds = Array(8).fill(null).map(() => Vec3.create());
        this.meshes = [];
    }
    addMesh(sprite) {
        return new SpriteMesh(this, this.meshes, sprite);
    }
    getBounds(size) {
        const result = this.bounds;
        const half_size = 0.5 * size;
        for (let i = 0; i < 8; i++) {
            const bound = result[i];
            bound[0] = (i & 1) ? half_size : -half_size;
            bound[1] = (i & 2) ? size : 0;
            bound[2] = (i & 4) ? half_size : -half_size;
        }
        return result;
    }
    render(camera, planes, stats) {
        const { billboard, gl, shader } = this;
        let drawn = 0;
        // All sprite meshes are alpha-tested for now.
        shader.bind();
        const pitch = -0.33 * camera.pitch;
        billboard[0] = Math.cos(camera.heading);
        billboard[1] = -Math.sin(camera.heading);
        billboard[2] = Math.cos(pitch);
        billboard[3] = -Math.sin(pitch);
        gl.uniform4fv(shader.u_billboard, billboard);
        for (const mesh of this.meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        stats.drawn += drawn;
        stats.total += this.meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kShadowAlpha = 0.36;
const kShadowShader = `
  uniform float u_size;
  uniform mat4 u_transform;
  out vec2 v_pos;

  void main() {
    int index = gl_VertexID + (gl_VertexID > 0 ? gl_InstanceID : 0);

    float w = float(((index + 1) & 3) >> 1);
    float h = float(((index + 0) & 3) >> 1);
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
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 2);
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
    constructor(gl) {
        this.gl = gl;
        this.shader = new ShadowShader(gl);
        this.bounds = Array(8).fill(null).map(() => Vec3.create());
        this.meshes = [];
    }
    addMesh() {
        return new ShadowMesh(this, this.meshes);
    }
    getBounds(size) {
        const result = this.bounds;
        const half_size = 0.5 * size;
        for (let i = 0; i < 8; i++) {
            const bound = result[i];
            bound[0] = (i & 1) ? size : -size;
            bound[2] = (i & 4) ? size : -size;
        }
        return result;
    }
    render(camera, planes, stats) {
        const { gl, shader } = this;
        let drawn = 0;
        // All sprite meshes are alpha-blended.
        shader.bind();
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        for (const mesh of this.meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        stats.drawn += drawn;
        stats.total += this.meshes.length;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kDefaultFogColor = [0.6, 0.8, 1.0];
const kDefaultSkyColor = [0.6, 0.8, 1.0];
const kScreenOverlayShader = `
  void main() {
    int index = gl_VertexID + (gl_VertexID > 0 ? gl_InstanceID : 0);
    float w = float(((index + 1) & 3) >> 1);
    float h = float(((index + 0) & 3) >> 1);
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
    constructor(gl) {
        this.color = new Float32Array([1, 1, 1, 1]);
        this.fog_color = new Float32Array(kDefaultFogColor);
        this.gl = gl;
        this.shader = new ScreenOverlayShader(gl);
    }
    draw() {
        const alpha = this.color[3];
        if (alpha === 1)
            return;
        this.shader.bind();
        const gl = this.gl;
        this.color[3] = 1;
        gl.uniform4fv(this.shader.u_color, this.color);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 2);
        this.color[3] = alpha;
        gl.enable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.uniform4fv(this.shader.u_color, this.color);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 2);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
    }
    getFogColor() {
        return this.fog_color;
    }
    getFogDepth() {
        return this.color[3] === 1 ? 1024 : 64;
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
class Renderer {
    constructor(canvas) {
        const params = new URLSearchParams(window.location.search);
        const size = params.get('size') || 'small';
        const base = size === 'small' ? '1' : '2';
        const scale = parseFloat(params.get('scale') || base);
        const container = nonnull(nonnull(canvas.parentElement).parentElement);
        container.classList.add(size);
        canvas.width = canvas.clientWidth / scale;
        canvas.height = canvas.clientHeight / scale;
        this.camera = new Camera(int(canvas.width), int(canvas.height));
        const gl = nonnull(canvas.getContext('webgl2', { alpha: false }));
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.disable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.gl = gl;
        this.overlay = new ScreenOverlay(gl);
        this.shadow_manager = new ShadowManager(gl);
        this.sprite_manager = new SpriteManager(gl);
        this.voxels_manager = new VoxelManager(gl);
    }
    addTexture(texture) {
        return this.voxels_manager.atlas.addTexture(texture);
    }
    addShadowMesh() {
        return this.shadow_manager.addMesh();
    }
    addSpriteMesh(sprite) {
        return this.sprite_manager.addMesh(sprite);
    }
    addVoxelMesh(geo, phase) {
        return this.voxels_manager.addMesh(geo, phase);
    }
    render(move, wave) {
        const { gl, overlay } = this;
        const [r, g, b] = kDefaultSkyColor;
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.voxels_manager.atlas.sparkle();
        const camera = this.camera;
        const planes = camera.getCullingPlanes();
        const stats = { drawn: int(0), total: int(0) };
        this.sprite_manager.render(camera, planes, stats);
        this.voxels_manager.render(camera, planes, stats, overlay, move, wave, 0);
        this.voxels_manager.render(camera, planes, stats, overlay, move, wave, 1);
        this.shadow_manager.render(camera, planes, stats);
        this.voxels_manager.render(camera, planes, stats, overlay, move, wave, 2);
        overlay.draw();
        return `${this.voxels_manager.allocator.stats()}\r\n` +
            `Draw calls: ${stats.drawn} / ${stats.total}`;
    }
    setOverlayColor(color) {
        this.overlay.setColor(color);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { kShadowAlpha, Geometry, Renderer };
//# sourceMappingURL=renderer.js.map