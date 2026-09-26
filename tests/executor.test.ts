import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGraph } from "../src/core/executor";
import { ExtractorRegistry } from "../src/plugins/registry";
import type { Graph, JevAdapter, JevRequest, ExecutionEvent, SynthAdapter } from "../src/core/types";

const directories: string[] = [];
async function cwd() { const path = await mkdtemp(join(tmpdir(), "jev-executor-")); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const accept = { op: "gte" as const, args: [{ $ref: "/answers/ok/noul" }, .8] };
const questions = { ok: { type: "noul", instructions: "Does the evidence meet the criterion?" } };
function judge(value = .95, delay = 0): JevAdapter { return { async evaluate(request) { await Bun.sleep(delay); return { model: "fixture", answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "noul", noul: value }])) }; } }; }

test("failure blocks dependents while independent work finishes and accepted nonzero exits remain evidence", async () => {
  const graph: Graph = { version: 1, label: "failure", nodes: {
    bad: { type: "bash", script: "echo failure >&2; exit 2" },
    blocked: { type: "bash", needs: ["bad"], script: "echo should-not-run" },
    independent: { type: "bash", script: "sleep .02; echo independent" },
    expected: { type: "bash", script: "echo tests-failed; exit 1", acceptedExitCodes: [0,1] },
  }, returns: ["bad", "independent", "expected"] };
  const result = await executeGraph(graph, { cwd: await cwd() });
  expect(result.status).toBe("partial");
  expect(result.previews.find(p => p.id === "blocked")?.status).toBe("blocked");
  expect((result.requested.bad?.output as any).stderr).toContain("failure");
  expect(result.requested.independent?.status).toBe("done");
  expect(result.requested.expected?.status).toBe("done");
});

test("reference values bind as data and never become shell source", async () => {
  const directory = await cwd();
  const graph: Graph = { version: 1, label: "bindings", context: { value: "$(touch surprise); `echo injected` ' \" $HOME" }, nodes: {
    show: { type: "bash", env: { VALUE: { $ref: "/context/value" } }, script: "printf '%s' \"$VALUE\"" },
  }, returns: ["show"] };
  const result = await executeGraph(graph, { cwd: directory });
  expect((result.requested.show?.output as any).stdout).toBe((graph.context as any).value);
  await expect(access(join(directory, "surprise"))).rejects.toThrow();
});

test("cycle validation precedes every command", async () => {
  const directory = await cwd();
  await expect(executeGraph({ version: 1, label: "cycle", nodes: {
    a: { type: "bash", script: "touch ran", needs: ["b"] }, b: { type: "bash", script: "true", needs: ["a"] },
  } }, { cwd: directory })).rejects.toThrow("cycle");
  await expect(access(join(directory, "ran"))).rejects.toThrow();
});

test("parallel expansion preserves item order and enforces global leaf concurrency", async () => {
  let active = 0, maximum = 0;
  const adapter: JevAdapter = { async evaluate(request) { active++; maximum = Math.max(maximum,active); await Bun.sleep(request.state === 0 ? 50 : 10); active--; return { model:"fixture",answers:{ok:{type:"noul",noul:.99}} }; } };
  const graph: Graph = { version:1,label:"map",nodes:{},limits:{concurrency:2},groups:{ batch:{kind:"foreach",items:[0,1,2,3],template:"inspect",maxItems:4,concurrency:4} },templates:{inspect:{nodes:{ classify:{type:"jev",state:{$ref:"/input"},questions,accept}},output:{$ref:"/input"}}},returns:["batch"] };
  const result = await executeGraph(graph,{cwd:await cwd(),jev:adapter});
  expect(result.status).toBe("done");expect(maximum).toBe(2);
  expect((result.requested.batch?.output as any).items.map((item:any)=>item.output)).toEqual([0,1,2,3]);
  expect(result.previews.filter(p=>p.id.startsWith("batch[")).length).toBe(4);
});

test("bounded repetition preserves each iteration and exits using actual observations", async () => {
  const graph: Graph = {version:1,label:"repeat",nodes:{},groups:{loop:{kind:"repeat",template:"increment",initial:"0",next:{$ref:"/nodes/add/output/stdout"},until:{op:"eq",args:[{$ref:"/nodes/add/output/stdout"},"3"]},maxIterations:4}},templates:{increment:{nodes:{add:{type:"bash",env:{N:{$ref:"/state"}},script:"printf '%s' \"$((N+1))\""}},output:{$ref:"/nodes/add/output/stdout"}}},returns:["loop"]};
  const events:ExecutionEvent[]=[];
  const result = await executeGraph(graph,{cwd:await cwd(),onEvent:event=>events.push(event)});
  expect(result.status).toBe("done");
  expect((result.requested.loop?.output as any).iterations.map((i:any)=>i.output)).toEqual(["1","2","3"]);
  // The UI draws loops from these: the body up front, then one heading per iteration.
  expect(events.find(e=>e.type==="graph.started")?.data.templates).toEqual(graph.templates);
  expect(events.find(e=>e.type==="node.created"&&e.nodeId==="loop")?.data).toMatchObject({type:"repeat",template:"increment",maxIterations:4,parent:undefined,iteration:undefined});
  expect(events.filter(e=>e.type==="node.created"&&e.nodeId?.startsWith("loop[")).map(e=>[e.nodeId,e.data.parent,e.data.iteration])).toEqual([["loop[0]/add","loop",0],["loop[1]/add","loop",1],["loop[2]/add","loop",2]]);
});

