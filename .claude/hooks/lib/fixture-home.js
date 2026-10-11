"use strict";

const SLASH = "/";
const BACKSLASH = "\\";
const PREFIXES = Object.freeze({
  MAC: SLASH + "Users" + SLASH,
  MAC_LOWER: SLASH + "users" + SLASH,
  MAC_UPPER: SLASH + "USERS" + SLASH,
  LINUX: SLASH + "home" + SLASH,
  LINUX_UPPER: SLASH + "HOME" + SLASH,
  WIN: BACKSLASH + "Users" + BACKSLASH,
  WIN_LOWER: BACKSLASH + "users" + BACKSLASH,
  WIN_UPPER: BACKSLASH + "USERS" + BACKSLASH,
  WIN_JSON: BACKSLASH.repeat(2) + "Users" + BACKSLASH.repeat(2),
  WIN_FORWARD: SLASH + "Users" + SLASH,
  WIN_MIXED: BACKSLASH + "Users" + SLASH,
  WIN_JSON_MIXED: BACKSLASH.repeat(2) + "Users" + SLASH,
});
const FIXTURE_HOME_VERSION = 1;
const FIXTURE_HOME_TOKEN_NAMES = Object.freeze(Object.keys(PREFIXES));

class FixtureHomeError extends TypeError {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "FixtureHomeError";
    this.code = code;
  }
}

function fail(code, detail) {
  throw new FixtureHomeError(code, detail);
}

function materializeFixtureText(text) {
  if (typeof text !== "string") fail("ERR_FIXTURE_HOME_TYPE", "text must be a string");
  const result = text.replace(/\{\{FIXTURE_HOME_V1:([A-Z][A-Z0-9_]*)\}\}/g, (match, name) => {
    if (!Object.hasOwn(PREFIXES, name)) fail("ERR_FIXTURE_HOME_TOKEN", "unknown token name");
    return PREFIXES[name];
  });
  if (result.includes("{{FIXTURE_HOME")) fail("ERR_FIXTURE_HOME_TOKEN", "residual namespaced token");
  return result;
}

function isRecord(value) {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function put(record, key, value) {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
}

function cloneData(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !isRecord(value)) fail("ERR_FIXTURE_HOME_TYPE", "case must contain plain JSON data");
  if (ancestors.has(value)) fail("ERR_FIXTURE_HOME_TYPE", "cyclic case data");
  ancestors.add(value);
  const array = Array.isArray(value);
  const copy = array ? [] : Object.create(Object.getPrototypeOf(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (array) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(descriptors, String(index))) fail("ERR_FIXTURE_HOME_TYPE", "sparse array");
    }
  }
  for (const key of names) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      fail("ERR_FIXTURE_HOME_TYPE", "case properties must be enumerable data properties");
    }
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
      fail("ERR_FIXTURE_HOME_TYPE", "array has non-index properties");
    }
    put(copy, key, cloneData(descriptor.value, ancestors));
  }
  ancestors.delete(value);
  return copy;
}

function coordinateList(value) {
  if (!Array.isArray(value)) fail("ERR_FIXTURE_HOME_COORDINATE", "coordinates must be an array");
  for (const coordinate of value) {
    if (!Array.isArray(coordinate) || coordinate.some((key) =>
      typeof key !== "string" && !(typeof key === "number" && Number.isSafeInteger(key) && key >= 0))) {
      fail("ERR_FIXTURE_HOME_COORDINATE", "coordinate must contain string keys or nonnegative integer indices");
    }
  }
  return value;
}

function isPrefix(left, right) {
  return left.length <= right.length && left.every((key, index) => key === right[index]);
}

function resolveCoordinate(root, coordinate) {
  let parent = null;
  let key = null;
  let value = root;
  for (key of coordinate) {
    if ((!Array.isArray(value) && !isRecord(value)) ||
      (Array.isArray(value) ? typeof key !== "number" : typeof key !== "string") ||
      !Object.hasOwn(value, key)) {
      fail("ERR_FIXTURE_HOME_COORDINATE", "coordinate does not identify an own case field");
    }
    parent = value;
    value = value[key];
  }
  return { parent, key, value };
}

function materializeFixtureCase(input, options = {}) {
  let output = cloneData(input);
  const config = cloneData(options);
  if (!isRecord(config) || Object.keys(config).some((key) => key !== "fields" && key !== "keys")) {
    fail("ERR_FIXTURE_HOME_COORDINATE", "only fields and keys coordinate options are supported");
  }
  const fields = coordinateList(Object.hasOwn(config, "fields") ? config.fields : []);
  const keys = coordinateList(Object.hasOwn(config, "keys") ? config.keys : []);
  for (const list of [fields, keys]) {
    for (let index = 0; index < list.length; index++) {
      for (let other = 0; other < index; other++) {
        if (isPrefix(list[index], list[other]) || isPrefix(list[other], list[index])) {
          fail("ERR_FIXTURE_HOME_COORDINATE", "duplicate or overlapping coordinates");
        }
      }
    }
  }
  for (const field of fields) {
    for (const key of keys) {
      if (isPrefix(field, key)) fail("ERR_FIXTURE_HOME_COORDINATE", "field overlaps a key container");
    }
  }
  const textChanges = fields.map((coordinate) => {
    const target = resolveCoordinate(output, coordinate);
    return { ...target, replacement: materializeFixtureText(target.value) };
  });
  const keyChanges = keys.map((coordinate) => {
    const target = resolveCoordinate(output, coordinate).value;
    if (!isRecord(target)) fail("ERR_FIXTURE_HOME_TYPE", "key coordinate must identify an object");
    const destinations = new Set();
    const entries = Object.keys(target).map((key) => {
      const replacement = materializeFixtureText(key);
      if (destinations.has(replacement)) fail("ERR_FIXTURE_HOME_COLLISION", "materialized keys collide");
      destinations.add(replacement);
      return { key, replacement };
    });
    return { target, entries };
  });
  for (const change of textChanges) {
    if (change.parent === null) output = change.replacement;
    else put(change.parent, change.key, change.replacement);
  }
  for (const { target, entries } of keyChanges) {
    const values = entries.map(({ key }) => target[key]);
    for (const { key } of entries) delete target[key];
    entries.forEach(({ replacement }, index) => put(target, replacement, values[index]));
  }
  return output;
}

module.exports = {
  FIXTURE_HOME_VERSION,
  FIXTURE_HOME_TOKEN_NAMES,
  FixtureHomeError,
  materializeFixtureText,
  materializeFixtureCase,
};
