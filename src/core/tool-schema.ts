/**
 * The execute_graph tool parameters as sent to planning models.
 *
 * This is deliberately NOT graphSchema. The strict schema relies on const, $ref/$defs, oneOf,
 * additionalProperties:false, uniqueItems, maxProperties and propertyNames, which several
 * OpenRouter providers strip from function declarations. Models then see `version: {}` and
 * `nodes: {}` with no type and send `"version":"1"` or a JSON-encoded string for nodes.
 *
 * Here every field carries a type, an enum where the value is fixed, and a description, which
 * are the keywords every provider forwards. Validation still runs against graphSchema; a test
 * keeps the two property sets in sync.
 */
const ID_RULE = "IDs must match ^[a-zA-Z][a-zA-Z0-9_-]*$ and be unique across nodes and groups.";
const REF_RULE = "May contain expressions: an object with exactly one $ref key holding a JSON pointer such as /nodes/ID/output/stdout or /context.";

const condition = {
  type: "object",
  description: "Condition {op,args}. op is one of eq, ne, gt, gte, lt, lte, and, or, not, exists, in. args holds the operands; and/or/not take nested conditions. Operands may be $ref expressions.",
  required: ["op", "args"],
  properties: {
    op: { type: "string", enum: ["eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not", "exists", "in"], description: "Comparison or boolean operator." },
    args: { type: "array", items: {}, description: "Operands: literals, $ref expressions, or nested conditions for and/or/not." },
  },
};

const common = {
  label: { type: "string", description: "Optional short human-readable label (max 200 chars)." },
  needs: { type: "array", items: { type: "string" }, description: "IDs of nodes/groups that must SUCCEED first, without passing a value. A listed entry that fails, is skipped or is itself blocked blocks this one too, so do not chain work that is merely sequential; for ordering alone add allowFailedDependencies:true." },
  when: { ...condition, description: `Optional gate. ${condition.description} A false result skips this entry.` },
  allowFailedDependencies: { type: "boolean", description: "Still wait for every dependency, but run whatever their outcome. This is the ordering-only dependency: use it when two entries touch the same files but neither needs the other to have succeeded, or with a status/error condition for explicit recovery." },
  onError: { type: "string", enum: ["continue", "stop"], description: "stop requests global cancellation when this entry fails. Default continue." },
};