test("uncertainty yields and saves exact Jev evidence while independent work completes", async () => {
  const events:ExecutionEvent[]=[];
  const result = await executeGraph({version:1,label:"yield",nodes:{ choose:{type:"jev",state:{evidence:"unclear"},questions,accept}, after:{type:"bash",needs:["choose"],script:"echo unreachable"}, free:{type:"bash",script:"echo independent"}},returns:["choose"]},{cwd:await cwd(),jev:judge(.5),onEvent:event=>events.push(event)});
  expect(result.status).toBe("yielded");expect(result.previews.find(p=>p.id==="after")?.status).toBe("blocked");
  expect(result.previews.find(p=>p.id==="free")?.status).toBe("done");
  expect(events.find(e=>e.type==="jev.request")?.data.state).toEqual({evidence:"unclear"});
});

test("plugin-produced candidate IDs resolve to original records", async () => {
  const adapter:JevAdapter={async evaluate(request:JevRequest){return {model:"fixture",answers:{file:{type:"choice",choice:"item_1",confidence:.95,probabilities:{item_0:.03,item_1:.95,none:.02}}}};}};
  const result=await executeGraph({version:1,label:"select",nodes:{ pick:{type:"jev",prepare:[{use:"lines",as:"files",input:"alpha\nbeta"}],state:{$ref:"/prepared/files/records"},questions:{file:{type:"choice",instructions:"Choose beta",criteria:{$ref:"/prepared/files/options"}}},accept:{op:"gte",args:[{$ref:"/answers/file/confidence"},.8]},select:{file:{from:{$ref:"/prepared/files/records"},key:{$ref:"/answers/file/choice"}}}},read:{type:"bash",env:{TEXT:{$ref:"/nodes/pick/output/selected/file/text"}},script:"printf '%s' \"$TEXT\""}},returns:["read"]},{cwd:await cwd(),jev:adapter});
  expect((result.requested.read?.output as any).stdout).toBe("beta");
});

test("expanded graphs can exceed the former 300-entry cap", async () => {
  const items = Array.from({ length: 301 }, (_, index) => index);
  const graph: Graph = {
    version: 1, label: "Uncapped expansion", nodes: {}, limits: { maxJevCalls: 400 },
    groups: { batch: { kind: "foreach", items, template: "inspect", maxItems: items.length } },
    templates: { inspect: { nodes: { j: { type: "jev", state: { $ref: "/input" }, questions } } } },
    returns: ["batch"],
  };
  const result = await executeGraph(graph, { cwd: await cwd(), jev: judge() });
  expect(result.status).toBe("done");
  expect((result.requested.batch!.output as any).completed).toBe(301);
  expect(result.previews).toHaveLength(302);
  expect(result.previews.every(entry => entry.status === "done")).toBe(true);
});

test("Jev budget exhaustion drains work and emits graph.finished last", async () => {
  const events:ExecutionEvent[]=[];
  const graph:Graph={version:1,label:"limit",nodes:{},limits:{maxJevCalls:3},groups:{batch:{kind:"foreach",items:[1,2,3,4],template:"t",maxItems:4}},templates:{t:{nodes:{j:{type:"jev",state:{$ref:"/input"},questions,accept}}}}};
  const result=await executeGraph(graph,{cwd:await cwd(),jev:judge(.95,30),onEvent:e=>events.push(e)});
  expect(result.status).toBe("cancelled");
  const length=events.length;await Bun.sleep(50);expect(events.length).toBe(length);expect(events.at(-1)?.type).toBe("graph.finished");
});

test("plugin entry reloads between graphs and old registry stays pinned",async()=>{
  const directory=await cwd();await mkdir(join(directory,".jev/extractors"),{recursive:true});
  const file=join(directory,".jev/extractors/custom.ts");
  const source=(value:number)=>`export default {name:'custom',description:'Fixture',inputSchema:{},outputSchema:{type:'number'},run(){return ${value}}}`;
  await writeFile(file,source(1));const old=await ExtractorRegistry.load(directory);
  await writeFile(file,source(2));const fresh=await ExtractorRegistry.load(directory);
  const options={cwd:directory,signal:new AbortController().signal,artifactDir:directory,onActivity:()=>{}};
  expect(await old.run("custom",{}, {},options)).toBe(1);expect(await fresh.run("custom",{}, {},options)).toBe(2);
});

