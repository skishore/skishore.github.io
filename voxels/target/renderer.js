import { assert, nonnull } from './base.js';
import { Mat4, Vec3 } from './base.js';
//////////////////////////////////////////////////////////////////////////////
// The graphics engine:
class Camera {
    constructor(width, height) {
        this.pitch = 0;
        this.heading = 0;
        this.zoom = 0;
        this.direction = Vec3.from(0, 0, 1);
        this.position = Vec3.create();
        this.last_dx = 0;
        this.last_dy = 0;
        this.position_for = Vec3.create();
        this.transform_for = Mat4.create();
        this.transform = Mat4.create();
        this.projection = Mat4.create();
        this.view = Mat4.create();
        const aspect = height ? width / height : 1;
        Mat4.perspective(this.projection, 3 * Math.PI / 8, aspect, 0.01);
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
    getTransform() {
        Mat4.view(this.view, this.position, this.direction);
        Mat4.multiply(this.transform, this.projection, this.view);
        return this.transform;
    }
    getTransformFor(offset) {
        Vec3.sub(this.position_for, this.position, offset);
        Mat4.view(this.view, this.position_for, this.direction);
        Mat4.multiply(this.transform_for, this.projection, this.view);
        return this.transform_for;
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
class Context {
    constructor(gl) {
        this.gl = gl;
        this.array_buffer = null;
        this.element_array_buffer = null;
        this.program = null;
        this.texture_2d_array = null;
        this.vertex_array = null;
    }
    bindArrayBuffer(buffer) {
        if (buffer === this.array_buffer)
            return;
        this.gl.bindBuffer(ARRAY_BUFFER, buffer);
        this.element_array_buffer = buffer;
    }
    bindElementArrayBuffer(buffer) {
        if (buffer === this.element_array_buffer)
            return;
        this.gl.bindBuffer(ELEMENT_ARRAY_BUFFER, buffer);
        this.element_array_buffer = buffer;
    }
    bindProgram(program) {
        if (program === this.program)
            return;
        this.gl.useProgram(program);
        this.program = program;
    }
    bindTexture2DArray(texture) {
        if (texture === this.texture_2d_array)
            return;
        this.gl.bindTexture(TEXTURE_2D_ARRAY, texture);
        this.texture_2d_array = texture;
    }
    bindVertexArray(vao) {
        if (vao === this.vertex_array)
            return;
        this.gl.bindVertexArray(vao);
        this.vertex_array = vao;
    }
}
;
;
class Shader {
    constructor(context, source) {
        this.context = context;
        const gl = context.gl;
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
        this.context.bindProgram(this.program);
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
        const gl = this.context.gl;
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
        const gl = this.context.gl;
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
    constructor(context) {
        const gl = context.gl;
        const texture = nonnull(gl.createTexture());
        this.context = context;
        this.texture = texture;
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
        this.context.bindTexture2DArray(this.texture);
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
        const gl = this.context.gl;
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
const kTmpBound = [0, 0, 0, 0];
class Geometry {
    constructor(indices, vertices, num_indices, num_vertices) {
        this.indices = indices;
        this.vertices = vertices;
        this.num_indices = num_indices;
        this.num_vertices = num_vertices;
        this.lower_bound = Vec3.create();
        this.upper_bound = Vec3.create();
        this.bounds = [];
    }
    clear() {
        this.num_indices = 0;
        this.num_vertices = 0;
        this.bounds.length = 0;
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
    cull(transform) {
        this.computeBounds();
        const { lower_bound, upper_bound } = this;
        let a = 0, b = 0, c = 0, d = 0;
        for (const bound of this.bounds) {
            Mat4.multiplyVec4(kTmpBound, transform, bound);
            const x = kTmpBound[0];
            const y = kTmpBound[1];
            const w = kTmpBound[3];
            if (x > w)
                a++;
            if (x < -w)
                b++;
            if (y > w)
                c++;
            if (y < -w)
                d++;
        }
        return (a | b | c | d) >= 8;
    }
    computeBounds() {
        if (this.bounds.length > 0)
            return;
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
        for (let i = 0; i < 8; i++) {
            const bound = [0, 0, 0, 1];
            for (let j = 0; j < 3; j++) {
                bound[j] = (i & (1 << j)) ? lower_bound[j] : upper_bound[j];
            }
            this.bounds.push(bound);
        }
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
Geometry.Stride = 16;
;
//////////////////////////////////////////////////////////////////////////////
const kBasicShader = `
  uniform mat4 u_transform;
  in vec3 a_position;
  in vec4 a_color;
  in vec3 a_uvw;
  out vec4 v_color;
  out vec3 v_uvw;

  void main() {
    v_color = a_color;
    v_uvw = a_uvw;
    gl_Position = u_transform * vec4(a_position, 1.0);
  }
#split
  precision highp float;
  precision highp sampler2DArray;

  uniform sampler2DArray u_texture;
  in vec4 v_color;
  in vec3 v_uvw;
  out vec4 o_color;

  void main() {
    const float kFogHalfLife = 256.0;
    const vec3 kFogColor = vec3(0.2, 0.5, 0.8);

    float fog = clamp(exp2(-kFogHalfLife * gl_FragCoord.w), 0.0, 1.0);
    vec4 color = v_color * texture(u_texture, v_uvw);
    o_color = mix(color, vec4(kFogColor, color[3]), fog);
    if (o_color[3] < 0.5) discard;
  }
`;
class BasicMesh {
    constructor(context, atlas, shader, meshes, geo) {
        this.index = 0;
        this.context = context;
        this.atlas = atlas;
        this.shader = shader;
        this.meshes = meshes;
        this.geo = geo;
        this.vao = null;
        this.uniform = shader.getUniformLocation('u_transform');
        this.indices = null;
        this.vertices = null;
        this.position = Vec3.create();
        this.index = this.meshes.length;
        this.meshes.push(this);
    }
    draw(camera) {
        const transform = camera.getTransformFor(this.position);
        if (this.geo.cull(transform))
            return false;
        this.prepareBuffers();
        this.atlas.bind();
        this.shader.bind();
        const context = this.context;
        context.bindVertexArray(this.vao);
        context.bindElementArrayBuffer(this.indices);
        const gl = context.gl;
        gl.uniformMatrix4fv(this.uniform, false, transform);
        gl.drawElements(gl.TRIANGLES, this.geo.num_indices, gl.UNSIGNED_INT, 0);
        return true;
    }
    dispose() {
        this.destroyBuffers();
        assert(this === this.meshes[this.index]);
        const last = this.meshes.length - 1;
        if (this.index !== last) {
            const swap = this.meshes[last];
            this.meshes[this.index] = swap;
            swap.index = this.index;
        }
        this.meshes.pop();
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
    destroyBuffers() {
        const gl = this.context.gl;
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
        const gl = this.context.gl;
        this.vao = nonnull(gl.createVertexArray());
        this.context.bindVertexArray(this.vao);
        const data = this.geo.vertices;
        this.prepareIndices(this.geo.indices);
        this.prepareVertices(this.geo.vertices);
        this.prepareAttribute('a_position', data, 3, Geometry.PositionsOffset);
        this.prepareAttribute('a_color', data, 4, Geometry.ColorsOffset);
        this.prepareAttribute('a_uvw', data, 3, Geometry.UVWsOffset);
    }
    prepareAttribute(name, data, size, offset_in_floats) {
        const gl = this.context.gl;
        const location = this.shader.getAttribLocation(name);
        if (location === null)
            return;
        const offset = 4 * offset_in_floats;
        const stride = 4 * Geometry.Stride;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }
    prepareIndices(data) {
        const gl = this.context.gl;
        const buffer = nonnull(gl.createBuffer());
        this.context.bindElementArrayBuffer(buffer);
        gl.bufferData(ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
        this.indices = buffer;
    }
    prepareVertices(data) {
        const gl = this.context.gl;
        const buffer = nonnull(gl.createBuffer());
        this.context.bindArrayBuffer(buffer);
        gl.bufferData(ARRAY_BUFFER, data, gl.STATIC_DRAW);
        this.vertices = buffer;
    }
}
;
//////////////////////////////////////////////////////////////////////////////
const kScreenOverlayShader = `
  in vec3 a_position;

  void main() {
    gl_Position = vec4(a_position, 1);
  }
#split
  precision highp float;
  precision highp sampler2DArray;

  uniform vec4 u_color;

  out vec4 o_color;

  void main() {
    o_color = u_color;
  }
`;
class ScreenOverlay {
    constructor(context) {
        this.color = new Float32Array([0, 0, 0, 0]);
        this.context = context;
        this.shader = new Shader(context, kScreenOverlayShader);
        this.uniform = this.shader.getUniformLocation('u_color');
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
        const context = this.context;
        context.bindVertexArray(this.vao);
        const gl = context.gl;
        gl.disable(gl.DEPTH_TEST);
        gl.uniform4fv(this.uniform, this.color);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.enable(gl.DEPTH_TEST);
    }
    setColor(color) {
        for (let i = 0; i < 4; i++)
            this.color[i] = color[i];
    }
    prepareBuffers() {
        if (this.vao)
            return;
        const gl = this.context.gl;
        this.vao = nonnull(gl.createVertexArray());
        this.context.bindVertexArray(this.vao);
        const location = this.shader.getAttribLocation('a_position');
        if (location === null)
            return;
        const buffer = nonnull(gl.createBuffer());
        this.context.bindArrayBuffer(buffer);
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
        this.context = new Context(gl);
        this.overlay = new ScreenOverlay(this.context);
        this.atlas = new TextureAtlas(this.context);
        this.shader = new Shader(this.context, kBasicShader);
        this.solid_meshes = [];
        this.water_meshes = [];
    }
    addBasicMesh(geo, solid) {
        const { context, atlas, shader } = this;
        const meshes = solid ? this.solid_meshes : this.water_meshes;
        return new BasicMesh(context, atlas, shader, meshes, geo);
    }
    render() {
        const gl = this.context.gl;
        gl.clearColor(0.8, 0.9, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        let drawn = 0;
        const camera = this.camera;
        for (const mesh of this.solid_meshes) {
            if (mesh.draw(camera))
                drawn++;
        }
        gl.disable(gl.CULL_FACE);
        for (const mesh of this.water_meshes) {
            if (mesh.draw(camera))
                drawn++;
        }
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