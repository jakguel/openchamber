export type ExternalChangeStat = {
  path?: string;
  size?: number;
  mtimeMs?: number;
};

export type ExternalChangeAction = 'write' | 'refuse-safe-path' | 'live-apply';

export function hasExternalStatChange(
  currentStat: ExternalChangeStat | null | undefined,
  loadedStat: ExternalChangeStat | null | undefined,
): boolean {
  if (!currentStat || !loadedStat) {
    return false;
  }

  const isSameFile =
    currentStat.path === undefined ||
    loadedStat.path === undefined ||
    currentStat.path === loadedStat.path;
  if (!isSameFile) {
    return false;
  }

  const changedByMtime =
    currentStat.mtimeMs !== undefined &&
    loadedStat.mtimeMs !== undefined &&
    currentStat.mtimeMs !== loadedStat.mtimeMs;

  const changedBySize =
    currentStat.size !== undefined &&
    loadedStat.size !== undefined &&
    currentStat.size !== loadedStat.size;

  return changedByMtime || changedBySize;
}

export function resolveExternalChangeAction(input: {
  currentStat: ExternalChangeStat | null | undefined;
  loadedStat: ExternalChangeStat | null | undefined;
  isDirty: boolean;
}): ExternalChangeAction {
  if (!hasExternalStatChange(input.currentStat, input.loadedStat)) {
    return 'write';
  }
  return input.isDirty ? 'refuse-safe-path' : 'live-apply';
}

export function shouldSurfaceConflict(
  latestStat: ExternalChangeStat | null | undefined,
  lastSurfacedStat: ExternalChangeStat | null | undefined,
): boolean {
  if (!lastSurfacedStat) {
    return true;
  }
  return hasExternalStatChange(latestStat, lastSurfacedStat);
}

export async function runGuardedWrite(params: {
  forceOverwrite: boolean;
  isDirty: boolean;
  loadedStat: ExternalChangeStat | null | undefined;
  readCurrentStat: () => Promise<ExternalChangeStat | null | undefined>;
  onRefuse: () => void;
  write: () => Promise<boolean>;
}): Promise<boolean> {
  if (!params.forceOverwrite) {
    const currentStat = await params.readCurrentStat();
    const action = resolveExternalChangeAction({
      currentStat,
      loadedStat: params.loadedStat,
      isDirty: params.isDirty,
    });
    if (action === 'refuse-safe-path') {
      params.onRefuse();
      return false;
    }
  }
  return params.write();
}
