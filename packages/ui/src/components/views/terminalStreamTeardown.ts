export type TerminalStreamContext = { directory: string; tabId: string; terminalId: string };

export const shouldTeardownStreamOnCleanup = (
    streamContext: TerminalStreamContext | null,
    effectDirectory: string | null,
    effectTabId: string | null,
    activeTerminalId: string | null
): boolean => {
    if (streamContext === null) {
        return true;
    }
    const sameContext =
        streamContext.directory === effectDirectory &&
        streamContext.tabId === effectTabId &&
        activeTerminalId === streamContext.terminalId;
    return !sameContext;
};
