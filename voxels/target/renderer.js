import { assert, nonnull } from './base.js';
import { Mat4, Vec3 } from './base.js';
;
const kTmpDelta = Vec3.create();
const kTmpPlane = Vec3.create();
class Camera {
    constructor(width, height) {
        this.pitch = 0;
        this.heading = 0;
        this.zoom = 0;
        this.direction = Vec3.from(0, 0, 1);
        this.position = Vec3.create();
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
            console.log(`Smoothing out update: ${dx} x ${dy}`);
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
            plane.index = (x > 0 ? 1 : 0) | (y > 0 ? 2 : 0) | (z > 0 ? 4 : 0);
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
    setTarget(x, y, z) {
        Vec3.set(this.position, x, y, z);
        Vec3.scaleAndAdd(this.position, this.position, this.direction, -this.zoom);
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
        gl.shaderSource(result, `#version 300 es\n${source}`);
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
        this.data = new Uint8Array();
        this.nextResult = 0;
        this.bind();
        const id = TEXTURE_2D_ARRAY;
        gl.texParameteri(id, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(id, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    }
    addTexture(texture) {
        const index = ++this.nextResult;
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
        }
        gl.generateMipmap(TEXTURE_2D_ARRAY);
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
    cull(delta, planes) {
        if (this.dirty)
            this.computeBounds();
        const bounds = this.bounds;
        for (const plane of planes) {
            const { x, y, z, index } = plane;
            const bound = bounds[index];
            const value = (bound[0] + delta[0]) * x +
                (bound[1] + delta[1]) * y +
                (bound[2] + delta[2]) * z;
            if (value < 0)
                return true;
        }
        return false;
    }
    computeBounds() {
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
// wave: float -> int32; {0, 1}
Geometry.OffsetWave = 13;
// texture: float -> int32; medium int
Geometry.OffsetTexture = 14;
// indices: float -> int32; 6 packed 2-bit values
Geometry.OffsetIndices = 15;
// Overall stride (in floats)
Geometry.Stride = 16;
;
//////////////////////////////////////////////////////////////////////////////
const kBasicShader = `
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
    v_uvw = vec3(0, 0, a_texture);
    if (dim == 2) {
      if (index == 1 || index == 2) {
        v_uvw[0] = -a_dir * a_size[0];
      }
      if (index == 0 || index == 1) {
        v_uvw[1] = a_size[1];
      }
    } else {
      if (index == 2 || index == 3) {
        v_uvw[0] = a_dir * a_size[1];
      }
      if (index == 0 || index == 3) {
        v_uvw[1] = a_size[0];
      }
    }

    v_move = a_wave * u_move;

    const vec3 kShift[6] = vec3[6](
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1)
    );
    float w = float(((index + 1) & 3) >> 1);
    float h = float(((index + 0) & 3) >> 1);

    vec3 pos = a_pos;
    pos += w * a_size[0] * kShift[dim + 1];
    pos += h * a_size[1] * kShift[dim + 2];
    pos -= vec3(0, a_wave * u_wave, 0);
    gl_Position = u_transform * vec4(pos, 1.0);

    int mask = int(a_mask);
    int mask_index = mask >> 5;
    int mask_value = 1 << (mask & 31);
    bool hide = (u_mask[mask_index] & mask_value) != 0;
    if (hide) gl_Position[3] = 0.0;
  }
#split
  precision highp float;
  precision highp sampler2DArray;

  uniform int u_alphaTest;
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
    vec3 index = v_uvw + vec3(v_move, v_move, 0);
    vec4 color = v_color * texture(u_texture, index);
    o_color = mix(color, vec4(u_fogColor, color[3]), fog);
    if (u_alphaTest != 0) {
      if (o_color[3] < 0.5) discard;
      o_color[3] = 1.0;
    }
  }
`;
class BasicShader extends Shader {
    constructor(gl) {
        super(gl, kBasicShader);
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
class BasicMesh {
    constructor(gl, shader, geo, meshes, hidden_meshes) {
        const index = meshes.length;
        meshes.push(this);
        this.gl = gl;
        this.shader = shader;
        this.geo = geo;
        this.meshes = meshes;
        this.hidden_meshes = hidden_meshes;
        this.vao = null;
        this.quads = null;
        this.position = Vec3.create();
        this.index = index;
        this.shown = true;
        this.mask = kDefaultMask;
    }
    draw(camera, planes) {
        const position = this.position;
        Vec3.sub(kTmpDelta, position, camera.position);
        if (this.geo.cull(kTmpDelta, planes))
            return false;
        this.prepareBuffers();
        const transform = camera.getTransformFor(position);
        const gl = this.gl;
        const n = this.geo.num_quads;
        gl.bindVertexArray(this.vao);
        gl.uniform2iv(this.shader.u_mask, this.mask);
        gl.uniformMatrix4fv(this.shader.u_transform, false, transform);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, n * 2);
        return true;
    }
    dispose() {
        this.destroyBuffers();
        this.removeFromMeshes();
        this.mask = kDefaultMask;
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
        if (shown === this.shown)
            return;
        this.removeFromMeshes();
        const meshes = shown ? this.meshes : this.hidden_meshes;
        this.index = meshes.length;
        this.shown = shown;
        meshes.push(this);
    }
    destroyBuffers() {
        const gl = this.gl;
        gl.deleteVertexArray(this.vao);
        gl.deleteBuffer(this.quads);
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
        const gl = this.gl;
        const buffer = nonnull(gl.createBuffer());
        gl.bindBuffer(ARRAY_BUFFER, buffer);
        gl.bufferData(ARRAY_BUFFER, data, gl.STATIC_DRAW);
        this.quads = buffer;
    }
    removeFromMeshes() {
        const meshes = this.shown ? this.meshes : this.hidden_meshes;
        assert(this === meshes[this.index]);
        const last = meshes.length - 1;
        if (this.index !== last) {
            const swap = meshes[last];
            meshes[this.index] = swap;
            swap.index = this.index;
        }
        meshes.pop();
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kDefaultFogColor = [0.6, 0.8, 1.0];
const kDefaultSkyColor = [0.6, 0.8, 1.0];
const kScreenOverlayShader = `
  in vec3 a_position;

  void main() {
    gl_Position = vec4(a_position, 1);
  }
#split
  precision highp float;

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
        this.a_position = this.getAttribLocation('a_position');
    }
}
;
class ScreenOverlay {
    constructor(gl) {
        this.color = new Float32Array([1, 1, 1, 1]);
        this.fog_color = new Float32Array(kDefaultFogColor);
        this.gl = gl;
        this.shader = new ScreenOverlayShader(gl);
        this.vertices = Float32Array.from([
            1, 1, 0, -1, 1, 0, -1, -1, 0,
            1, 1, 0, -1, -1, 0, 1, -1, 0
        ]);
        this.vao = null;
        this.buffer = null;
    }
    draw() {
        if (this.color[3] === 1)
            return;
        this.prepareBuffers();
        this.shader.bind();
        const gl = this.gl;
        gl.bindVertexArray(this.vao);
        gl.disable(gl.DEPTH_TEST);
        gl.uniform4fv(this.shader.u_color, this.color);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.enable(gl.DEPTH_TEST);
    }
    getFogColor() {
        return this.fog_color;
    }
    getFogDepth() {
        return this.color[3] === 1 ? 1024 : 16;
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
    prepareBuffers() {
        if (this.vao)
            return;
        const gl = this.gl;
        this.vao = nonnull(gl.createVertexArray());
        gl.bindVertexArray(this.vao);
        const location = this.shader.a_position;
        if (location === null)
            return;
        const buffer = nonnull(gl.createBuffer());
        gl.bindBuffer(ARRAY_BUFFER, buffer);
        gl.bufferData(ARRAY_BUFFER, this.vertices, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
        this.buffer = buffer;
    }
}
;
;
class Renderer {
    constructor(canvas) {
        const params = new URLSearchParams(window.location.search);
        const size = params.get('size') || 'large';
        const base = size === 'small' ? '1' : '2';
        const scale = parseFloat(params.get('scale') || base);
        const container = nonnull(canvas.parentElement);
        container.classList.add(size);
        canvas.width = canvas.clientWidth / scale;
        canvas.height = canvas.clientHeight / scale;
        this.camera = new Camera(canvas.width, canvas.height);
        const gl = nonnull(canvas.getContext('webgl2', { alpha: false }));
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        this.gl = gl;
        this.overlay = new ScreenOverlay(gl);
        this.atlas = new TextureAtlas(gl);
        this.shader = new BasicShader(gl);
        this.solid_meshes = [];
        this.water_meshes = [];
        this.hidden_meshes = [];
    }
    addBasicMesh(geo, solid) {
        const { gl, atlas, shader, hidden_meshes } = this;
        const meshes = solid ? this.solid_meshes : this.water_meshes;
        return new BasicMesh(gl, shader, geo, meshes, hidden_meshes);
    }
    render(move, wave) {
        const gl = this.gl;
        const [r, g, b] = kDefaultSkyColor;
        gl.clearColor(r, g, b, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.atlas.bind();
        this.shader.bind();
        const fog_color = this.overlay.getFogColor();
        const fog_depth = this.overlay.getFogDepth();
        gl.uniform1f(this.shader.u_move, move);
        gl.uniform1f(this.shader.u_wave, wave);
        gl.uniform1i(this.shader.u_alphaTest, 1);
        gl.uniform3fv(this.shader.u_fogColor, fog_color);
        gl.uniform1f(this.shader.u_fogDepth, fog_depth);
        let drawn = 0;
        const camera = this.camera;
        const planes = camera.getCullingPlanes();
        for (const mesh of this.solid_meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.uniform1i(this.shader.u_alphaTest, 0);
        for (const mesh of this.water_meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        gl.enable(gl.CULL_FACE);
        gl.depthMask(true);
        this.overlay.draw();
        const total = this.solid_meshes.length + this.water_meshes.length;
        return `Draw calls: ${drawn} / ${total}`;
    }
    setOverlayColor(color) {
        this.overlay.setColor(color);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { Geometry, Renderer };
//# sourceMappingURL=renderer.js.map