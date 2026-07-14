import type { Session } from '@opencode-ai/sdk/v2';
import { compareSessionsByPinnedAndTime } from './utils';

export type SessionTreeResult = {
  roots: Session[];
  childrenByParentId: Map<string, Session[]>;
};

const isArchivedSession = (session: Session): boolean => Boolean(session.time?.archived);

export function partitionSessionTree(
  sessions: Session[],
  pinnedSessionIds: Set<string>,
): SessionTreeResult {
  const sessionMap = new Map<string, Session>(sessions.map((s) => [s.id, s]));
  const childrenByParentId = new Map<string, Session[]>();

  for (const session of sessions) {
    const parentID = (session as Session & { parentID?: string | null }).parentID;
    if (!parentID) continue;
    const parent = sessionMap.get(parentID);
    if (!parent || isArchivedSession(parent) !== isArchivedSession(session)) continue;
    const list = childrenByParentId.get(parentID) ?? [];
    list.push(session);
    childrenByParentId.set(parentID, list);
  }

  childrenByParentId.forEach((list) => {
    list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));
  });

  const roots = sessions.filter(
    (s) => !(s as Session & { parentID?: string | null }).parentID,
  );

  return { roots, childrenByParentId };
}
