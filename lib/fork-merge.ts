import type {
  ArtifactSourceFile,
  ArtifactSourcePath,
} from "./starter-artifact";

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
  return byPath;
}

function sameFile(
  left: ArtifactSourceFile | undefined,
  right: ArtifactSourceFile | undefined,
) {
  return left?.content === right?.content && left?.language === right?.language;
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
  const paths = Array.from(
    new Set([...ancestor.keys(), ...target.keys(), ...branch.keys()]),
  ).sort((left, right) => left.localeCompare(right));

  for (const path of paths) {
    const baseFile = ancestor.get(path);
    const targetFile = target.get(path);
    const branchFile = branch.get(path);
    const branchChanged = !sameFile(branchFile, baseFile);
    const targetChanged = !sameFile(targetFile, baseFile);

    if (branchChanged) branchChangedPaths.push(path);

    if (branchChanged && targetChanged && !sameFile(branchFile, targetFile)) {
      conflicts.push(path);
      if (targetFile) files.push({ ...targetFile });
      continue;
    }

    const nextFile = branchChanged ? branchFile : targetFile;
    if (!sameFile(nextFile, targetFile)) mergedPaths.push(path);
    if (nextFile) files.push({ ...nextFile });
  }

  return {
    files,
    branchChangedPaths,
    mergedPaths,
    conflicts,
  };
}
