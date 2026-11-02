import type { AgentEvent } from "./agent-events.ts";
import { citedSources, createNdjsonParser } from "./agent-stream.ts";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const events: AgentEvent[] = [];
const parser = createNdjsonParser((event) => events.push(event));
parser.push('{"type":"start","model":"m","provider":"p","tools":[]}\n{"type":"del');
parser.push('ta","text":"你"}\nnot json\n{"type":"unknown"}\n');
parser.push('{"type":"done","text":"你","sources":[],"steps":1,"model":"m","usage":{"input":0,"output":0}}');
parser.end();
check(events.map((event) => event.type).join(",") === "start,delta,done", "NDJSON parser should survive torn chunks and junk lines");

const sources = [
  { n: 1, title: "a", url: "https://a", via: "search" as const },
  { n: 2, title: "b", url: "https://b", via: "search" as const },
];
check(citedSources("见 [2]。", sources).map((item) => item.n).join(",") === "2", "cited sources should keep only [2]");
check(citedSources("没有引用", sources).length === 2, "uncited answer should keep every source");

console.log("agent stream checks passed");
