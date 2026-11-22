// Small helpers for validating parsed JSON without a schema library.
// Validators collect every problem with its path instead of stopping at the first.

export interface Issue {
  path: string;
  message: string;
}

export type Result<T> =
  | { ok: true; value: T; warnings: Issue[] }
  | { ok: false; errors: Issue[]; warnings: Issue[] };

export class Checker {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];

  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }

  result<T>(value: T): Result<T> {
    return this.errors.length === 0
      ? { ok: true, value, warnings: this.warnings }
      : { ok: false, errors: this.errors, warnings: this.warnings };
  }

  isObject(value: unknown, path: string): value is Record<string, unknown> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return true;
    this.error(path, "expected an object");
    return false;
  }

  isArray(value: unknown, path: string): value is unknown[] {
    if (Array.isArray(value)) return true;
    this.error(path, "expected an array");
    return false;
  }

  isString(value: unknown, path: string, { nonEmpty = true } = {}): value is string {
    if (typeof value === "string" && (!nonEmpty || value.length > 0)) return true;
    this.error(path, nonEmpty ? "expected a non-empty string" : "expected a string");
    return false;
  }

  isBoolean(value: unknown, path: string): value is boolean {
    if (typeof value === "boolean") return true;
    this.error(path, "expected true or false");
    return false;
  }

  /** Integer within [min, max]. */
  isInt(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
    if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
      return true;
    }
    this.error(path, `expected an integer from ${min} to ${max}`);
    return false;
  }

  isOneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): value is T {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return true;
    this.error(path, `expected one of ${allowed.join(", ")}`);
    return false;
  }

  isIsoDate(value: unknown, path: string): value is string {
    if (
      typeof value === "string" &&
      /[zZ]|[+-]\d\d:\d\d$/.test(value) &&
      !Number.isNaN(Date.parse(value))
    ) {
      return true;
    }
    this.error(path, "expected an ISO 8601 date-time with a time zone");
    return false;
  }
}
