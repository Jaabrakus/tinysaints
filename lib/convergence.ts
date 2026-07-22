import type { ArtifactSourceFile } from "./starter-artifact";

export type ProjectChange = { path: string; content: string | null };

export function projectChangesBetween(
  ancestor: ReadonlyArray<ArtifactSourceFile>,
  branch: ReadonlyArray<ArtifactSourceFile>,
): ProjectChange[] {
  const ancestorByPath = new Map(ancestor.map((file) => [file.path, file.content]));
  const branchByPath = new Map(branch.map((file) => [file.path, file.content]));
  const paths = Array.from(new Set([...ancestorByPath.keys(), ...branchByPath.keys()])).sort();
  const changes: ProjectChange[] = [];
  for (const path of paths) {
    const before = ancestorByPath.get(path);
    const after = branchByPath.get(path);
    if (before === after) continue;
    changes.push({ path, content: after ?? null });
  }
  return changes;
}
