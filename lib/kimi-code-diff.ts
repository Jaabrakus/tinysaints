/**
 * Adapted from Moonshot AI's Kimi Code line-diff utility:
 * https://github.com/MoonshotAI/kimi-code/blob/e0f2a417691701e9bc73eaf5feebd4b667f5efab/apps/kimi-web/src/lib/diffLines.ts
 *
 * Copyright (c) 2026 Moonshot AI. Licensed under the MIT License. See
 * THIRD_PARTY_NOTICES.md for the complete license notice.
 */

export interface DiffViewLine {
  type: "add" | "del" | "context" | "hunk";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/**
 * Maximum LCS matrix size (`(oldLines + 1) * (newLines + 1)`) allocated in the
 * browser. Larger comparisons fall back to a non-diff presentation.
 */
const MAX_DIFF_CELLS = 1_000_000;

/** Bounds both the output rows and highly asymmetric comparisons. */
const MAX_DIFF_ROWS = 5000;

function splitLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  // A trailing newline does not represent an additional content line.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Builds a line-level LCS diff. Line numbers are one-based and advance on the
 * corresponding side: context advances both, deletion advances old, and
 * addition advances new.
 *
 * Returns `null` when the inputs exceed the client-side safety caps.
 */
export function buildDiffLines(before: string, after: string): DiffViewLine[] | null {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const oldLength = oldLines.length;
  const newLength = newLines.length;

  if (oldLength === 0 && newLength === 0) return [];
  if (oldLength > MAX_DIFF_ROWS || newLength > MAX_DIFF_ROWS) return null;
  if ((oldLength + 1) * (newLength + 1) > MAX_DIFF_CELLS) return null;

  const matrix: number[][] = Array.from({ length: oldLength + 1 }, () =>
    Array.from({ length: newLength + 1 }, () => 0),
  );

  for (let oldIndex = 1; oldIndex <= oldLength; oldIndex++) {
    for (let newIndex = 1; newIndex <= newLength; newIndex++) {
      matrix[oldIndex]![newIndex] =
        oldLines[oldIndex - 1] === newLines[newIndex - 1]
          ? matrix[oldIndex - 1]![newIndex - 1]! + 1
          : Math.max(matrix[oldIndex - 1]![newIndex]!, matrix[oldIndex]![newIndex - 1]!);
    }
  }

  type Operation = { type: "context" | "add" | "del"; text: string };
  const operations: Operation[] = [];
  let oldIndex = oldLength;
  let newIndex = newLength;

  while (oldIndex > 0 || newIndex > 0) {
    if (
      oldIndex > 0 &&
      newIndex > 0 &&
      oldLines[oldIndex - 1] === newLines[newIndex - 1]
    ) {
      operations.push({ type: "context", text: oldLines[oldIndex - 1]! });
      oldIndex--;
      newIndex--;
    } else if (
      newIndex > 0 &&
      (oldIndex === 0 || matrix[oldIndex]![newIndex - 1]! >= matrix[oldIndex - 1]![newIndex]!)
    ) {
      operations.push({ type: "add", text: newLines[newIndex - 1]! });
      newIndex--;
    } else {
      operations.push({ type: "del", text: oldLines[oldIndex - 1]! });
      oldIndex--;
    }
  }

  operations.reverse();

  const result: DiffViewLine[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  for (const operation of operations) {
    if (operation.type === "context") {
      result.push({
        type: "context",
        text: operation.text,
        oldNo: oldLineNumber,
        newNo: newLineNumber,
      });
      oldLineNumber++;
      newLineNumber++;
    } else if (operation.type === "add") {
      result.push({ type: "add", text: operation.text, newNo: newLineNumber });
      newLineNumber++;
    } else {
      result.push({ type: "del", text: operation.text, oldNo: oldLineNumber });
      oldLineNumber++;
    }
  }

  return result;
}

export function diffStats(lines: DiffViewLine[]): DiffStats {
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }

  return { added, removed };
}
