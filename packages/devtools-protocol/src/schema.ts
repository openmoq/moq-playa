/** Small JSON readers. Object readers copy only declared fields. */
export type Reader<T> = (value: unknown, path: string) => T;
export type Value<R extends Reader<unknown>> = ReturnType<R>;

export class InvalidField extends Error {
  constructor(readonly path: string, expected: string) {
    super(`Expected ${expected}`);
  }
}

export function text(max = 2048, pattern?: RegExp): Reader<string> {
  return (value, path) => {
    if (typeof value !== 'string' || value.length > max || (pattern && !pattern.test(value))) {
      throw new InvalidField(path, 'bounded text in the required format');
    }
    return value;
  };
}

export const number: Reader<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidField(path, 'finite number');
  return value;
};

export const nonnegative: Reader<number> = (value, path) => {
  const result = number(value, path);
  if (result < 0) throw new InvalidField(path, 'nonnegative number');
  return result;
};

export const integer: Reader<number> = (value, path) => {
  const result = nonnegative(value, path);
  if (!Number.isSafeInteger(result)) throw new InvalidField(path, 'nonnegative safe integer');
  return result;
};

export const boolean: Reader<boolean> = (value, path) => {
  if (typeof value !== 'boolean') throw new InvalidField(path, 'boolean');
  return value;
};

export function oneOf<const T extends readonly (string | number)[]>(...values: T): Reader<T[number]> {
  return (value, path) => {
    if (!values.some(candidate => candidate === value)) throw new InvalidField(path, 'supported value');
    return value as T[number];
  };
}

export function nullable<T>(read: Reader<T>): Reader<T | null> {
  return (value, path) => value === null ? null : read(value, path);
}

export function array<T>(read: Reader<T>, max = 2048): Reader<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > max) throw new InvalidField(path, 'bounded array');
    return value.map((item, index) => read(item, `${path}[${index}]`));
  };
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InvalidField(path, 'object');
  return value as Record<string, unknown>;
}

export function object<const S extends Record<string, Reader<unknown>>>(shape: S):
Reader<{ readonly [K in keyof S]: Value<S[K]> }> {
  return (value, path) => {
    const source = record(value, path);
    const result: Record<string, unknown> = {};
    for (const [key, read] of Object.entries(shape)) result[key] = read(source[key], `${path}.${key}`);
    return result as { readonly [K in keyof S]: Value<S[K]> };
  };
}

export const id = text(128, /^[a-zA-Z0-9._:-]+$/);
export const uint64: Reader<string> = (value, path) => {
  const result = text(20, /^(0|[1-9][0-9]*)$/)(value, path);
  if (BigInt(result) > 0xffffffffffffffffn) throw new InvalidField(path, 'unsigned 64-bit decimal string');
  return result;
};

/** Namespace/name bytes use canonical lowercase hex, including the empty string. */
export const bytes = text(262144, /^(?:[0-9a-f]{2})*$/);

export function refined<T>(read: Reader<T>, check: (value: T) => boolean, expected: string): Reader<T> {
  return (value, path) => {
    const result = read(value, path);
    if (!check(result)) throw new InvalidField(path, expected);
    return result;
  };
}
