export type KnowledgeBack = "case" | "workbench";

let knowledgeBack: KnowledgeBack = "workbench";

export function markKnowledgeBack(value: KnowledgeBack): void {
  knowledgeBack = value;
}

export function takeKnowledgeBack(): KnowledgeBack {
  return knowledgeBack;
}
