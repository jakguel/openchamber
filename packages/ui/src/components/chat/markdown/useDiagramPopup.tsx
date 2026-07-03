import React from 'react';
import type { ToolPopupContent } from '../message/types';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Reusable fullscreen diagram popup wiring, extracted from the working chat path
 * (ChatMessage.tsx: ToolPopupContent state + handleShowPopup/handlePopupChange + lazy
 * ToolOutputDialog). The 4 non-chat SimpleMarkdownRenderer surfaces (FilesView,
 * MobileFilesSurface, PlanView, SkillsPage) passed no `onShowPopup`, so the mermaid/plantuml
 * expand hooks hard-returned and fullscreen was a no-op there. This hook gives every surface
 * the same fullscreen pan/zoom dialog for BOTH diagram kinds.
 *
 * Chat keeps its own wiring — do NOT swap ChatMessage onto this hook.
 *
 * Parity requirements mirrored from chat:
 * - setImagePreviewOpen(open) on open/close: useKeyboardShortcuts folds isImagePreviewOpen into
 *   hasOverlay, so global shortcuts must be suppressed while a preview is open.
 * - unmount cleanup resets isImagePreviewOpen(false): the surfaces are route-level and unmount
 *   on navigation; a stranded `true` would permanently kill global shortcuts app-wide.
 * - isMobile sourced internally via useDeviceInfo() (ToolOutputDialogProps requires it).
 * - ToolOutputDialog stays behind lazyWithChunkRecovery + React.Suspense and is mounted ONLY
 *   when popup.open, so the @plantuml/core + dialog chunk stays lazy (epic AC4) — the chunk
 *   loads on first expand, not on surface mount.
 */

const CLOSED_POPUP: ToolPopupContent = { open: false, title: '', content: '' };

const LazyToolOutputDialog = lazyWithChunkRecovery(() => import('@/components/chat/message/ToolOutputDialog'));

export interface UseDiagramPopupResult {
    onShowPopup: (content: ToolPopupContent) => void;
    popupElement: React.ReactNode;
}

export function useDiagramPopup(): UseDiagramPopupResult {
    const { isMobile } = useDeviceInfo();
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const [popup, setPopup] = React.useState<ToolPopupContent>(CLOSED_POPUP);

    const onShowPopup = React.useCallback(
        (content: ToolPopupContent) => {
            // The 4 surfaces only ever emit diagram payloads (mermaid/plantuml expand), never
            // image previews. The interaction hooks already stamp `open: true` on the content.
            if (content.diagram) {
                setPopup(content);
                setImagePreviewOpen(true);
            }
        },
        [setImagePreviewOpen],
    );

    const handlePopupChange = React.useCallback(
        (open: boolean) => {
            setPopup((prev) => ({ ...prev, open }));
            setImagePreviewOpen(open);
        },
        [setImagePreviewOpen],
    );

    React.useEffect(() => {
        // Route surfaces unmount on navigation. If a preview was open, isImagePreviewOpen would
        // stay true and permanently suppress global keyboard shortcuts — reset it on unmount.
        return () => {
            setImagePreviewOpen(false);
        };
    }, [setImagePreviewOpen]);

    const popupElement = popup.open ? (
        <React.Suspense fallback={null}>
            <LazyToolOutputDialog popup={popup} onOpenChange={handlePopupChange} isMobile={isMobile} />
        </React.Suspense>
    ) : null;

    return { onShowPopup, popupElement };
}