test("timeout preserves partial command output and cancellation terminates graph",async()=>{
  const result=await executeGraph({version:1,label:"timeout",nodes:{slow:{type:"bash",script:"echo started; sleep 5",timeoutMs:50}},returns:["slow"]},{cwd:await cwd()});
  expect(result.status).toBe("partial");expect(result.requested.slow?.error).toContain("timeout");
  expect((result.requested.slow?.output as any).stdout).toContain("started");
  expect(await readFile((result.requested.slow?.output as any).stdoutPath,"utf8")).toContain("started");
});

test("a join edge becomes ready as soon as that dependency finishes",async()=>{
  const events:ExecutionEvent[]=[];
  await executeGraph({version:1,label:"join",nodes:{fast:{type:"bash",script:"true"},slow:{type:"bash",script:"sleep .05"},join:{type:"bash",needs:["fast","slow"],script:"true"}}},{cwd:await cwd(),onEvent:e=>events.push(e)});
  const edge=events.findIndex(e=>e.type==="edge.ready"&&e.data.from==="fast");
  const slowFinished=events.findIndex(e=>e.type==="node.finished"&&e.nodeId==="slow");
  expect(edge).toBeGreaterThan(-1);expect(edge).toBeLessThan(slowFinished);
});

test("bash JSON output can expand newly discovered work without a model call",async()=>{
  const result=await executeGraph({version:1,label:"discover",nodes:{discover:{type:"bash",script:"printf '[\"alpha\",\"beta\"]'",outputFormat:"json"}},groups:{items:{kind:"foreach",items:{$ref:"/nodes/discover/output/json"},template:"read",maxItems:2}},templates:{read:{nodes:{show:{type:"bash",env:{VALUE:{$ref:"/input"}},script:"printf '%s' \"$VALUE\""}},output:{$ref:"/nodes/show/output/stdout"}}},returns:["items"]},{cwd:await cwd()});
  expect(result.status).toBe("done");expect((result.requested.items?.output as any).items.map((x:any)=>x.output)).toEqual(["alpha","beta"]);
});

test("the stdin payload is also readable through the file named by JIVE_STDIN",async()=>{
  const script="python3 - <<'PY'\nimport json,os\nprint(json.load(open(os.environ[\"JIVE_STDIN\"]))[\"n\"])\nPY";
  const result=await executeGraph({version:1,label:"stdin-file",nodes:{produce:{type:"bash",script:"printf '{\"n\":2}'",outputFormat:"json"},consume:{type:"bash",stdin:{$ref:"/nodes/produce/output/json"},script}},returns:["consume"]},{cwd:await cwd()});
  expect(result.status).toBe("done");expect((result.requested.consume?.output as any).stdout).toBe("2\n");
});

test("onItemFailure continue keeps failed items as records and lets the merge node skip them",async()=>{
  const graph:Graph={version:1,label:"tolerant",nodes:{
    merge:{type:"bash",stdin:{$ref:"/groups/batch/output/items"},script:"python3 -c 'import json,sys; items=json.load(sys.stdin); print(\",\".join(i[\"output\"] for i in items if i[\"status\"]==\"done\"))'"},
  },groups:{batch:{kind:"foreach",items:[1,2,3],template:"t",maxItems:3,onItemFailure:"continue"}},
  templates:{t:{nodes:{work:{type:"bash",env:{N:{$ref:"/input"}},script:"[ \"$N\" != 2 ] || exit 3; printf '%s' \"$N\""}},output:{$ref:"/nodes/work/output/stdout"}}},returns:["merge","batch"]};
  const result=await executeGraph(graph,{cwd:await cwd()});
  expect(result.status).toBe("done");expect(result.reason).toBeUndefined();
  expect((result.requested.merge?.output as any).stdout).toBe("1,3\n");
  const batch=result.requested.batch?.output as any;
  expect(batch.failed).toBe(1);expect(batch.items.map((i:any)=>i.status)).toEqual(["done","failed","done"]);
  expect(result.previews.find(p=>p.id==="batch[1]/work")?.status).toBe("failed");
  const strict=structuredClone(graph);delete (strict.groups!.batch as any).onItemFailure;
  const failed=await executeGraph(strict,{cwd:await cwd()});
  expect(failed.status).toBe("partial");expect(failed.previews.find(p=>p.id==="merge")?.status).toBe("blocked");
});

