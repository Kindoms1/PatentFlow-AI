import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_LIBRARY_QUERY,
  domainOptions,
  entryBadges,
  entryIpc,
  exportPlan,
  ipcOptions,
  isFiltered,
  libraryView,
  pickEntry,
  referenceUrl,
} from "./library-view.ts";
import { LIBRARY_SAMPLES, REAL_REFERENCES, TECH_DOMAINS, libraryEntries } from "./patent-library.ts";
import { builtInKnowledge } from "./model.ts";

test("the unfiltered view lists every library entry", () => {
  const view = libraryView(EMPTY_LIBRARY_QUERY);
  assert.equal(view.ok, true);
  assert.equal(view.total, libraryEntries().length);
  assert.equal(view.entries.length, view.total);
  assert.equal(isFiltered(EMPTY_LIBRARY_QUERY), false);
});

test("kind, domain, IPC and keyword filters narrow the list", () => {
  const samples = libraryView({ ...EMPTY_LIBRARY_QUERY, kind: "sample" });
  assert.equal(samples.entries.length, LIBRARY_SAMPLES.length);
  assert.ok(samples.entries.every((entry) => entry.kind === "sample" && entry.fictional));

  const medical = libraryView({ ...EMPTY_LIBRARY_QUERY, domainId: "medical-device" });
  assert.ok(medical.entries.length > 0);
  assert.ok(medical.entries.every((entry) => entry.domainIds.includes("medical-device")));

  const a61b = libraryView({ ...EMPTY_LIBRARY_QUERY, ipc: "a61b" });
  assert.ok(a61b.entries.some((entry) => entry.title.includes("CN117860254B")));
  assert.ok(a61b.entries.every((entry) => entry.ipc.some((code) => code.toUpperCase().replace(/\s+/g, "").startsWith("A61B"))));

  const none = libraryView({ ...EMPTY_LIBRARY_QUERY, query: "完全不存在的关键词zzqx" });
  assert.equal(none.ok, true);
  assert.equal(none.entries.length, 0);
  assert.equal(isFiltered({ ...EMPTY_LIBRARY_QUERY, query: "x" }), true);
});

test("domain options exclude the general fallback and IPC options come only from library data", () => {
  const domains = domainOptions();
  assert.equal(domains[0].id, "all");
  assert.ok(!domains.some((item) => item.id === "general"));
  assert.equal(domains.length, TECH_DOMAINS.length);

  const all = ipcOptions("all");
  assert.ok(all.length > 0);
  assert.ok(all.every((item) => /^[A-H]\d{2}[A-Z]$/.test(item.code)));
  const known = new Set(libraryEntries().flatMap((entry) => entry.ipc.map((code) => code.replace(/\s+/g, "").slice(0, 4).toUpperCase())));
  assert.ok(all.every((item) => known.has(item.code)));

  const mechanical = TECH_DOMAINS.find((domain) => domain.id === "mechanical");
  assert.ok(mechanical);
  const mechOptions = ipcOptions("mechanical").map((item) => item.code);
  for (const item of mechanical.ipc) assert.ok(mechOptions.includes(item.code.replace(/\s+/g, "").slice(0, 4)));
});

test("references keep verified IPC and URL only, and leave unread IPC empty", () => {
  const entries = libraryEntries();
  const withIpc = entries.find((entry) => entry.id === "lib-ref-cn117860254b");
  assert.ok(withIpc);
  assert.deepEqual(entryIpc(withIpc), ["A61B 5/22", "A61B 5/11", "A61N 1/36"]);
  assert.equal(referenceUrl(withIpc), REAL_REFERENCES.find((ref) => ref.id === "ref-cn117860254b")?.url);

  for (const id of ["lib-ref-cn107438544b", "lib-ref-cn116888108b"]) {
    const entry = entries.find((item) => item.id === id);
    assert.ok(entry, id);
    assert.deepEqual(entryIpc(entry), []);
  }

  const official = entries.find((entry) => entry.id === "lib-ref-cnipa-training");
  assert.ok(official);
  assert.equal(referenceUrl(official), "");
  const sample = entries.find((entry) => entry.kind === "sample");
  assert.ok(sample);
  assert.equal(referenceUrl(sample), "");
});

test("only fictional samples can be exported as Word", () => {
  for (const entry of libraryEntries()) {
    const plan = exportPlan(entry);
    if (entry.kind === "sample") {
      assert.equal(plan.ok, true, entry.id);
      if (plan.ok) {
        assert.ok(plan.markdown.includes("权利要求"), entry.id);
        assert.ok(plan.fileStem.length > 0 && !plan.fileStem.includes("（虚构示范）"));
      }
      assert.ok(entryBadges(entry).some((badge) => badge.text === "虚构示范"));
    } else {
      assert.equal(plan.ok, false, entry.id);
      if (!plan.ok) assert.ok(plan.reason.length > 0);
      assert.ok(!entryBadges(entry).some((badge) => badge.text === "虚构示范"));
    }
  }
  const empty = exportPlan(null);
  assert.equal(empty.ok, false);
});

test("pickEntry falls back to the first result and to null when empty", () => {
  const entries = libraryEntries();
  assert.equal(pickEntry(entries, entries[1].id)?.id, entries[1].id);
  assert.equal(pickEntry(entries, "missing")?.id, entries[0].id);
  assert.equal(pickEntry([], "missing"), null);
});

test("library entries can be queued into the chat through builtInKnowledge with an ISO time", () => {
  const doc = builtInKnowledge("lib-sample-mech-pipe-clamp");
  assert.ok(doc);
  assert.equal(doc.kind, "text");
  assert.ok(doc.name.startsWith("虚构示范-"));
  assert.equal(doc.chars, doc.text.length);
  assert.ok(!Number.isNaN(Date.parse(doc.at)));
  assert.equal(builtInKnowledge("lib-does-not-exist"), null);
});
