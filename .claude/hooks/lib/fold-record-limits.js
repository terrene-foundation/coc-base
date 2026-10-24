"use strict";

// Shared read/fold budget. O_APPEND's independent write-atomicity cap is 2048B
// (.claude/hooks/lib/transport-filesystem.js:97-98,260-274).
const MAX_RECORD_UTF8_BYTES = 1024 * 1024;
const MAX_RECORD_DEPTH = 64;

const sizeRejections = new WeakMap();

function assertRecordSize(actualBytes) {
  if (!Number.isSafeInteger(actualBytes) || actualBytes < 0) {
    throw new TypeError("record byte length must be a nonnegative safe integer");
  }
  if (actualBytes > MAX_RECORD_UTF8_BYTES) {
    const error = new Error(`record exceeds ${MAX_RECORD_UTF8_BYTES} UTF-8 bytes`);
    error.code = "ECOCRECORDSIZE";
    throw error;
  }
}

function createRecordSizeRejection(actualBytes) {
  if (!Number.isSafeInteger(actualBytes) || actualBytes <= MAX_RECORD_UTF8_BYTES) {
    throw new RangeError("size rejection requires an over-cap safe integer byte length");
  }
  const marker = Object.freeze({});
  sizeRejections.set(marker, actualBytes);
  return marker;
}

function parseCoordinationLog(raw, options) {
  if (typeof raw !== "string") throw new TypeError("coordination log must be a UTF-8 string");
  if (!options || !["skip", "throw"].includes(options.malformed) ||
      typeof options.objectRecordsOnly !== "boolean" ||
      !(options.maxRecords === null || (Number.isSafeInteger(options.maxRecords) && options.maxRecords > 0))) {
    throw new TypeError("coordination log parser requires explicit malformed, objectRecordsOnly and maxRecords policies");
  }
  const records = [];
  const lineIndices = [];
  const parseDropLines = [];
  const malformedLines = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (options.maxRecords !== null && records.length >= options.maxRecords) break;
    const line = lines[i];
    if (line.length === 0) continue;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_RECORD_UTF8_BYTES) {
      records.push(createRecordSizeRejection(lineBytes));
      lineIndices.push(i);
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      if (options.malformed === "throw") {
        const error = new Error("malformed JSON at log line " + (i + 1));
        error.code = "ECOCLOGJSON";
        throw error;
      }
      parseDropLines.push(i);
      malformedLines.push(i);
      continue;
    }
    if (options.objectRecordsOnly && (!record || typeof record !== "object")) {
      parseDropLines.push(i);
      continue;
    }
    records.push(record);
    lineIndices.push(i);
  }
  return { records, lineIndices, parseDropLines, malformedLines };
}

function escapeDiagnosticText(value) {
  if (typeof value !== "string") throw new TypeError("diagnostic text must be a string");
  return JSON.stringify(value).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029]/g,
    char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
}

function canonicalValueError(value, path, isKey = false) {
  const failure = text => ({ kind: "canonical-invalid", path: escapeDiagnosticText(path),
    text: `canonicalSerialize: ${escapeDiagnosticText(text)}` });
  if (isKey && value === "__proto__") {
    return failure("'__proto__' key is not representable — assigning it invokes the Object.prototype setter and silently drops the key, making canonicalization non-injective");
  }
  if (value === undefined) return failure(`undefined value at '${path}' — undefined is not JSON-serializable`);
  if (value === null) return null;
  const type = typeof value;
  if (type === "number") return Number.isFinite(value) ? null : failure(`non-finite number (NaN or Infinity) at '${path}'`);
  if (type === "boolean" || type === "object") return null;
  if (type !== "string") return failure(`unsupported type '${type}' at '${path}'`);
  if (value.includes("\uFEFF")) return failure(`BOM (U+FEFF) in string at '${path}' — non-printable`);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return failure(`non-printable control character U+${code.toString(16).padStart(4, "0").toUpperCase()} in string at '${path}'`);
    }
  }
  return null;
}

function recordStructureError(record) {
  if (sizeRejections.has(record)) {
    return { kind: "max-size", path: "$", text: `record exceeds ${MAX_RECORD_UTF8_BYTES} UTF-8 bytes` };
  }
  const stack = [{ value: record, depth: 0, path: "$" }];
  const ancestors = new Set();
  let bytes = 0;
  const failure = (kind, path, text) => ({ kind, path: escapeDiagnosticText(path), text });
  const stringBytes = (value) => value.length > MAX_RECORD_UTF8_BYTES
    ? MAX_RECORD_UTF8_BYTES + 1
    : Buffer.byteLength(JSON.stringify(value), "utf8");
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.exit) {
      ancestors.delete(node.value);
      continue;
    }
    const { value, depth, path } = node;
    if (depth > MAX_RECORD_DEPTH) {
      return failure("max-depth", path, `record exceeds depth ${MAX_RECORD_DEPTH}`);
    }
    if (typeof value === "string" && value.length > MAX_RECORD_UTF8_BYTES) {
      return failure("max-size", path, `record exceeds ${MAX_RECORD_UTF8_BYTES} UTF-8 bytes`);
    }
    if (typeof value !== "number") {
      const canonicalError = canonicalValueError(value, path);
      if (canonicalError) return canonicalError;
    }
    if (value === null) bytes += 4;
    else if (typeof value === "string") bytes += stringBytes(value);
    else if (typeof value === "number") bytes += String(value).length;
    else if (typeof value === "boolean") bytes += value ? 4 : 5;
    else if (typeof value === "object") {
      if (ancestors.has(value)) return failure("cycle", path, "record contains a cycle");
      const keys = Object.keys(value);
      bytes += 2 + Math.max(0, keys.length - 1);
      if (bytes + keys.length > MAX_RECORD_UTF8_BYTES) {
        return failure("max-size", path, `record exceeds ${MAX_RECORD_UTF8_BYTES} UTF-8 bytes`);
      }
      ancestors.add(value);
      stack.push({ value, exit: true });
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i];
        if (!Array.isArray(value)) {
          if (key.length > MAX_RECORD_UTF8_BYTES) {
            return failure("max-size", path, `record exceeds ${MAX_RECORD_UTF8_BYTES} UTF-8 bytes`);
          }
          const keyError = canonicalValueError(key, `${path}.${key}`, true);
          if (keyError) return keyError;
        }
        if (!Array.isArray(value)) bytes += stringBytes(key) + 1;
        if (bytes > MAX_RECORD_UTF8_BYTES) break;
        stack.push({ value: value[key], depth: depth + 1, path: `${path}.${key}` });
      }
    } else {
      return failure("non-json", path, `record contains unsupported type ${typeof value}`);
    }
    if (bytes > MAX_RECORD_UTF8_BYTES) {
      return failure("max-size", path, `record exceeds ${MAX_RECORD_UTF8_BYTES} UTF-8 bytes`);
    }
  }
  return null;
}

module.exports = { MAX_RECORD_UTF8_BYTES, MAX_RECORD_DEPTH, recordStructureError,
  canonicalValueError, createRecordSizeRejection, assertRecordSize, parseCoordinationLog, escapeDiagnosticText };