const node = {
  type: "object",
  description: "One executable node. bash runs a shell command, jev makes a bounded semantic judgment, and synth performs bounded tool-less generation from explicit evidence. Type-specific fields apply only to their node type.",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["bash", "jev", "synth"], description: "Node type. Exactly \"bash\", \"jev\", or \"synth\"." },
    ...common,
    script: { type: "string", description: "bash-only, required. Shell script text. Pass data in through env or stdin, never by pasting returned strings into the script." },
    cwd: { type: "string", description: "bash-only. Working directory for the script; defaults to the session directory." },
    env: { type: "object", description: `bash-only. Environment variables for the script. Values are strings or expressions. ${REF_RULE}` },
    stdin: { description: `bash-only. Text or expression fed to standard input; a referenced array or object arrives as JSON. The same payload is saved to a file whose path is in $JIVE_STDIN, so a heredoc program can read it from there. ${REF_RULE}` },
    timeoutMs: { type: "integer", description: "bash-only. Timeout in milliseconds (1 to 3600000). Default 60000 (60 seconds), also bounded by the graph timeout." },
    acceptedExitCodes: { type: "array", items: { type: "integer" }, description: "bash-only. Exit codes that count as success. Defaults to [0]; use [0,1] for rg or a test run." },
    outputFormat: { type: "string", enum: ["text", "json"], description: "bash-only. json additionally parses stdout into output.json." },
    state: { description: `jev-only, required. The evidence Jev reasons over: source, goal, constraints. ${REF_RULE}` },
    questions: {
      type: "object", description: `jev-only, required. Map of question ID to a question, or a $ref to a question map. IDs carry no meaning: instructions must give the complete question. ${REF_RULE}`,
      properties: { $ref: { type: "string", description: "Alternatively reference an entire question map." } },
      additionalProperties: {
        type: "object",
        properties: {
          $ref: { type: "string", description: "Alternatively reference an entire question definition. Direct definitions require type and instructions." },
          type: { type: "string", enum: ["choice", "score", "noul"], description: "Required for direct questions: choice selects an option, score rates ordered levels, noul estimates a yes-probability." },
          instructions: { description: "Complete question text or structured instructions. Include the goal and relevant constraints." },
          criteria: { description: 'choice: object mapping 2–255 option IDs to descriptions. score: array of 2–10 ordered descriptions, indexed from 0. noul: omit. May be a $ref. Example choice: {"keep":"Relevant","skip":"Irrelevant"}; score: ["Poor","Adequate","Good"].' },
        },
        description: 'choice answer: {type:"choice",choice:OPTION_ID,confidence:number,probabilities:{OPTION_ID:number,...}}. score answer: {type:"score",score:number,confidence:number,probabilities:{"0":number,...}}; score can be fractional. noul answer: {type:"noul",noul:number} is a yes-probability without confidence. All probabilities are 0–1. Results are /nodes/ID/output/answers/QUESTION.',
      },
    },
    accept: { ...condition, description: `jev-only, optional. Omit to accept every schema-valid answer. Use for deliberate handoff on uncertainty. References inside accept use /answers/QUESTION/..., e.g. {op:"gte",args:[{$ref:"/answers/q/confidence"},0.8]}. ${condition.description}` },
    prepare: {
      type: "array",
      description: "jev-only. Extractors to run in order before the call; outputs are available as /prepared/NAME inside this node.",
      items: {
        type: "object",
        required: ["use", "as", "input"],
        properties: {
          use: { type: "string", description: "Installed extractor name from the catalog." },
          as: { type: "string", description: "Name exposed as /prepared/NAME." },
          input: { description: `Extractor input. ${REF_RULE}` },
          config: { description: "Optional extractor configuration." },
        },
      },
    },
    task: { description: `synth-only, required. Bounded generation objective. May reference prior graph outputs. ${REF_RULE}` },
    input: { description: `synth-only, required. Explicit evidence/context supplied to the generator; synth has no tools or independent repository access. ${REF_RULE}` },
    model: { type: "string", description: "synth-only. Optional OpenRouter model ID; defaults to JIVE_SYNTH_MODEL or the runtime default." },
    effort: { type: "string", description: "synth-only. Optional reasoning effort supported by the selected model." },
    maxOutputTokens: { type: "integer", description: "synth-only. Output-token ceiling, 1 to 32768. Default 4096." },
    select: {
      type: "object",
      description: "jev-only. Map of NAME to {from,key}: after acceptance, pick the original value at from[key] and expose it as output.selected/NAME.",
      additionalProperties: {
        type: "object",
        description: "Selection rule {from,key}.",
        required: ["from", "key"],
        properties: {
          from: { description: "Expression for the collection, e.g. {\"$ref\":\"/prepared/files/records\"}." },
          key: { description: "Expression for the chosen key, e.g. {\"$ref\":\"/answers/file/choice\"}." },
        },
      },
    },
  },
};

