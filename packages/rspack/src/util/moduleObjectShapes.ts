import binding from '@rspack/binding';
import '../Module';
import '../NormalModule';
import '../ContextModule';
import '../ExternalModule';
import '../ConcatenatedModule';

type Descriptor = PropertyDescriptor;
interface Template {
  prototype: object | null;
  keys: PropertyKey[];
  descriptors: Descriptor[];
  dataSlots: number[];
}
interface Defaults {
  template: Template;
  values: unknown[];
}
interface StateStore {
  seed(object: object): void;
  allow(object: object, key: PropertyKey): void;
  check?: unknown;
}

const ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const isExtensible = Object.isExtensible;
const sameValue = Object.is;
const defaults = new WeakMap<object, Defaults>();
const templates = new WeakMap<object, Template[]>();
const allowed = new WeakMap<object, Map<PropertyKey, Descriptor>>();
const store = binding.getModuleObjectStateStore() as StateStore;
const sameDescriptor = (
  actual: Descriptor | undefined,
  expected: Descriptor,
): boolean =>
  actual !== undefined &&
  actual.enumerable === expected.enumerable &&
  actual.configurable === expected.configurable &&
  actual.writable === expected.writable &&
  actual.get === expected.get &&
  actual.set === expected.set &&
  'value' in actual === 'value' in expected;

// Native construction calls this before the wrapper is exposed to user code.
store.seed = (object) => {
  const prototype = prototypeOf(object) as object;
  const keys = ownKeys(object);
  const descriptors = keys.map((key) => descriptor(object, key)!);
  const variants = templates.get(prototype) || [];
  let template = variants.find(
    (candidate) =>
      keys.length === candidate.keys.length &&
      keys.every(
        (key, index) =>
          key === candidate.keys[index] &&
          sameDescriptor(descriptors[index], candidate.descriptors[index]),
      ),
  );
  if (!template) {
    let nextSlot = 0;
    template = {
      prototype,
      keys,
      descriptors,
      dataSlots: descriptors.map((value) =>
        'value' in value ? nextSlot++ : -1,
      ),
    };
    variants.push(template);
    templates.set(prototype, variants);
  }
  defaults.set(object, {
    template,
    values: descriptors
      .filter((value) => 'value' in value)
      .map((value) => value.value),
  });
};
// Native code calls this just after installing a core-owned lazy property.
store.allow = (object, key) => {
  const before = defaults.get(object);
  if (!before || before.template.keys.includes(key)) return;
  const installed = descriptor(object, key);
  if (!installed) return;
  let properties = allowed.get(object);
  if (!properties) allowed.set(object, (properties = new Map()));
  properties.set(key, installed);
};
delete store.check;

function isPristine(object: object): boolean {
  const before = defaults.get(object);
  if (
    !before ||
    !isExtensible(object) ||
    prototypeOf(object) !== before.template.prototype
  )
    return false;
  const properties = allowed.get(object);
  if (
    ownKeys(object).length !==
    before.template.keys.length + (properties?.size ?? 0)
  )
    return false;
  for (let index = 0; index < before.template.keys.length; index++) {
    const actual = descriptor(object, before.template.keys[index]);
    if (!sameDescriptor(actual, before.template.descriptors[index]))
      return false;
    const slot = before.template.dataSlots[index];
    if (slot !== -1 && !sameValue(actual!.value, before.values[slot]))
      return false;
  }
  if (properties) {
    for (const [key, expected] of properties) {
      const actual = descriptor(object, key);
      if (
        !sameDescriptor(actual, expected) ||
        !sameValue(actual!.value, expected.value)
      )
        return false;
    }
  }
  return true;
}

const prototypes = new Map<
  object,
  {
    prototype: object | null;
    keys: PropertyKey[];
    descriptors: Descriptor[];
    extensible: boolean;
  }
>();
for (const constructor of [
  binding.Module,
  binding.NormalModule,
  binding.ContextModule,
  binding.ExternalModule,
  binding.ConcatenatedModule,
]) {
  let object: object | null = constructor.prototype;
  while (object && !prototypes.has(object)) {
    const keys = ownKeys(object);
    const prototype = prototypeOf(object) as object | null;
    prototypes.set(object, {
      prototype,
      keys,
      descriptors: keys.map((key) => descriptor(object!, key)!),
      extensible: isExtensible(object),
    });
    object = prototype;
  }
}

export function checkModuleObjectShapes(objects: object[]): {
  reusable: boolean;
  checked: number;
  custom: number;
  prototypeChanged: boolean;
} {
  let prototypeChanged = false;
  for (const [object, before] of prototypes) {
    const keys = ownKeys(object);
    if (
      prototypeOf(object) !== before.prototype ||
      isExtensible(object) !== before.extensible ||
      keys.length !== before.keys.length
    ) {
      prototypeChanged = true;
      break;
    }
    for (let index = 0; index < keys.length; index++) {
      const actual = descriptor(object, keys[index]);
      if (
        keys[index] !== before.keys[index] ||
        !sameDescriptor(actual, before.descriptors[index]) ||
        !sameValue(actual!.value, before.descriptors[index].value)
      ) {
        prototypeChanged = true;
        break;
      }
    }
    if (prototypeChanged) break;
  }
  let custom = 0;
  for (const object of objects) if (!isPristine(object)) custom++;
  return {
    reusable: !prototypeChanged && custom === 0,
    checked: objects.length,
    custom,
    prototypeChanged,
  };
}
