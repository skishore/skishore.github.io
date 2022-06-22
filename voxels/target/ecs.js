import { assert } from './base.js';
;
const kNoEntity = 0;
;
class ComponentStore {
    constructor(component, definition) {
        this.component = component;
        this.definition = definition;
        this.lookup = new Map();
        this.states = [];
    }
    get(entity) {
        const result = this.lookup.get(entity);
        return result ? result : null;
    }
    getX(entity) {
        const result = this.lookup.get(entity);
        if (!result)
            throw new Error(`${entity} missing ${this.component}`);
        return result;
    }
    add(entity) {
        if (this.lookup.has(entity)) {
            throw new Error(`Duplicate for ${entity}: ${this.component}`);
        }
        const index = this.states.length;
        const state = this.definition.init();
        state.id = entity;
        state.index = index;
        this.lookup.set(entity, state);
        this.states.push(state);
        const callback = this.definition.onAdd;
        if (callback)
            callback(state);
        return state;
    }
    remove(entity) {
        const state = this.lookup.get(entity);
        if (!state)
            return;
        this.lookup.delete(entity);
        const popped = this.states.pop();
        assert(popped.index === this.states.length);
        if (popped.id === entity)
            return;
        const index = state.index;
        assert(index < this.states.length);
        this.states[index] = popped;
        popped.index = index;
        const callback = this.definition.onRemove;
        if (callback)
            callback(state);
    }
    render(dt) {
        const callback = this.definition.onRender;
        if (!callback)
            throw new Error(`render called: ${this.component}`);
        callback(dt, this.states);
    }
    update(dt) {
        const callback = this.definition.onUpdate;
        if (!callback)
            throw new Error(`update called: ${this.component}`);
        callback(dt, this.states);
    }
}
;
class EntityComponentSystem {
    constructor() {
        this.last = 0;
        this.components = new Map();
        this.onRenders = [];
        this.onUpdates = [];
    }
    addEntity() {
        return this.last = (this.last + 1);
    }
    removeEntity(entity) {
        this.components.forEach(x => x.remove(entity));
    }
    registerComponent(component, definition) {
        const exists = this.components.has(component);
        if (exists)
            throw new Error(`Duplicate component: ${component}`);
        const store = new ComponentStore(component, definition);
        this.components.set(component, store);
        if (definition.onRender)
            this.onRenders.push(store);
        if (definition.onUpdate)
            this.onUpdates.push(store);
        return store;
    }
    render(dt) {
        for (const store of this.onRenders)
            store.render(dt);
    }
    update(dt) {
        for (const store of this.onUpdates)
            store.update(dt);
    }
}
;
//////////////////////////////////////////////////////////////////////////////
export { ComponentStore, EntityComponentSystem, kNoEntity };
//# sourceMappingURL=ecs.js.map