import { afterEach, describe, expect, test, vi } from "vitest";

import { createSandbox, type Sandbox } from "../src";
import { expression } from "./testUtils";

let sandbox: Sandbox;

afterEach(() => {
  sandbox?.dispose();
});

describe("code execution", () => {
  test("returns a primitive value", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "123")).toBe(123);
  });

  test("returns a string", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, '"hello"')).toBe("hello");
    expect(await expression(sandbox, '"emojis 🍕🍕🍕"')).toBe("emojis 🍕🍕🍕");
  });

  test("returns a boolean", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "true")).toBe(true);
  });

  test("returns a bigint", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "123n")).toEqual(123n);
  });

  test("returns a RegExp", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "/test/")).toEqual(/test/);
  });

  test("returns null", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "null")).toBe(null);
  });

  test("returns an object", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, '{ a: 1, b: "two" }')).toEqual({
      a: 1,
      b: "two",
    });
  });

  test("returns an array", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  test("supports top-level await", async () => {
    sandbox = await createSandbox();
    await expect(expression(sandbox, "await Promise.resolve(42)")).resolves.toBe(42);
  });

  test("runs multiple executions sequentially", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "1")).toBe(1);
    expect(await expression(sandbox, "2")).toBe(2);
    expect(await expression(sandbox, "3")).toBe(3);
  });

  test("preserves global state across runs", async () => {
    sandbox = await createSandbox();
    await sandbox.run("globalThis.__counter = 1");
    await sandbox.run("globalThis.__counter += 1");
    expect(await expression(sandbox, "globalThis.__counter")).toBe(2);
  });

  test("propagates synchronous errors", async () => {
    sandbox = await createSandbox();
    await expect(sandbox.run('throw new Error("boom")')).rejects.toThrow();
  });

  test("propagates async errors", async () => {
    sandbox = await createSandbox();
    await expect(sandbox.run('await Promise.reject(new Error("async boom"))')).rejects.toThrow();
  });

  test("propagates syntax errors", async () => {
    sandbox = await createSandbox();
    await expect(sandbox.run("const x = {")).rejects.toThrow();
    await expect(expression(sandbox, "}}")).rejects.toThrow();
  });

  test("propagates serialization errors", async () => {
    sandbox = await createSandbox();
    await expect(expression(sandbox, 'new URL("https://test.invalid")')).rejects.toThrow(
      "not be cloned",
    );
  });

  test("uses strict mode JS", async () => {
    sandbox = await createSandbox();
    await expect(expression(sandbox, "notFound = 666")).rejects.toThrow();
  });
});

