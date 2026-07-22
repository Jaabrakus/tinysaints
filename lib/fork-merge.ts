import type {
  ArtifactSourceFile,
  ArtifactSourcePath,
} from "./starter-artifact";

const mergeSourcePaths: ArtifactSourcePath[] = ["index.html", "styles.css"];

export type ForkMergeResult = {
  files: ArtifactSourceFile[];
  branchChangedPaths: ArtifactSourcePath[];
  mergedPaths: ArtifactSourcePath[];
  conflicts: ArtifactSourcePath[];
};

function snapshotByPath(files: ReadonlyArray<ArtifactSourceFile>) {
  const byPath = new Map<ArtifactSourcePath, ArtifactSourceFile>();
  for (const file of files) {
    if (byPath.has(file.path)) {
      throw new Error(`Duplicate source path: ${file.path}`);
    }
    byPath.set(file.path, file);
  }
  for (const path of mergeSourcePaths) {
    if (!byPath.has(path)) throw new Error(`Missing source path: ${path}`);
  }
  return byPath;
}

/**
 * Three-way, file-level merge for a fork converging into its parent room.
 * Files changed on only one side merge automatically. A file changed to two
 * different values stops as a conflict so neither contributor loses work.
 */
export function mergeForkSourceSnapshots(
  ancestorFiles: ReadonlyArray<ArtifactSourceFile>,
  targetFiles: ReadonlyArray<ArtifactSourceFile>,
  branchFiles: ReadonlyArray<ArtifactSourceFile>,
): ForkMergeResult {
  const ancestor = snapshotByPath(ancestorFiles);
  const target = snapshotByPath(targetFiles);
  const branch = snapshotByPath(branchFiles);
  const files: ArtifactSourceFile[] = [];
  const branchChangedPaths: ArtifactSourcePath[] = [];
  const mergedPaths: ArtifactSourcePath[] = [];
  const conflicts: ArtifactSourcePath[] = [];

  for (const path of mergeSourcePaths) {
    const baseFile = ancestor.get(path)!;
    const targetFile = target.get(path)!;
    const branchFile = branch.get(path)!;
    const branchChanged = branchFile.content !== baseFile.content;
    const targetChanged = targetFile.content !== baseFile.content;

    if (branchChanged) branchChangedPaths.push(path);

    if (branchChanged && targetChanged && branchFile.content !== targetFile.content) {
      conflicts.push(path);
      files.push({ ...targetFile });
      continue;
    }

    const nextFile = branchChanged ? branchFile : targetFile;
    if (nextFile.content !== targetFile.content) mergedPaths.push(path);
    files.push({ ...nextFile });
  }

  return { files, branchChangedPaths, mergedPaths, conflicts };
}
