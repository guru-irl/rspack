import binding, { type JsModuleShapeCheckResult } from '@rspack/binding';

export type ModuleObjectShapeCheck = (
  objects: object[],
) => JsModuleShapeCheckResult;

interface CoreMember {
  readonly version: string;
  readonly prototype: object;
  readonly key: PropertyKey;
}

interface ShapeState {
  readonly version: string;
  readonly coreMembers: WeakMap<object, CoreMember>;
  check?: ModuleObjectShapeCheck;
}

const stateKey = Symbol.for('rspack.moduleObjectShapeState');
interface StateStore {
  seed(object: object): void;
  allow(object: object, key: PropertyKey): void;
  check?: unknown;
  [stateKey]?: ShapeState;
}

export const moduleObjectShapeStore =
  binding.getModuleObjectStateStore() as StateStore;
const existingState = moduleObjectShapeStore[stateKey];
export const moduleObjectShapeState: ShapeState = existingState ?? {
  version: RSPACK_VERSION,
  coreMembers: new WeakMap(),
};
if (!existingState) {
  Object.defineProperty(moduleObjectShapeStore, stateKey, {
    value: moduleObjectShapeState,
  });
}

export function defineCoreModuleProperty(
  object: object,
  key: PropertyKey,
  property: PropertyDescriptor,
): void {
  if (
    moduleObjectShapeState.version === RSPACK_VERSION &&
    typeof property.value === 'function'
  ) {
    moduleObjectShapeState.coreMembers.set(property.value, {
      version: RSPACK_VERSION,
      prototype: object,
      key,
    });
  }
  Object.defineProperty(object, key, property);
}