const group = {
  type: "object",
  description: "Structured repetition over a submitted template. kind \"foreach\" instantiates the template per item; kind \"repeat\" iterates with carried state until a condition holds. Fields marked foreach-only or repeat-only apply to that kind.",
  required: ["kind", "template"],
  properties: {
    kind: { type: "string", enum: ["foreach", "repeat"], description: "Group kind. Exactly \"foreach\" or \"repeat\"." },
    ...common,
    template: { type: "string", description: "Name of a template declared in the root templates map." },
    items: { description: `foreach-only, required. A JSON array, or a {"$ref": ...} expression that resolves to one. ${REF_RULE}` },
    input: { description: "foreach-only. Mapping evaluated per item with /item, /index and parent outputs; becomes /input inside the template. Defaults to the item." },
    maxItems: { type: "integer", description: "foreach-only, required. Upper bound on collection size (1 to 5000); a larger collection fails explicitly." },
    concurrency: { type: "integer", description: "foreach-only. Parallel instances (1 to 32). Defaults to limits.concurrency (6 unless overridden)." },
    onItemFailure: { type: "string", enum: ["fail", "continue"], description: "foreach-only. continue records a failed item in output.items with status \"failed\" and lets the group finish so a merge node can skip it; the default fail ends the group at the first failed item. Yields still propagate." },
    initial: { description: `repeat-only, required. Initial /state for the first iteration. ${REF_RULE}` },
    next: { description: "repeat-only, required. Expression evaluated after each iteration to produce the next /state." },
    until: { ...condition, description: `repeat-only, required. Evaluated after the body; true stops iterating. ${condition.description}` },
    maxIterations: { type: "integer", description: "repeat-only, required. Upper bound on iterations (1 to 1000); exhaustion is explicit." },
  },
};

const body = {
  type: "object",
  description: "Template body instantiated by groups. Inside, /input, /item, /index, /state, /context and local /nodes and /groups are in scope.",
  required: ["nodes"],
  properties: {
    nodes: { type: "object", description: `Map of node ID to node definition. Must be a JSON object, not a JSON-encoded string. ${ID_RULE}`, additionalProperties: node },
    groups: { type: "object", description: `Map of group ID to group definition. Must be a JSON object. ${ID_RULE}`, additionalProperties: group },
    output: { description: "Optional small typed result resolved from local references, e.g. {\"text\":{\"$ref\":\"/nodes/read/output/stdout\"}}." },
  },
};

export const graphToolParameters: Record<string, unknown> = {
  type: "object",
  description: "A declarative graph of bash, Jev, and bounded synth nodes. Execution starts as complete nodes arrive. Write version, label and any context/templates/limits/output before nodes/groups; omitted settings use defaults. Emit nodes/groups in dependency order. returns may come last.",
  required: ["version", "label", "nodes"],
  properties: {
    version: { type: "integer", enum: [1], description: "Contract version. Always the JSON number 1, never the string \"1\"." },
    label: { type: "string", description: "Required short human-readable name for this graph (1 to 200 chars)." },
    context: { description: "Arbitrary JSON available to every node as /context." },
    templates: { type: "object", description: "Map of template name to {nodes,groups?,output?}. Groups can only instantiate templates declared here. No recursion.", additionalProperties: body },
    limits: {
      type: "object",
      description: "Optional execution bounds.",
      properties: {
        concurrency: { type: "integer", description: "1 to 32. Default 6 concurrent leaf nodes." },
        timeoutMs: { type: "integer", description: "1 to 3600000. Default 300000 (5 minutes), starting when execution begins." },
        maxJevCalls: { type: "integer", description: "0 to 1000. Default 100. 0 declares a graph with no Jev nodes." },
        maxSynthCalls: { type: "integer", description: "0 to 1000. Default 100. 0 declares a graph with no synth nodes." },
      },
    },
    output: { description: "Optional small typed result resolved from root references." },
    nodes: { type: "object", description: `Required map of node ID to node definition. Must be a JSON object, not a JSON-encoded string. At most 200 entries. ${ID_RULE}`, additionalProperties: node },
    groups: { type: "object", description: `Map of group ID to foreach/repeat group. Must be a JSON object. At most 100 entries. ${ID_RULE}`, additionalProperties: group },
    returns: { type: "array", items: { type: "string" }, description: "IDs of root nodes/groups whose full result envelopes you want back. Ask for the useful evidence, not everything." },
  },
};
