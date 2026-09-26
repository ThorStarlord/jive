import { describe, expect, test } from "bun:test";
import { graphSchema, repairGraph, validateGraph } from "../src/core/schema.ts";
import { graphToolParameters } from "../src/core/tool-schema.ts";
import { graphModToolParameters } from "../src/core/graph-edits.ts";

const bash = { type: "bash", script: "ls" };

function rejection(value: unknown): string {
  try {
    validateGraph(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the graph to be rejected");
}

describe("validation messages", () => {
  test("names the expected constant and the received value", () => {
    expect(rejection({ version: "1", label: "x", nodes: {} }))
      .toBe('Invalid graph: /version must be the number 1 (received the string "1")');
  });

  test("explains that nodes must be an object rather than a JSON-encoded string", () => {
    const message = rejection({ version: 1, label: "x", nodes: JSON.stringify({ a: bash }) });
    expect(message).toContain("/nodes must be a JSON object, not a JSON-encoded string");
    expect(message).toContain('received the string');
  });

  test("lists every missing root property for an empty graph", () => {
    expect(rejection({})).toBe(
      'Invalid graph: / is missing required property "version"; / is missing required property "label"; / is missing required property "nodes"',
    );
  });

  test("reports only the chosen node branch instead of both oneOf alternatives", () => {
    expect(rejection({ version: 1, label: "x", nodes: { a: { type: "bash" } } }))
      .toBe('Invalid graph: /nodes/a is missing required property "script"');
    expect(rejection({ version: 1, label: "x", nodes: { a: { type: "jev", state: {} } } }))
      .toBe('Invalid graph: /nodes/a is missing required property "questions"');
    expect(rejection({ version: 1, label: "x", nodes: { a: { type: "synth", task: "write" } } }))
      .toBe('Invalid graph: /nodes/a is missing required property "input"');
  });

  test("names the discriminator options when a node type is unknown", () => {
    expect(rejection({ version: 1, label: "x", nodes: { a: { type: "shell", script: "ls" } } }))
      .toBe('Invalid graph: /nodes/a/type must be one of "bash", "jev", "synth" (received the string "shell")');
    expect(rejection({ version: 1, label: "x", nodes: {}, groups: { g: { template: "t" } }, templates: { t: { nodes: {} } } }))
      .toBe('Invalid graph: /groups/g/kind must be one of "foreach", "repeat" (received nothing)');
  });

  test("names unknown properties and bad IDs", () => {
    expect(rejection({ version: 1, label: "x", nodes: { a: { ...bash, shell: "zsh" } } }))
      .toBe('Invalid graph: /nodes/a has unknown property "shell"');
    expect(rejection({ version: 1, label: "x", nodes: { "1a": bash } }))
      .toContain('/nodes has invalid ID "1a"');
  });
});

describe("repairGraph", () => {
  test("coerces the string version and parses JSON-encoded work maps", () => {
    const templates = { t: { nodes: JSON.stringify({ inner: bash }) } };
    const raw = { version: "1", label: "x", nodes: JSON.stringify({ a: bash }), groups: "{}", templates: JSON.stringify(templates) };
    const { value, repairs } = repairGraph(raw);
    expect(value).toEqual({ version: 1, label: "x", nodes: { a: bash }, groups: {}, templates: { t: { nodes: { inner: bash } } } });
    expect(repairs).toEqual([
      '/version: coerced the string "1" to the number 1',
      "/nodes: parsed a JSON-encoded string into an object; send an object directly",
      "/groups: parsed a JSON-encoded string into an object; send an object directly",
      "/templates: parsed a JSON-encoded string into an object; send an object directly",
      "/templates/t/nodes: parsed a JSON-encoded string into an object; send an object directly",
    ]);
    expect(raw.version).toBe("1");
    expect(() => validateGraph(value)).not.toThrow();
  });

  test("leaves valid graphs and unrepairable values alone", () => {
    const graph = { version: 1, label: "x", nodes: { a: bash } };
    expect(repairGraph(graph)).toEqual({ value: graph, repairs: [] });
    expect(repairGraph({ version: 2, nodes: "not json", label: "x" }))
      .toEqual({ value: { version: 2, nodes: "not json", label: "x" }, repairs: [] });
    expect(repairGraph("{}")).toEqual({ value: "{}", repairs: [] });
    expect(repairGraph({ version: 1, label: "x", nodes: "[1]" }).repairs).toEqual([]);
  });
});

describe("tool parameter schema", () => {
  const forbidden = ["const", "$ref", "$defs", "oneOf", "anyOf", "allOf", "uniqueItems", "maxProperties", "propertyNames", "pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"];

  function walk(value: unknown, path: string, visit: (node: Record<string, unknown>, path: string) => void): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((entry, index) => walk(entry, `${path}[${index}]`, visit));
    const node = value as Record<string, unknown>;
    visit(node, path);
    for (const [key, child] of Object.entries(node)) {
      if (key === "enum" || key === "required" || key === "description") continue;
      walk(child, `${path}.${key}`, visit);
    }
  }

  test("uses only keywords every provider forwards", () => {
    for (const parameters of [graphToolParameters, graphModToolParameters]) {
      walk(parameters, "$", (node, path) => {
        if (path.endsWith(".properties")) return; // keys here are property names, not schema keywords
        for (const keyword of forbidden) expect(node, `${keyword} at ${path}`).not.toHaveProperty(keyword);
        expect(node.additionalProperties, path).not.toBe(false);
        if (typeof node.type === "string" && path !== "$" && !path.endsWith(".items")) {
          expect(typeof node.description, `description at ${path}`).toBe("string");
        }
      });
    }
  });

  test("maxNodes is no longer an execution option", () => {
    const properties = graphToolParameters.properties as Record<string, any>;
    expect(properties.limits.properties).not.toHaveProperty("maxNodes");
    expect(rejection({ version: 1, label: "old option", nodes: {}, limits: { maxNodes: 300 } }))
      .toContain('unknown property "maxNodes"');
  });

  test("fixed values are enums with a type", () => {
    const root = graphToolParameters.properties as Record<string, any>;
    expect(root.version).toMatchObject({ type: "integer", enum: [1] });
    expect(root.nodes.additionalProperties.properties.type).toMatchObject({ type: "string", enum: ["bash", "jev", "synth"] });
    expect(root.groups.additionalProperties.properties.kind).toMatchObject({ type: "string", enum: ["foreach", "repeat"] });
  });

  test("mirrors every property of the strict validation schema", () => {
    const strict = graphSchema as Record<string, any>;
    const portable = graphToolParameters as Record<string, any>;
    const keys = (schema: Record<string, any>) => Object.keys(schema.properties).sort();
    const union = (branches: Array<Record<string, any>>) => [...new Set(branches.flatMap(keys))].sort();

    expect(keys(portable)).toEqual(keys(strict));
    expect(portable.required).toEqual(strict.required);
    expect(keys(portable.properties.limits)).toEqual(keys(strict.properties.limits));
    expect(keys(portable.properties.nodes.additionalProperties)).toEqual(union(strict.$defs.nodes.additionalProperties.oneOf));
    expect(keys(portable.properties.groups.additionalProperties)).toEqual(union(strict.$defs.groups.additionalProperties.oneOf));
    expect(keys(portable.properties.templates.additionalProperties)).toEqual(keys(strict.$defs.body));
    expect(keys(portable.properties.nodes.additionalProperties.properties.when)).toEqual(keys(strict.$defs.condition));
    expect(portable.properties.nodes.additionalProperties.properties.when.properties.op.enum).toEqual(strict.$defs.condition.properties.op.enum);
    expect(portable.properties.nodes.additionalProperties.properties.onError.enum).toEqual(strict.$defs.nodes.additionalProperties.oneOf[0].properties.onError.enum);
    expect(portable.properties.nodes.additionalProperties.properties.outputFormat.enum).toEqual(strict.$defs.nodes.additionalProperties.oneOf[0].properties.outputFormat.enum);
  });
});

describe("repairGraph shapes seen in sessions", () => {
  test("hoists root fields that were written inside the nodes map", () => {
    const { value, repairs } = repairGraph({ version: 1, label: "x", nodes: { a: bash, returns: ["a"], limits: { concurrency: 2 }, onError: "stop" } });
    expect(value).toEqual({ version: 1, label: "x", nodes: { a: bash, onError: "stop" }, returns: ["a"], limits: { concurrency: 2 } });
    expect(repairs).toEqual([
      "/nodes/returns: moved to the top level; returns is a sibling of nodes, not a node",
      "/nodes/limits: moved to the top level; limits is a sibling of nodes, not a node",
    ]);
    expect(rejection(value)).toContain("/nodes/onError/type must be one of");
  });

  test("demotes node and group definitions written beside the map they belong in", () => {
    const group = { kind: "foreach", items: [], template: "t", maxItems: 1 };
    const { value, repairs } = repairGraph({
      version: 1, label: "x", nodes: { a: bash }, groups: {},
      templates: { t: { nodes: { b: bash } } }, returns: ["a"],
      merge: { ...bash, needs: ["a"] }, each: group,
    });
    expect(value).toEqual({
      version: 1, label: "x", nodes: { a: bash, merge: { ...bash, needs: ["a"] } },
      groups: { each: group }, templates: { t: { nodes: { b: bash } } }, returns: ["a"],
    });
    expect(repairs).toEqual([
      "/merge: moved into /nodes; the nodes map was closed before this definition",
      "/each: moved into /groups; the groups map was closed before this definition",
    ]);
    expect(() => validateGraph(value)).not.toThrow();
  });

  test("leaves stray root keys alone when they are not definitions or would collide", () => {
    const collide = repairGraph({ version: 1, label: "x", nodes: { merge: bash }, merge: bash });
    expect(collide.repairs).toEqual([]);
    expect(rejection(collide.value)).toContain('has unknown property "merge"');
    expect(repairGraph({ version: 1, label: "x", nodes: {}, note: "text", count: 2 }).repairs).toEqual([]);
    // A root field keeps its meaning even when its value happens to look like a node.
    expect(repairGraph({ version: 1, label: "x", nodes: {}, context: bash }).repairs).toEqual([]);
  });

  test("keeps a real node whose ID collides with a root field", () => {
    const { value, repairs } = repairGraph({ version: 1, label: "x", nodes: { output: bash } });
    expect(value).toEqual({ version: 1, label: "x", nodes: { output: bash } });
    expect(repairs).toEqual([]);
  });

  test("rewrites ref/path aliases into $ref only when they point into a graph namespace", () => {
    const raw = {
      version: 1, label: "x",
      nodes: { a: { ...bash, env: { X: { ref: "/context/value" } }, outputFormat: "json" } },
      groups: { g: { kind: "foreach", items: { path: "/nodes/a/output/json" }, template: "t", maxItems: 2 } },
      templates: { t: { nodes: { b: { type: "jev", state: { path: "/src/index.ts", file: { pointer: "/item" } }, questions: { q: { type: "noul", instructions: "?" } }, accept: { op: "exists", args: [{ $ref: "/answers/q/noul" }] } } } } },
      context: { path: "/nodes/a/output/json" },
    };
    const { value, repairs } = repairGraph(raw) as { value: any; repairs: string[] };
    expect(value.nodes.a.env.X).toEqual({ $ref: "/context/value" });
    expect(value.groups.g.items).toEqual({ $ref: "/nodes/a/output/json" });
    expect(value.templates.t.nodes.b.state).toEqual({ path: "/src/index.ts", file: { $ref: "/item" } });
    expect(value.context).toEqual({ path: "/nodes/a/output/json" });
    expect(repairs).toEqual([
      '/nodes/a/env/X: rewrote {"ref": ...} as {"$ref": ...}; a reference is an object whose only key is $ref',
      '/groups/g/items: rewrote {"path": ...} as {"$ref": ...}; a reference is an object whose only key is $ref',
      '/templates/t/nodes/b/state/file: rewrote {"pointer": ...} as {"$ref": ...}; a reference is an object whose only key is $ref',
    ]);
    expect(() => validateGraph(value)).not.toThrow();
  });

  test("drops null from unset optional fields but keeps null as data", () => {
    const raw = {
      version: 1, label: "x", returns: null, groups: null, context: null,
      limits: { concurrency: null, maxJevCalls: 0 },
      nodes: { a: { ...bash, when: null, needs: null, label: null, stdin: null } },
      templates: { t: { nodes: { b: { ...bash, onError: null } } } },
    };
    const { value, repairs } = repairGraph(raw) as { value: any; repairs: string[] };
    expect(value).toEqual({
      version: 1, label: "x", context: null, limits: { maxJevCalls: 0 },
      nodes: { a: { ...bash, stdin: null } }, templates: { t: { nodes: { b: bash } } },
    });
    expect(repairs).toEqual([
      "/returns: dropped null; leave out optional fields that are not set",
      "/groups: dropped null; leave out optional fields that are not set",
      "/limits/concurrency: dropped null; leave out optional fields that are not set",
      "/templates/t/nodes/b/onError: dropped null; leave out optional fields that are not set",
      "/nodes/a/when: dropped null; leave out optional fields that are not set",
      "/nodes/a/needs: dropped null; leave out optional fields that are not set",
      "/nodes/a/label: dropped null; leave out optional fields that are not set",
    ]);
    expect(raw.nodes.a.when).toBeNull();
    expect(() => validateGraph(value)).not.toThrow();
    // A required field stays invalid rather than being silently removed.
    expect(rejection(repairGraph({ version: 1, label: "x", nodes: { a: { type: "bash", script: null } } }).value)).toContain("/nodes/a/script");
  });

  test("parses a JSON-encoded context object but leaves plain text alone", () => {
    expect(repairGraph({ version: 1, label: "x", nodes: {}, context: '{"goal":"g"}' }).value).toMatchObject({ context: { goal: "g" } });
    expect(repairGraph({ version: 1, label: "x", nodes: {}, context: "testing" }).value).toMatchObject({ context: "testing" });
  });
});

describe("expression and script checks", () => {
  const foreach = (items: unknown) => ({ version: 1, label: "x", nodes: { a: { ...bash, outputFormat: "json" } }, groups: { g: { kind: "foreach", items, template: "t", maxItems: 2 } }, templates: { t: { nodes: { b: bash } } } });

  test("rejects an items object that is not a reference", () => {
    expect(rejection(foreach({ path: "/nodes/a/output/json" })))
      .toBe('Invalid graph: /groups/g/items must be an array or a reference {"$ref": "/nodes/ID/output/..."} (received an object with keys path); the reference key is exactly $ref');
    expect(() => validateGraph(foreach(["x", "y"]))).not.toThrow();
    expect(() => validateGraph(foreach({ $ref: "/nodes/a/output/json" }))).not.toThrow();
  });

  test("rejects env values and prepare inputs that are plain objects", () => {
    expect(rejection({ version: 1, label: "x", nodes: { a: { ...bash, env: { X: { ref: "/input" } } } } })).toContain("/nodes/a/env/X must be a string, number or boolean or a reference");
    const jev = { type: "jev", prepare: [{ use: "lines", as: "l", input: { value: "a\nb" } }], state: {}, questions: { q: { type: "noul", instructions: "?" } }, accept: { op: "exists", args: [{ $ref: "/answers/q/noul" }] } };
    expect(rejection({ version: 1, label: "x", nodes: { j: jev } })).toContain("/nodes/j/prepare/0/input must be a string or a reference");
  });

  test("rejects malformed $ref objects anywhere in program text", () => {
    expect(rejection({ version: 1, label: "x", nodes: { a: { ...bash, stdin: { $ref: "/context/x", extra: 1 } } } }))
      .toContain("/nodes/a/stdin is not a valid reference");
  });

  test("rejects a heredoc program on a node with stdin unless it reads JIVE_STDIN", () => {
    const heredoc = "python3 - <<'PY'\nimport json,sys\nprint(json.load(sys.stdin))\nPY";
    expect(rejection({ version: 1, label: "x", nodes: { a: { type: "bash", stdin: "[]", script: heredoc } } })).toContain("/nodes/a/script feeds its program to the interpreter through a heredoc");
    expect(() => validateGraph({ version: 1, label: "x", nodes: { a: { type: "bash", script: heredoc } } })).not.toThrow();
    const viaFile = "python3 - <<'PY'\nimport json,os\nprint(json.load(open(os.environ['JIVE_STDIN'])))\nPY";
    expect(() => validateGraph({ version: 1, label: "x", nodes: { a: { type: "bash", stdin: "[]", script: viaFile } } })).not.toThrow();
  });

  test("accepts maxJevCalls 0 and the foreach onItemFailure switch", () => {
    expect(() => validateGraph({ version: 1, label: "x", nodes: { a: bash }, limits: { maxJevCalls: 0 } })).not.toThrow();
    expect(() => validateGraph({ ...foreach(["x"]), groups: { g: { kind: "foreach", items: ["x"], template: "t", maxItems: 2, onItemFailure: "continue" } } })).not.toThrow();
  });
});
