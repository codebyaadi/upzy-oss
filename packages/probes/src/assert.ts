import type { schema } from "@upzy/db";

export type Assertion = NonNullable<typeof schema.monitors.$inferSelect.config.assertions>[number];

/** Reads `data.items[0].status` out of parsed JSON. undefined when any step is missing. */
export function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) return undefined;
  }
  return cur;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** Replaces every secret (and extracted variable) value in a message, so a failure never leaks one into history. */
export function redactValues(text: string, values: Iterable<string>): string {
  let out = text;
  for (const v of values) if (v.length >= 4) out = out.split(v).join("***");
  return out;
}

/**
 * Checks JSON assertions against a response body. Messages name the path and what was expected; the actual value is
 * shown (shortened) only for numbers, booleans and short strings, never for objects.
 */
export function evalAssertions(
  body: string,
  assertions: Assertion[],
): { ok: true } | { ok: false; message: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, message: "The response isn't valid JSON" };
  }
  for (const a of assertions) {
    const actual = readPath(json, a.path);
    const present = actual !== undefined && actual !== null;
    const want = a.value ?? "";
    let pass: boolean;
    switch (a.op) {
      case "exists":
        pass = present;
        break;
      case "not_exists":
        pass = !present;
        break;
      case "equals":
        pass = present && show(actual) === want;
        break;
      case "not_equals":
        pass = !present || show(actual) !== want;
        break;
      case "contains":
        pass = Array.isArray(actual)
          ? actual.some((x) => show(x) === want)
          : typeof actual === "string" && actual.includes(want);
        break;
      case "gt":
        pass = present && Number.isFinite(Number(actual)) && Number(actual) > Number(want);
        break;
      case "lt":
        pass = present && Number.isFinite(Number(actual)) && Number(actual) < Number(want);
        break;
    }
    if (!pass) {
      const label = {
        equals: "equal",
        not_equals: "differ from",
        contains: "contain",
        gt: "be greater than",
        lt: "be less than",
        exists: "exist",
        not_exists: "be absent",
      }[a.op];
      const shown = !present
        ? "it is missing"
        : typeof actual === "object"
          ? "it has a different value"
          : `it is ${show(actual).slice(0, 40)}`;
      return {
        ok: false,
        message: `Expected ${a.path} to ${label}${a.op === "exists" || a.op === "not_exists" ? "" : ` ${want.slice(0, 60)}`}, but ${shown}`,
      };
    }
  }
  return { ok: true };
}

const TEMPLATE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

export class TemplateError extends Error {}

/** Fills {{variable}} and {{secret.NAME}}. An unknown name fails loudly instead of sending a literal "{{x}}". */
export function render(
  text: string,
  vars: Record<string, string>,
  secrets: Record<string, string>,
): string {
  return text.replace(TEMPLATE, (_, name: string) => {
    const v = name.startsWith("secret.") ? secrets[name.slice(7)] : vars[name];
    if (v === undefined) throw new TemplateError(`{{${name}}} has no value`);
    return v;
  });
}
