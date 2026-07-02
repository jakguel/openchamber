// Minimal type declarations for bun:test to satisfy tsc.
// Only the subset used by our test files is declared.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toEqual(expected: unknown): void;
    toBe(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toThrow(expected?: string | RegExp): void;
    toContain(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toHaveLength(expected: number): void;
    toBeInstanceOf(expected: unknown): void;
    not: {
      toEqual(expected: unknown): void;
      toBe(expected: unknown): void;
      toContain(expected: unknown): void;
      toBeNull(): void;
    };
  };
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;

  // Controllable mock/spy handle. Extends the underlying callable so a Mock can be
  // used anywhere the real function is expected, while exposing bun's control API.
  export type Mock<T extends (...args: never[]) => unknown> = T & {
    mockImplementation(impl: T): Mock<T>;
    mockReturnValue(value: ReturnType<T>): Mock<T>;
    mockResolvedValue(value: Awaited<ReturnType<T>>): Mock<T>;
    mockResolvedValueOnce(value: Awaited<ReturnType<T>>): Mock<T>;
    mockRejectedValue(value: unknown): Mock<T>;
    mockReturnValueOnce(value: ReturnType<T>): Mock<T>;
    mockClear(): Mock<T>;
    mockReset(): Mock<T>;
    mockRestore(): void;
    mock: { calls: Array<Parameters<T>>; results: Array<{ type: string; value: unknown }> };
  };

  export function mock<T extends (...args: never[]) => unknown>(fn?: T): Mock<T>;
  export namespace mock {
    function module(moduleName: string, factory: () => Record<string, unknown>): void;
    function restore(): void;
  }

  // Spy on a mutable object property/method (including ESM namespace exports,
  // which bun makes writable). Returns a controllable Mock over the member.
  export function spyOn<T extends object, K extends keyof T>(
    obj: T,
    method: K,
  ): Mock<Extract<T[K], (...args: never[]) => unknown>>;
}
