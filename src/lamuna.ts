import { deflate, inflate } from "pako";
import builtinTemplates from "./templates.json";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export type Field = {
  number: number;
  wire: number;
  value?: number | string | Uint8Array;
  raw?: Uint8Array;
};

export type ItemText = {
  name: string;
  code: string;
  batch: string;
  validMonths: number;
  year: number;
  month: number;
  curveCount: number;
  pointCount: number;
  concs: number[];
  resps: number[];
  aratio: number[];
};

export type TemplateRecord = {
  file: string;
  name: string;
  batch: string;
  code: string;
  validMonths: number;
  year: number;
  month: number;
  payload: string;
  source: "内置模板" | "手动模板";
};

export type TemplateIndex = Map<string, TemplateRecord[]>;

type RawTemplate = Omit<TemplateRecord, "source">;

export const builtInTemplates: TemplateRecord[] = (builtinTemplates as RawTemplate[]).map((template) => ({
  ...template,
  source: "内置模板",
}));

function readVarint(buffer: Uint8Array, offset: number): [number, number] {
  let multiplier = 1;
  let value = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return [value, offset];
    }
    multiplier *= 128;
  }
  throw new Error("protobuf varint 未结束");
}

function writeVarint(input: number): Uint8Array {
  if (!Number.isFinite(input) || input < 0) {
    throw new Error(`非法 varint: ${input}`);
  }
  let value = Math.floor(input);
  const bytes: number[] = [];
  while (true) {
    const current = value % 128;
    value = Math.floor(value / 128);
    bytes.push(value > 0 ? current | 0x80 : current);
    if (value <= 0) {
      return new Uint8Array(bytes);
    }
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function parseMessage(buffer: Uint8Array): Field[] {
  const fields: Field[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const [key, nextOffset] = readVarint(buffer, offset);
    offset = nextOffset;
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const [value, afterValue] = readVarint(buffer, offset);
      offset = afterValue;
      fields.push({ number, wire, value });
    } else if (wire === 1) {
      const raw = buffer.slice(offset, offset + 8);
      offset += 8;
      fields.push({ number, wire, value: raw, raw });
    } else if (wire === 2) {
      const [size, afterSize] = readVarint(buffer, offset);
      offset = afterSize;
      const raw = buffer.slice(offset, offset + size);
      offset += size;
      fields.push({ number, wire, value: textDecoder.decode(raw), raw });
    } else if (wire === 5) {
      const raw = buffer.slice(offset, offset + 4);
      offset += 4;
      fields.push({ number, wire, value: raw, raw });
    } else {
      throw new Error(`暂不支持 protobuf wire type ${wire}`);
    }
  }
  return fields;
}

export function serializeMessage(fields: Field[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const field of fields) {
    chunks.push(writeVarint(field.number * 8 + field.wire));
    if (field.wire === 0) {
      chunks.push(writeVarint(Number(field.value ?? 0)));
    } else if (field.wire === 1 || field.wire === 5) {
      if (!field.raw) {
        throw new Error(`字段 ${field.number} 缺少原始字节`);
      }
      chunks.push(field.raw);
    } else if (field.wire === 2) {
      let raw: Uint8Array;
      if (field.raw) {
        raw = field.raw;
      } else if (typeof field.value === "string") {
        raw = textEncoder.encode(field.value);
      } else if (field.value instanceof Uint8Array) {
        raw = field.value;
      } else {
        throw new Error(`字段 ${field.number} 的值无效`);
      }
      chunks.push(writeVarint(raw.length), raw);
    } else {
      throw new Error(`暂不支持 protobuf wire type ${field.wire}`);
    }
  }
  return concatBytes(chunks);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function decodeLamunaText(text: string): Field[] {
  const data = base64ToBytes(text.trim());
  if (data.length < 6) {
    throw new Error("Lamuna 内容过短");
  }
  const expectedLength =
    data[0] * 256 ** 3 + data[1] * 256 ** 2 + data[2] * 256 + data[3];
  const message = inflate(data.slice(4));
  if (expectedLength !== message.length) {
    throw new Error(`长度校验失败: ${expectedLength} != ${message.length}`);
  }
  return parseMessage(message);
}

export function encodeLamunaText(fields: Field[]): string {
  const message = serializeMessage(fields);
  const compressed = deflate(message, { level: 9 });
  const prefix = new Uint8Array(4);
  prefix[0] = (message.length >>> 24) & 0xff;
  prefix[1] = (message.length >>> 16) & 0xff;
  prefix[2] = (message.length >>> 8) & 0xff;
  prefix[3] = message.length & 0xff;
  return bytesToBase64(concatBytes([prefix, compressed]));
}

export function parseLamunaSummary(text: string): Pick<
  TemplateRecord,
  "name" | "batch" | "code" | "validMonths" | "year" | "month"
> {
  const fields = decodeLamunaText(text);
  const summary = {
    name: "",
    batch: "",
    code: "",
    validMonths: 0,
    year: 0,
    month: 0,
  };
  for (const field of fields) {
    if (field.number === 3) {
      summary.code = String(field.value ?? "");
    } else if (field.number === 4) {
      summary.batch = String(field.value ?? "");
    } else if (field.number === 5) {
      summary.name = String(field.value ?? "");
    } else if (field.number === 17) {
      const packed = Number(field.value ?? 0);
      summary.validMonths = packed & 0xff;
      summary.year = Math.floor(packed / 65536);
      summary.month = Math.floor(packed / 256) & 0xff;
    }
  }
  return summary;
}

export function parseItemText(text: string): ItemText {
  const parts = text.trim().split("|");
  if (parts.length < 14 || parts[0] !== "ITEM" || parts[parts.length - 1] !== "#END") {
    throw new Error("不是旧版 ITEM 二维码内容");
  }
  const pointCount = Number(parts[8]);
  const curveStart = 9;
  const respStart = curveStart + pointCount;
  const aratioStart = respStart + pointCount;
  const aratioEnd = aratioStart + 4;
  if (!Number.isInteger(pointCount) || pointCount <= 0 || parts.length < aratioEnd + 3) {
    throw new Error("旧二维码曲线数据不完整");
  }
  return {
    name: parts[1],
    code: parts[2],
    batch: parts[3],
    validMonths: Number(parts[4]),
    year: Number(parts[5]),
    month: Number(parts[6]),
    curveCount: Number(parts[7]),
    pointCount,
    concs: parts.slice(curveStart, respStart).map(Number),
    resps: parts.slice(respStart, aratioStart).map(Number),
    aratio: parts.slice(aratioStart, aratioEnd).map(Number),
  };
}

export function normalizeName(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function projectKeys(name: string): string[] {
  const keys: string[] = [];
  for (const candidate of [name, name.replace(/[-_\s]+0?4$/i, "")]) {
    const key = normalizeName(candidate);
    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

export function buildTemplateIndex(templates: TemplateRecord[]): TemplateIndex {
  const index: TemplateIndex = new Map();
  for (const template of templates) {
    for (const key of projectKeys(template.name)) {
      const existing = index.get(key) ?? [];
      existing.push(template);
      index.set(key, existing);
    }
  }
  return index;
}

export function pickTemplate(templates: TemplateRecord[], item: ItemText): TemplateRecord {
  const notSameBatch = templates.filter((template) => template.batch !== item.batch);
  const candidates = notSameBatch.length > 0 ? notSameBatch : templates;
  return [...candidates].sort((left, right) => {
    const leftPacked = left.year * 65536 + left.month * 256 + left.validMonths;
    const rightPacked = right.year * 65536 + right.month * 256 + right.validMonths;
    if (leftPacked !== rightPacked) {
      return leftPacked - rightPacked;
    }
    return left.batch.localeCompare(right.batch);
  })[candidates.length - 1];
}

function packFloats(values: number[]): Uint8Array {
  const raw = new Uint8Array(values.length * 4);
  const view = new DataView(raw.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });
  return raw;
}

function makeSerial(): number {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return Number(stamp) * 10000 + (Date.now() % 10000);
}

function batchDay(batch: string): number | null {
  const match = batch.match(/^\d{6}(\d{2})/);
  return match ? Number(match[1]) : null;
}

export function applyItemToTemplate(template: TemplateRecord, item: ItemText): string {
  const templateFields = decodeLamunaText(template.payload);
  const output: Field[] = [];
  let replacedDay = false;

  for (const field of templateFields) {
    if (field.number === 1 && field.wire === 0) {
      output.push({ number: field.number, wire: field.wire, value: makeSerial() });
    } else if (field.number === 4 && field.wire === 2) {
      output.push({ number: field.number, wire: field.wire, value: item.batch });
    } else if (field.number === 16 && field.wire === 2 && field.raw) {
      const curve = parseMessage(field.raw);
      const newCurve: Field[] = curve.map((curveField) => {
        if (curveField.number === 7 && curveField.wire === 2) {
          const raw = packFloats(item.concs);
          return { number: curveField.number, wire: curveField.wire, value: raw, raw };
        }
        if (curveField.number === 8 && curveField.wire === 2) {
          const raw = packFloats(item.resps);
          return { number: curveField.number, wire: curveField.wire, value: raw, raw };
        }
        if (curveField.number === 9 && curveField.wire === 2) {
          const raw = packFloats(item.aratio);
          return { number: curveField.number, wire: curveField.wire, value: raw, raw };
        }
        return curveField;
      });
      const raw = serializeMessage(newCurve);
      output.push({ number: field.number, wire: field.wire, value: raw, raw });
    } else if (field.number === 17 && field.wire === 0) {
      output.push({
        number: field.number,
        wire: field.wire,
        value: item.year * 65536 + item.month * 256 + item.validMonths,
      });
    } else if (field.number === 22 && field.wire === 2) {
      const day = batchDay(item.batch);
      if (day !== null) {
        const raw = new Uint8Array([day]);
        output.push({ number: field.number, wire: field.wire, value: raw, raw });
        replacedDay = true;
      } else {
        output.push(field);
      }
    } else {
      output.push(field);
    }
  }

  if (!replacedDay) {
    const day = batchDay(item.batch);
    if (day !== null) {
      const raw = new Uint8Array([day]);
      output.push({ number: 22, wire: 2, value: raw, raw });
    }
  }

  return encodeLamunaText(output);
}

export function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*]+/g, "_").replace(/[. ]+$/g, "").trim();
}

export function findTemplates(index: TemplateIndex, itemName: string): TemplateRecord[] {
  const templates: TemplateRecord[] = [];
  const seen = new Set<string>();
  for (const key of projectKeys(itemName)) {
    for (const template of index.get(key) ?? []) {
      const identity = `${template.source}:${template.file}:${template.payload.slice(0, 32)}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        templates.push(template);
      }
    }
  }
  return templates;
}
