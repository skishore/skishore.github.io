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
const ELEMENT_ARRAY_BUFFER = WebGL2RenderingContext.ELEMENT_ARRAY_BUFFER;
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
//////////////////////////////////////////////////////////////////////////////
class TextureAtlas {
    constructor(gl) {
        this.gl = gl;
        this.texture = nonnull(gl.createTexture());
        this.canvas = null;
        this.urls = new Map();
        this.data = new Uint8Array();
        this.nextResult = 0;
        this.bind();
        const id = TEXTURE_2D_ARRAY;
        gl.texParameteri(id, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(id, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    }
    addImage(url) {
        const existing = this.urls.get(url);
        if (existing !== undefined)
            return existing;
        const result = ++this.nextResult;
        this.urls.set(url, result);
        const image = new Image();
        image.addEventListener('load', () => this.loaded(result, image));
        image.src = url;
        return result;
    }
    bind() {
        this.gl.bindTexture(TEXTURE_2D_ARRAY, this.texture);
    }
    loaded(index, image) {
        if (this.canvas === null) {
            const size = image.width;
            const element = document.createElement('canvas');
            element.width = element.height = size;
            const canvas = nonnull(element.getContext('2d'));
            this.canvas = canvas;
        }
        const canvas = this.canvas;
        const size = canvas.canvas.width;
        if (size !== image.width || size !== image.height) {
            const { width, height, src } = image;
            throw new Error(`Mismatch: ${size} vs. ${src}: (${width} x ${height})`);
        }
        canvas.clearRect(0, 0, size, size);
        canvas.drawImage(image, 0, 0);
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
        const data = this.data;
        for (let i = 0; i < length; i++) {
            data[i + offset] = pixels[i];
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
    constructor(indices, vertices, num_indices, num_vertices) {
        this.indices = indices;
        this.vertices = vertices;
        this.num_indices = num_indices;
        this.num_vertices = num_vertices;
        this.lower_bound = Vec3.create();
        this.upper_bound = Vec3.create();
        this.bounds = Array(8).fill(null);
        for (let i = 0; i < 8; i++)
            this.bounds[i] = Vec3.create();
        this.dirty = true;
    }
    clear() {
        this.num_indices = 0;
        this.num_vertices = 0;
        this.dirty = true;
    }
    allocateIndices(n) {
        this.num_indices = n;
        const needed = n;
        const length = this.indices.length;
        if (length >= needed)
            return;
        const expanded = new Uint32Array(Math.max(length * 2, needed));
        for (let i = 0; i < length; i++)
            expanded[i] = this.indices[i];
        this.indices = expanded;
    }
    allocateVertices(n) {
        this.num_vertices = n;
        const needed = n * Geometry.Stride;
        const length = this.vertices.length;
        if (length >= needed)
            return;
        const expanded = new Float32Array(Math.max(length * 2, needed));
        for (let i = 0; i < length; i++)
            expanded[i] = this.vertices[i];
        this.vertices = expanded;
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
        const stride = Geometry.Stride;
        const vertices = this.vertices;
        const start = Geometry.PositionsOffset;
        const limit = start + this.num_vertices * stride;
        for (let i = start; i < limit; i += stride) {
            const x = vertices[i + 0], y = vertices[i + 1], z = vertices[i + 2];
            if (lower_bound[0] > x)
                lower_bound[0] = x;
            if (lower_bound[1] > y)
                lower_bound[1] = y;
            if (lower_bound[2] > z)
                lower_bound[2] = z;
            if (upper_bound[0] < x)
                upper_bound[0] = x;
            if (upper_bound[1] < y)
                upper_bound[1] = y;
            if (upper_bound[2] < z)
                upper_bound[2] = z;
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
        const { num_indices, num_vertices } = geo;
        const indices = geo.indices.slice(0, num_indices);
        const vertices = geo.vertices.slice(0, num_vertices * Geometry.Stride);
        return new Geometry(indices, vertices, num_indices, num_vertices);
    }
    static empty() {
        return new Geometry(new Uint32Array(), new Float32Array(), 0, 0);
    }
}
Geometry.PositionsOffset = 0;
Geometry.NormalsOffset = 3;
Geometry.ColorsOffset = 6;
Geometry.UVWsOffset = 10;
Geometry.WaveOffset = 13;
Geometry.MaskOffset = 14;
Geometry.Stride = 16;
;
//////////////////////////////////////////////////////////////////////////////
const kBasicShader = `
  uniform int u_mask;
  uniform float u_move;
  uniform float u_wave;
  uniform mat4 u_transform;
  in vec3 a_position;
  in vec4 a_color;
  in vec3 a_uvw;
  in float a_wave;
  in float a_mask;
  out vec4 v_color;
  out vec3 v_uvw;
  out float v_move;

  void main() {
    v_color = a_color;
    v_uvw = a_uvw;
    v_move = a_wave * u_move;
    float wave = a_wave * u_wave;
    vec3 adjusted = a_position - vec3(0, wave, 0);
    gl_Position = u_transform * vec4(adjusted, 1.0);
    if ((u_mask & int(a_mask)) != 0) gl_Position[3] = 0.0;
  }
#split
  precision highp float;
  precision highp sampler2DArray;

  uniform vec3 u_fogColor;
  uniform float u_fogDepth;
  uniform sampler2DArray u_texture;
  in vec4 v_color;
  in vec3 v_uvw;
  in float v_move;
  out vec4 o_color;

  void main() {
    float fog = clamp(exp2(-u_fogDepth * gl_FragCoord.w), 0.0, 1.0);
    vec3 index = v_uvw + vec3(v_move, v_move, 0);
    vec4 color = v_color * texture(u_texture, index);
    o_color = mix(color, vec4(u_fogColor, color[3]), fog);
    if (o_color[3] < 0.25) discard;
  }
`;
class BasicShader extends Shader {
    constructor(gl) {
        super(gl, kBasicShader);
        this.u_mask = this.getUniformLocation('u_mask');
        this.u_move = this.getUniformLocation('u_move');
        this.u_wave = this.getUniformLocation('u_wave');
        this.u_transform = this.getUniformLocation('u_transform');
        this.u_fogColor = this.getUniformLocation('u_fogColor');
        this.u_fogDepth = this.getUniformLocation('u_fogDepth');
        this.a_position = this.getAttribLocation('a_position');
        this.a_color = this.getAttribLocation('a_color');
        this.a_uvw = this.getAttribLocation('a_uvw');
        this.a_wave = this.getAttribLocation('a_wave');
        this.a_mask = this.getAttribLocation('a_mask');
    }
}
;
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
        this.indices = null;
        this.vertices = null;
        this.position = Vec3.create();
        this.index = index;
        this.shown = true;
        this.mask = 0;
    }
    draw(camera, planes) {
        const position = this.position;
        Vec3.sub(kTmpDelta, position, camera.position);
        if (this.geo.cull(kTmpDelta, planes))
            return false;
        this.prepareBuffers();
        const transform = camera.getTransformFor(position);
        const gl = this.gl;
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(ELEMENT_ARRAY_BUFFER, this.indices);
        gl.uniform1i(this.shader.u_mask, this.mask);
        gl.uniformMatrix4fv(this.shader.u_transform, false, transform);
        gl.drawElements(gl.TRIANGLES, this.geo.num_indices, gl.UNSIGNED_INT, 0);
        return true;
    }
    dispose() {
        this.destroyBuffers();
        this.removeFromMeshes();
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
        gl.deleteBuffer(this.indices);
        gl.deleteBuffer(this.vertices);
        this.vao = null;
        this.indices = null;
        this.vertices = null;
    }
    prepareBuffers() {
        if (this.vao)
            return;
        const { gl, shader } = this;
        this.vao = nonnull(gl.createVertexArray());
        gl.bindVertexArray(this.vao);
        const data = this.geo.vertices;
        this.prepareIndices(this.geo.indices);
        this.prepareVertices(this.geo.vertices);
        this.prepareAttribute(shader.a_position, data, 3, Geometry.PositionsOffset);
        this.prepareAttribute(shader.a_color, data, 4, Geometry.ColorsOffset);
        this.prepareAttribute(shader.a_uvw, data, 3, Geometry.UVWsOffset);
        this.prepareAttribute(shader.a_wave, data, 1, Geometry.WaveOffset);
        this.prepareAttribute(shader.a_mask, data, 1, Geometry.MaskOffset);
    }
    prepareAttribute(location, data, size, offset_in_floats) {
        if (location === null)
            return;
        const gl = this.gl;
        const offset = 4 * offset_in_floats;
        const stride = 4 * Geometry.Stride;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }
    prepareIndices(data) {
        const gl = this.gl;
        const buffer = nonnull(gl.createBuffer());
        gl.bindBuffer(ELEMENT_ARRAY_BUFFER, buffer);
        gl.bufferData(ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
        this.indices = buffer;
    }
    prepareVertices(data) {
        const gl = this.gl;
        const buffer = nonnull(gl.createBuffer());
        gl.bindBuffer(ARRAY_BUFFER, buffer);
        gl.bufferData(ARRAY_BUFFER, data, gl.STATIC_DRAW);
        this.vertices = buffer;
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
const kDefaultFogColor = [0.2, 0.5, 0.8];
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
        return this.color[3] === 1 ? 4096 : 16;
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
        gl.clearColor(0.8, 0.9, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.atlas.bind();
        this.shader.bind();
        const fog_color = this.overlay.getFogColor();
        const fog_depth = this.overlay.getFogDepth();
        gl.uniform1f(this.shader.u_move, move);
        gl.uniform1f(this.shader.u_wave, wave);
        gl.uniform3fv(this.shader.u_fogColor, fog_color);
        gl.uniform1f(this.shader.u_fogDepth, fog_depth);
        let drawn = 0;
        const camera = this.camera;
        const planes = camera.getCullingPlanes();
        for (const mesh of this.solid_meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        gl.disable(gl.CULL_FACE);
        gl.depthMask(false);
        for (const mesh of this.water_meshes) {
            if (mesh.draw(camera, planes))
                drawn++;
        }
        gl.depthMask(true);
        gl.enable(gl.CULL_FACE);
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