test("a rejected Jev answer is logged with its payload before the node fails",async()=>{
  const events:ExecutionEvent[]=[];
  const adapter:JevAdapter={async evaluate(){return {model:"fixture",answers:{ok:{type:"noul",noul:1.5}}};}};
  const result=await executeGraph({version:1,label:"bad-jev",nodes:{choose:{type:"jev",state:{},questions,accept}},returns:["choose"]},{cwd:await cwd(),jev:adapter,onEvent:e=>events.push(e)});
  expect(result.requested.choose?.status).toBe("failed");expect(result.requested.choose?.error).toContain("Invalid probability for ok");
  const logged=events.find(e=>e.type==="jev.response");
  expect(logged?.data.rejected).toContain("Invalid probability for ok");expect((logged?.data.answers as any).ok.noul).toBe(1.5);
});

test("a report carries failure evidence inline, names each blocker, and reports the root cause", async () => {
  const graph: Graph = { version: 1, label: "cascade", nodes: {
    // Registered before the failure, so a naive scan would report this node's error as the reason.
    blocked: { type: "bash", needs: ["probe"], script: "echo should-not-run" },
    downstream: { type: "bash", needs: ["blocked", "probe"], script: "echo should-not-run" },
    probe: { type: "bash", script: "echo 'ModuleNotFoundError: no such module' >&2; exit 1" },
    ordered: { type: "bash", needs: ["probe"], allowFailedDependencies: true, script: "echo runs-anyway" },
    independent: { type: "bash", script: "echo independent" },
  } };
  const result = await executeGraph(graph, { cwd: await cwd() });
  const preview = (id: string) => result.previews.find(p => p.id === id)!;
  // The exit code alone never explains a failure; the stderr tail has to travel with it.
  expect(preview("probe").preview).toContain("Command exited with 1");
  expect(preview("probe").preview).toContain("ModuleNotFoundError: no such module");
  expect(preview("blocked").preview).toBe("Blocked by probe (failed)");
  expect(preview("downstream").preview).toBe("Blocked by blocked (blocked), probe (failed)");
  expect(result.reason).toContain("Command exited with 1");
  expect(preview("ordered").status).toBe("done");
  expect(preview("independent").status).toBe("done");
});


test("synth receives only resolved bounded evidence and records model provenance", async () => {
  const events: ExecutionEvent[] = [];
  const requests: any[] = [];
  const adapter: SynthAdapter = {
    async generate(request) {
      requests.push(request);
      return {
        model: "fixture/synth",
        provider: "fixture",
        text: '{"patch":"replace prisma call"}',
        json: { patch: "replace prisma call" },
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, cachedTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const graph: Graph = {
    version: 1,
    label: "bounded synthesis",
    context: { target: { path: "src/db.ts", excerpt: "return prisma.user.findMany()" } },
    nodes: {
      write: {
        type: "synth",
        task: "Rewrite only the supplied excerpt to use Drizzle.",
        input: { $ref: "/context/target" },
        outputFormat: "json",
        maxOutputTokens: 512,
      },
    },
    returns: ["write"],
  };
  const result = await executeGraph(graph, { cwd: await cwd(), synth: adapter, onEvent: event => events.push(event) });
  expect(result.status).toBe("done");
  expect(requests).toEqual([{
    task: "Rewrite only the supplied excerpt to use Drizzle.",
    input: { path: "src/db.ts", excerpt: "return prisma.user.findMany()" },
    outputFormat: "json",
    maxOutputTokens: 512,
  }]);
  expect((result.requested.write?.output as any).json).toEqual({ patch: "replace prisma call" });
  expect(events.find(event => event.type === "synth.request")?.data).toMatchObject({ outputFormat: "json", maxOutputTokens: 512 });
  expect(events.find(event => event.type === "synth.response")?.data).toMatchObject({ model: "fixture/synth", provider: "fixture" });
});

test("synth budget is graph-wide across foreach expansion", async () => {
  let calls = 0;
  const adapter: SynthAdapter = {
    async generate() {
      calls++;
      await Bun.sleep(20);
      return { model: "fixture/synth", text: "ok" };
    },
  };
  const graph: Graph = {
    version: 1,
    label: "synth budget",
    nodes: {},
    limits: { maxSynthCalls: 2 },
    groups: { batch: { kind: "foreach", items: ["a", "b", "c"], template: "write", maxItems: 3, concurrency: 1 } },
    templates: { write: { nodes: { generate: { type: "synth", task: "Echo the supplied item.", input: { $ref: "/input" } } } } },
  };
  const result = await executeGraph(graph, { cwd: await cwd(), synth: adapter });
  expect(result.status).toBe("cancelled");
  expect(calls).toBe(2);
  expect(result.reason).toContain("Synthesis request budget (2) exhausted");
});
