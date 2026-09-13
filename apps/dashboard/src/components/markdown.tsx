import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small Markdown subset for agent summaries: paragraphs, "-" lists, `code`,
 * **bold** and https links. Builds React elements (never innerHTML), so model output and
 * repository text cannot inject markup.
 */

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|https:\/\/[^\s)]+)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noreferrer">
          {token}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const LIST_ITEM = /^\s*[-*] /;

/** Splits a block into runs of plain lines and list lines, so "Also added:\n- a\n- b" works. */
function runs(lines: string[]): { list: boolean; lines: string[] }[] {
  const out: { list: boolean; lines: string[] }[] = [];
  for (const line of lines) {
    const list = LIST_ITEM.test(line);
    const current = out.at(-1);
    if (current && current.list === list) current.lines.push(line);
    else out.push({ list, lines: [line] });
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <div className="markdown">
      {blocks.flatMap((block, b) =>
        runs(block.split("\n")).map((run, r) => {
          const key = `b${b}-${r}`;
          if (run.list) {
            return (
              <ul key={key}>
                {run.lines.map((line, l) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static text, lines never reorder
                  <li key={`${key}-${l}`}>{inline(line.replace(LIST_ITEM, ""), `${key}-${l}`)}</li>
                ))}
              </ul>
            );
          }
          return (
            <p key={key}>
              {run.lines.map((line, l) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static text, lines never reorder
                <Fragment key={`${key}-${l}`}>
                  {l > 0 && <br />}
                  {inline(line, `${key}-${l}`)}
                </Fragment>
              ))}
            </p>
          );
        }),
      )}
    </div>
  );
}