describe("globals", () => {
  test("exposes primitive constants", async () => {
    sandbox = await createSandbox({
      globals: {
        myNumber: 42,
        myString: "hello",
        myBool: true,
        myNull: null,
      },
    });
    expect(await expression(sandbox, "myNumber")).toBe(42);
    expect(await expression(sandbox, "myString")).toBe("hello");
    expect(await expression(sandbox, "myBool")).toBe(true);
    expect(await expression(sandbox, "myNull")).toBe(null);
  });

  test("exposes synchronous functions", async () => {
    sandbox = await createSandbox({
      globals: {
        add: (a: number, b: number) => a + b,
      },
    });
    expect(await expression(sandbox, "await add(2, 3)")).toBe(5);
  });

  test("exposes async functions", async () => {
    sandbox = await createSandbox({
      globals: {
        fetchValue: async () => "async-result",
      },
    });
    expect(await expression(sandbox, "await fetchValue()")).toBe("async-result");
  });

  test("exposes nested objects with functions", async () => {
    sandbox = await createSandbox({
      globals: {
        math: {
          add: (a: number, b: number) => a + b,
          multiply: (a: number, b: number) => a * b,
        },
      },
    });
    expect(await expression(sandbox, "await math.add(2, 3)")).toBe(5);
    expect(await expression(sandbox, "await math.multiply(4, 5)")).toBe(20);
  });

  test("exposes nested objects with constants only", async () => {
    sandbox = await createSandbox({
      globals: {
        config: {
          version: 1,
          name: "test",
        },
      },
    });
    expect(await expression(sandbox, "config.version")).toBe(1);
    expect(await expression(sandbox, "config.name")).toBe("test");
  });

  test("deeply nested objects", async () => {
    sandbox = await createSandbox({
      globals: {
        a: {
          b: {
            c: {
              getValue: () => "deep",
            },
          },
        },
      },
    });
    expect(await expression(sandbox, "await a.b.c.getValue()")).toBe("deep");
  });

  test("host functions receive correct arguments", async () => {
    const fn = vi.fn((...args: unknown[]) => args);
    sandbox = await createSandbox({ globals: { fn } });
    const result = await expression(sandbox, 'await fn(1, "two", true, null)');
    expect(result).toEqual([1, "two", true, null]);
    expect(fn).toHaveBeenCalledWith(1, "two", true, null);
  });

  test("host function errors propagate to sandbox", async () => {
    sandbox = await createSandbox({
      globals: {
        fail: () => {
          throw new Error("host error");
        },
      },
    });
    await expect(expression(sandbox, "await fail()")).rejects.toThrow("host error");
  });

  test("works with no globals", async () => {
    sandbox = await createSandbox();
    expect(await expression(sandbox, "1 + 1")).toBe(2);
  });

  test("works with empty globals object", async () => {
    sandbox = await createSandbox({ globals: {} });
    expect(await expression(sandbox, "1 + 1")).toBe(2);
  });

  test("rejects unserializable globals", async () => {
    await expect(createSandbox({ globals: { sym: Symbol("nope") } })).rejects.toThrow();
  });

  test("method `this` binds to its parent object", async () => {
    const counter = {
      n: 0,
      inc() {
        return ++this.n;
      },
    };
    sandbox = await createSandbox({ globals: { counter } });
    expect(await sandbox.evaluate("counter.inc()")).toBe(1);
    expect(await sandbox.evaluate("counter.inc()")).toBe(2);
    expect(counter.n).toBe(2);
  });

  test("nested method `this` binds to its immediate parent", async () => {
    const inner = {
      label: "hi",
      greet() {
        return this.label;
      },
    };
    sandbox = await createSandbox({ globals: { outer: { inner } } });
    expect(await expression(sandbox, "await outer.inner.greet()")).toBe("hi");
  });

  test("sibling methods share the same `this`", async () => {
    const store = {
      value: 10,
      get() {
        return this.value;
      },
      set(v: number) {
        this.value = v;
      },
    };
    sandbox = await createSandbox({ globals: { store } });
    expect(await sandbox.evaluate("store.get()")).toBe(10);
    await sandbox.run("await store.set(99)");
    expect(await sandbox.evaluate("store.get()")).toBe(99);
  });

  test("top-level functions still work without `this`", async () => {
    sandbox = await createSandbox({
      globals: { add: (a: number, b: number) => a + b },
    });
    expect(await expression(sandbox, "await add(2, 3)")).toBe(5);
  });
});

