export type StreamPhase = 'streaming' | 'cooldown' | 'completed';

export type DiffViewMode = 'side-by-side' | 'unified';

export interface AgentMentionInfo {
    name: string;
    token: string;
}

export interface ToolPopupContent {
    open: boolean;
    title: string;
    content: string;
    language?: string;
    isDiff?: boolean;
    diffHunks?: Array<Record<string, unknown>>;
    metadata?: Record<string, unknown>;
    image?: {
        url: string;
        mimeType?: string;
        filename?: string;
        size?: number;
        gallery?: Array<{
            url: string;
            mimeType?: string;
            filename?: string;
            size?: number;
        }>;
        index?: number;
    };
    // Renderer-agnostic diagram payload for the fullscreen popup. `kind` lets the popup
    // route mermaid today and plantuml (Story D) tomorrow through the same dialog.
    diagram?: {
        kind: 'mermaid' | 'plantuml';
        url: string;
        mimeType?: string;
        filename?: string;
        source?: string;
    };
}
