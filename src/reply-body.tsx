import type { ReactNode } from "react";

export function ReplyBody({ text }: { text: string }) {
  return (
    <div className="reply-body">
      {splitBlocks(text).map((block, index) => {
        const key = `${index}-${block.slice(0, 24)}`;
        if (block === "---") return <hr key={key} />;
        if (block.startsWith("### ")) return <h3 key={key}>{inline(block.slice(4))}</h3>;
        if (block.startsWith("## ")) return <h2 key={key}>{inline(block.slice(3))}</h2>;
        if (block.startsWith("# ")) return <h2 key={key}>{inline(block.slice(2))}</h2>;
        if (block.includes("\n|") || block.startsWith("|")) return <TableBlock key={key} text={block} />;
        if (block.split("\n").every((line) => /^[-*]\s/.test(line))) {
          return (
            <ul key={key}>
              {block.split("\n").map((line) => (
                <li key={line}>{inline(line.replace(/^[-*]\s/, ""))}</li>
              ))}
            </ul>
          );
        }
        return <p key={key}>{inline(block)}</p>;
      })}
    </div>
  );
}

function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.trim() === "---") {
      flush();
      blocks.push("---");
      continue;
    }
    const heading = /^#{1,3}\s/.test(line);
    const table = line.trim().startsWith("|");
    const list = /^[-*]\s/.test(line);
    const prev = current[0] || "";
    const prevTable = prev.trim().startsWith("|");
    const prevList = /^[-*]\s/.test(prev);
    if (current.length && (heading || (table !== prevTable) || (list !== prevList && !table))) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function TableBlock({ text }: { text: string }) {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .filter((line) => !/^\|?\s*:?-{3,}/.test(line.replace(/\|/g, "")))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  if (rows.length === 0) return <p>{inline(text)}</p>;
  const [head, ...body] = rows;
  const pairs = body.length && head.length === 2
    ? body
    : body.map((row) => [row[0] || "", row.slice(1).join(" / ")]);
  return (
    <dl>
      {pairs.map((row) => (
        <div key={row.join("-")}>
          <dt>{inline(row[0] || "")}</dt>
          <dd>{inline(row[1] || "")}</dd>
        </div>
      ))}
    </dl>
  );
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