describe("global value types", () => {
  describe("primitives", () => {
    test("number (including Infinity, NaN, -0)", async () => {
      sandbox = await createSandbox({
        globals: { int: 42, float: 3.14, neg: -1, inf: Infinity, negInf: -Infinity, nan: NaN },
      });
      expect(await expression(sandbox, "int")).toBe(42);
      expect(await expression(sandbox, "float")).toBe(3.14);
      expect(await expression(sandbox, "neg")).toBe(-1);
      expect(await expression(sandbox, "inf")).toBe(Infinity);
      expect(await expression(sandbox, "negInf")).toBe(-Infinity);
      expect(await expression(sandbox, "Number.isNaN(nan)")).toBe(true);
    });

    test("string", async () => {
      sandbox = await createSandbox({
        globals: { empty: "", hello: "hello", emoji: "🍕", unicode: "café" },
      });
      expect(await expression(sandbox, "empty")).toBe("");
      expect(await expression(sandbox, "hello")).toBe("hello");
      expect(await expression(sandbox, "emoji")).toBe("🍕");
      expect(await expression(sandbox, "unicode")).toBe("café");
    });

    test("boolean", async () => {
      sandbox = await createSandbox({ globals: { t: true, f: false } });
      expect(await expression(sandbox, "t")).toBe(true);
      expect(await expression(sandbox, "f")).toBe(false);
    });

    test("null", async () => {
      sandbox = await createSandbox({ globals: { n: null } });
      expect(await expression(sandbox, "n")).toBe(null);
    });

    test("undefined", async () => {
      sandbox = await createSandbox({ globals: { u: undefined } });
      expect(await expression(sandbox, "typeof u")).toBe("undefined");
      expect(await expression(sandbox, "u")).toBeUndefined();
    });

    test("bigint", async () => {
      sandbox = await createSandbox({
        globals: { big: 123n, bigNeg: -999999999999999999n },
      });
      expect(await expression(sandbox, "big")).toEqual(123n);
      expect(await expression(sandbox, "bigNeg")).toEqual(-999999999999999999n);
    });
  });

  describe("objects", () => {
    test("plain object", async () => {
      sandbox = await createSandbox({
        globals: { obj: { a: 1, b: "two", c: true, d: null } },
      });
      expect(await expression(sandbox, "obj")).toEqual({ a: 1, b: "two", c: true, d: null });
    });

    test("empty object", async () => {
      sandbox = await createSandbox({ globals: { obj: {} } });
      expect(await expression(sandbox, "obj")).toEqual({});
    });

    test("array of primitives", async () => {
      sandbox = await createSandbox({ globals: { arr: [1, 2, 3] } });
      expect(await expression(sandbox, "Array.isArray(arr)")).toBe(true);
      expect(await expression(sandbox, "arr")).toEqual([1, 2, 3]);
      expect(await expression(sandbox, "arr.length")).toBe(3);
    });

    test("empty array", async () => {
      sandbox = await createSandbox({ globals: { arr: [] } });
      expect(await expression(sandbox, "Array.isArray(arr)")).toBe(true);
      expect(await expression(sandbox, "arr")).toEqual([]);
    });

    test("array of mixed primitives", async () => {
      sandbox = await createSandbox({
        globals: { arr: [1, "two", true, null] },
      });
      expect(await expression(sandbox, "arr")).toEqual([1, "two", true, null]);
    });

    test("array of objects", async () => {
      sandbox = await createSandbox({
        globals: { arr: [{ a: 1 }, { b: 2 }] },
      });
      expect(await expression(sandbox, "arr")).toEqual([{ a: 1 }, { b: 2 }]);
    });

    test("nested arrays", async () => {
      sandbox = await createSandbox({
        globals: {
          arr: [
            [1, 2],
            [3, 4],
          ],
        },
      });
      expect(await expression(sandbox, "arr")).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(await expression(sandbox, "Array.isArray(arr[0])")).toBe(true);
    });

    test("object containing arrays", async () => {
      sandbox = await createSandbox({
        globals: { obj: { fruits: ["apple", "banana"], ints: [1, 2, 3] } },
      });
      expect(await expression(sandbox, "Array.isArray(obj.fruits)")).toBe(true);
      expect(await expression(sandbox, "obj.fruits")).toEqual(["apple", "banana"]);
      expect(await expression(sandbox, "obj.ints")).toEqual([1, 2, 3]);
    });

    test("README mutable array example", async () => {
      sandbox = await createSandbox({
        globals: { fruit: ["apple", "banana"] },
      });
      await sandbox.run('fruit.push("cherry")');
      expect(await sandbox.evaluate("fruit")).toEqual(["apple", "banana", "cherry"]);
    });

    test("Date", async () => {
      const date = new Date("2024-01-01T00:00:00Z");
      sandbox = await createSandbox({ globals: { d: date } });
      expect(await expression(sandbox, "d instanceof Date")).toBe(true);
      expect(await expression(sandbox, "d.getTime()")).toBe(date.getTime());
      expect(await expression(sandbox, "d.toISOString()")).toBe(date.toISOString());
    });

    test("RegExp", async () => {
      sandbox = await createSandbox({ globals: { re: /foo/i } });
      expect(await expression(sandbox, "re instanceof RegExp")).toBe(true);
      expect(await expression(sandbox, "re.source")).toBe("foo");
      expect(await expression(sandbox, "re.flags")).toBe("i");
      expect(await expression(sandbox, 're.test("FOO")')).toBe(true);
      expect(await expression(sandbox, 're.test("bar")')).toBe(false);
    });

    test("Map", async () => {
      sandbox = await createSandbox({
        globals: {
          m: new Map<string, unknown>([
            ["a", 1],
            ["b", "two"],
          ]),
        },
      });
      expect(await expression(sandbox, "m instanceof Map")).toBe(true);
      expect(await expression(sandbox, "m.size")).toBe(2);
      expect(await expression(sandbox, 'm.get("a")')).toBe(1);
      expect(await expression(sandbox, 'm.get("b")')).toBe("two");
    });

    test("Set", async () => {
      sandbox = await createSandbox({
        globals: { s: new Set([1, 2, 3]) },
      });
      expect(await expression(sandbox, "s instanceof Set")).toBe(true);
      expect(await expression(sandbox, "s.size")).toBe(3);
      expect(await expression(sandbox, "s.has(2)")).toBe(true);
      expect(await expression(sandbox, "s.has(99)")).toBe(false);
    });

    test("ArrayBuffer", async () => {
      const buf = new Uint8Array([1, 2, 3, 4]).buffer;
      sandbox = await createSandbox({ globals: { buf } });
      expect(await expression(sandbox, "buf instanceof ArrayBuffer")).toBe(true);
      expect(await expression(sandbox, "buf.byteLength")).toBe(4);
      expect(await expression(sandbox, "new Uint8Array(buf)[2]")).toBe(3);
    });

    test("Uint8Array", async () => {
      sandbox = await createSandbox({
        globals: { arr: new Uint8Array([10, 20, 30]) },
      });
      expect(await expression(sandbox, "arr instanceof Uint8Array")).toBe(true);
      expect(await expression(sandbox, "arr.length")).toBe(3);
      expect(await expression(sandbox, "arr[1]")).toBe(20);
    });

    test("Int32Array", async () => {
      sandbox = await createSandbox({
        globals: { arr: new Int32Array([-1, 0, 1]) },
      });
      expect(await expression(sandbox, "arr instanceof Int32Array")).toBe(true);
      expect(await expression(sandbox, "arr[0]")).toBe(-1);
      expect(await expression(sandbox, "arr.length")).toBe(3);
    });
  });

  describe("mixed", () => {
    test("plain object containing an array and a function", async () => {
      sandbox = await createSandbox({
        globals: {
          mod: {
            items: ["a", "b", "c"],
            getItem: (i: number) => ["a", "b", "c"][i],
          },
        },
      });
      expect(await expression(sandbox, "Array.isArray(mod.items)")).toBe(true);
      expect(await expression(sandbox, "mod.items")).toEqual(["a", "b", "c"]);
      expect(await expression(sandbox, "await mod.getItem(1)")).toBe("b");
    });

    test("plain object with every primitive type", async () => {
      sandbox = await createSandbox({
        globals: {
          all: {
            num: 1,
            str: "s",
            bool: true,
            nil: null,
            undef: undefined,
            big: 10n,
          },
        },
      });
      expect(await expression(sandbox, "all.num")).toBe(1);
      expect(await expression(sandbox, "all.str")).toBe("s");
      expect(await expression(sandbox, "all.bool")).toBe(true);
      expect(await expression(sandbox, "all.nil")).toBe(null);
      expect(await expression(sandbox, "typeof all.undef")).toBe("undefined");
      expect(await expression(sandbox, "all.big")).toEqual(10n);
    });

    test("deeply nested mix of arrays, objects, and functions", async () => {
      sandbox = await createSandbox({
        globals: {
          root: {
            list: [1, 2, 3],
            child: {
              tags: ["x", "y"],
              count: () => 99,
            },
          },
        },
      });
      expect(await expression(sandbox, "root.list")).toEqual([1, 2, 3]);
      expect(await expression(sandbox, "Array.isArray(root.list)")).toBe(true);
      expect(await expression(sandbox, "root.child.tags")).toEqual(["x", "y"]);
      expect(await expression(sandbox, "Array.isArray(root.child.tags)")).toBe(true);
      expect(await expression(sandbox, "await root.child.count()")).toBe(99);
    });
  });
});

