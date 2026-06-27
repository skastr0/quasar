import { fg, StyledText } from "@opentui/core";

import { matchRanges } from "./format";
import { palette } from "./palette";

type Chunk = ReturnType<ReturnType<typeof fg>>;

/**
 * Build styled content for `text` with query terms painted amber. Returns a
 * StyledText that <text content=...> renders as colored runs.
 */
export const highlight = (text: string, query: string, baseColor: string = palette.text): StyledText => {
  const ranges = matchRanges(text, query);
  const chunks: Chunk[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) chunks.push(fg(baseColor)(text.slice(cursor, start)));
    chunks.push(fg(palette.amber)(text.slice(start, end)));
    cursor = end;
  }
  if (cursor < text.length) chunks.push(fg(baseColor)(text.slice(cursor)));
  if (chunks.length === 0) chunks.push(fg(baseColor)(text));
  return new StyledText(chunks);
};