describe("lifecycle", () => {
  test("dispose removes the iframe from the DOM", async () => {
    sandbox = await createSandbox();
    expect(document.querySelectorAll("iframe").length).toBe(1);
    sandbox.dispose();
    expect(document.querySelectorAll("iframe").length).toBe(0);
  });

  test("Symbol.dispose works", async () => {
    sandbox = await createSandbox();
    expect(document.querySelectorAll("iframe").length).toBe(1);
    sandbox[Symbol.dispose]();
    expect(document.querySelectorAll("iframe").length).toBe(0);
  });

  test("dispose can be called multiple times safely", async () => {
    sandbox = await createSandbox();
    sandbox.dispose();
    sandbox.dispose();
  });

  test("run after dispose rejects with an error", async () => {
    sandbox = await createSandbox();
    sandbox.dispose();
    await expect(sandbox.run("1")).rejects.toThrow("Sandbox has been disposed");
  });

  test("dispose during run rejects the pending promise", async () => {
    sandbox = await createSandbox();
    const pending = sandbox.run("await new Promise(() => {})", {
      timeout: 10_000,
    });
    sandbox.dispose();
    await expect(pending).rejects.toThrow("Sandbox has been disposed");
  });
});

describe("timeout", () => {
  test("rejects with timeout error when code exceeds the timeout", async () => {
    sandbox = await createSandbox();
    await expect(sandbox.run("await new Promise(() => {})", { timeout: 50 })).rejects.toThrow(
      "Execution timed out",
    );
  });

  test("does not reject when code finishes before the timeout", async () => {
    sandbox = await createSandbox();
    const result = await expression(sandbox, "42", { timeout: 5000 });
    expect(result).toBe(42);
  });

  test("dispose during timed run rejects with disposed error", async () => {
    sandbox = await createSandbox();
    const pending = sandbox.run("await new Promise(() => {})", {
      timeout: 5000,
    });
    sandbox.dispose();
    await expect(pending).rejects.toThrow("Sandbox has been disposed");
  });
});

describe("options", () => {
  test("custom name is applied", async () => {
    sandbox = await createSandbox({ name: "my-test-sandbox" });
    const iframe = document.querySelector('iframe[name="my-test-sandbox"]') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
  });

  test("default name is slopjail", async () => {
    sandbox = await createSandbox();
    const iframe = document.querySelector('iframe[name="slopjail"]') as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
  });

  test("custom CSP allows network access", async () => {
    sandbox = await createSandbox({
      contentSecurityPolicy: {
        connectSrc: ["https://httpbin.org"],
      },
    });
    await expect(expression(sandbox, '(await fetch("https://httpbin.org/get")).ok')).resolves.toBe(
      true,
    );
  });

  test("custom CSP allows remote imports", async () => {
    sandbox = await createSandbox({
      contentSecurityPolicy: {
        scriptSrc: ["https://esm.sh"],
      },
    });
    await sandbox.run(`
      import _ from "https://esm.sh/underscore"
      globalThis.__result = _.uniq([1, 2, 1, 4, 1, 3]);
    `);
    await expect(sandbox.evaluate("globalThis.__result")).resolves.toStrictEqual([1, 2, 4, 3]);
  });
});

describe("multiple sandboxes", () => {
  test("sandboxes are isolated from each other", async () => {
    const sandbox1 = await createSandbox();
    const sandbox2 = await createSandbox();

    await sandbox1.run('globalThis.__value = "from-1"');
    await sandbox2.run('globalThis.__value = "from-2"');

    expect(await sandbox1.evaluate("globalThis.__value")).toBe("from-1");
    expect(await sandbox2.evaluate("globalThis.__value")).toBe("from-2");

    sandbox1.dispose();
    sandbox2.dispose();
  });
});
