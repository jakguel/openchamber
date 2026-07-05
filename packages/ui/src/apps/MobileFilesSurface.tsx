import React from 'react';
import { File as PierreFile } from '@pierre/diffs/react';
import {
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiFolder3Fill,
  RiFolderOpenFill,
  RiLoader4Line,
  RiRefreshLine,
  RiSearchLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useDiagramPopup } from '@/components/chat/markdown/useDiagramPopup';
import { extractToc } from '@/components/chat/markdown/toc';
import { TocTree } from '@/components/chat/markdown/toc/TocTree';
import { createCommitSignal, scrollToHeading } from '@/components/chat/markdown/toc/scrollToHeading';
import { PIERRE_RUNTIME_BASE_CSS } from '@/components/views/PierreDiffViewer';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import { getImageMimeType, getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import type { FileListEntry, FileSearchResult } from '@/lib/api/types';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';

import { MobileSurfaceShell } from './MobileSurfaceShell';

type MobileFilesRoute =
  | { type: 'browser'; directory: string }
  | { type: 'file'; path: string; returnDirectory: string };

const MAX_MOBILE_FILE_CHARS = 250_000;

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getNameFromPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return normalized || '/';
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
};

const getParentDirectory = (path: string): string | null => {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return null;
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return normalized.startsWith('/') ? '/' : null;
  return normalized.slice(0, index);
};

const getRelativePath = (path: string, root: string): string => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot || normalizedPath === normalizedRoot) return getNameFromPath(normalizedPath);
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1);
  return normalizedPath;
};

const formatFileSize = (size?: number): string => {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return '';
};

const getImageSrc = (path: string): string => {
  if (path.toLowerCase().endsWith('.svg')) {
    return '';
  }
  return getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', { path });
};

const isMarkdownFile = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path);
const isJsonFile = (path: string): boolean => /\.(json|jsonc)$/i.test(path);

type MobileFilesSurfaceProps = {
  /** When provided, header gets a close X that calls this; used when the surface is hosted in MobileSurfaceShell. */
  onClose?: () => void;
};

export const MobileFilesSurface: React.FC<MobileFilesSurfaceProps> = ({ onClose }) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const root = normalizePath(useEffectiveDirectory() ?? null);
  const [route, setRoute] = React.useState<MobileFilesRoute>(() => ({ type: 'browser', directory: root }));
  const [entries, setEntries] = React.useState<FileListEntry[]>([]);
  const [isLoadingDirectory, setIsLoadingDirectory] = React.useState(false);
  const [directoryError, setDirectoryError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<FileSearchResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const [fileContent, setFileContent] = React.useState('');
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = React.useState(false);
  const directoryLoadRequestIdRef = React.useRef(0);

  React.useEffect(() => {
    if (!root) return;
    setRoute((current) => {
      if (current.type === 'browser' && current.directory) return current;
      return { type: 'browser', directory: root };
    });
  }, [root]);

  const currentDirectory = route.type === 'browser' ? route.directory : route.returnDirectory;

  const loadDirectory = React.useCallback(async (directory: string) => {
    if (!directory) return;
    const requestId = directoryLoadRequestIdRef.current + 1;
    directoryLoadRequestIdRef.current = requestId;
    setIsLoadingDirectory(true);
    setDirectoryError(null);
    try {
      const result = await files.listDirectory(directory);
      if (directoryLoadRequestIdRef.current !== requestId) return;
      setEntries(result.entries.slice().sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    } catch (error) {
      if (directoryLoadRequestIdRef.current !== requestId) return;
      setEntries([]);
      setDirectoryError(error instanceof Error ? error.message : t('mobile.files.error.listFailed'));
    } finally {
      if (directoryLoadRequestIdRef.current === requestId) {
        setIsLoadingDirectory(false);
      }
    }
  }, [files, t]);

  React.useEffect(() => {
    if (route.type !== 'browser') return;
    void loadDirectory(route.directory);
  }, [loadDirectory, route]);

  React.useEffect(() => {
    if (route.type !== 'browser') return;
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setIsSearching(true);
      void files.search({ directory: route.directory, query: normalizedQuery, maxResults: 40 })
        .then((results) => {
          if (!cancelled) setSearchResults(results);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [files, query, route]);

  React.useEffect(() => {
    if (route.type !== 'file') return;
    setFileContent('');
    setFileError(null);

    if (isImageFile(route.path) && !route.path.toLowerCase().endsWith('.svg')) {
      setIsLoadingFile(false);
      return;
    }

    if (!files.readFile) {
      setFileError(t('mobile.files.error.readUnavailable'));
      setIsLoadingFile(false);
      return;
    }

    let cancelled = false;
    setIsLoadingFile(true);
    void files.readFile(route.path)
      .then((result) => {
        if (cancelled) return;
        setFileContent(result.content.length > MAX_MOBILE_FILE_CHARS
          ? `${result.content.slice(0, MAX_MOBILE_FILE_CHARS)}\n\n${t('mobile.files.file.truncated')}`
          : result.content);
      })
      .catch((error) => {
        if (!cancelled) setFileError(error instanceof Error ? error.message : t('filesView.error.readFileFailed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoadingFile(false);
      });

    return () => {
      cancelled = true;
    };
  }, [files, route, t]);

  const openDirectory = (directory: string) => {
    setQuery('');
    setRoute({ type: 'browser', directory });
  };

  const openFile = (path: string) => {
    setRoute({ type: 'file', path, returnDirectory: currentDirectory || root });
  };

  if (!root) {
    return <MobileFilesState message={t('mobile.files.empty.noDirectory')} />;
  }

  if (route.type === 'file') {
    return (
      <MobileFileDetail
        path={route.path}
        content={fileContent}
        error={fileError}
        isLoading={isLoadingFile}
        onBack={() => setRoute({ type: 'browser', directory: route.returnDirectory })}
      />
    );
  }

  const directoryLabel = route.directory === root ? t('mobile.files.rootDirectory') : getNameFromPath(route.directory);
  const visibleSearchResults = query.trim() ? searchResults : [];

  // Cap parent navigation at the project root: only allow stepping up while
  // the parent stays inside (or equal to) the root.
  const rawParent = getParentDirectory(route.directory);
  const parentWithinRoot =
    route.directory !== root && rawParent !== null && (rawParent === root || rawParent.startsWith(`${root}/`));
  const canGoBack = parentWithinRoot && !query.trim();
  const parentDirectory = parentWithinRoot ? rawParent : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <RiCloseLine className="size-5" />
          </button>
        ) : null}
        {canGoBack && parentDirectory ? (
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.files.backToParentAria', { name: getNameFromPath(parentDirectory) })}
            onClick={() => openDirectory(parentDirectory)}
            style={{ touchAction: 'manipulation' }}
          >
            <RiArrowLeftLine className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate typography-ui-label text-foreground">{directoryLabel}</h2>
        </div>
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('mobile.files.refreshAria')}
          onClick={() => void loadDirectory(route.directory)}
          style={{ touchAction: 'manipulation' }}
        >
          <RiRefreshLine className={cn('size-5', isLoadingDirectory && 'animate-spin')} />
        </button>
      </header>
      <div className="shrink-0 px-4 pb-2 pt-1">
        <div className="relative">
          <RiSearchLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('mobile.files.search.placeholder')}
            className="h-11 pl-9"
          />
        </div>
      </div>

      <ScrollShadow className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {directoryError ? (
          <MobileFilesState message={directoryError} />
        ) : query.trim() ? (
          <MobileSearchResults results={visibleSearchResults} isSearching={isSearching} onOpenFile={openFile} />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
            {entries.length === 0 && !isLoadingDirectory ? (
              <div className="px-4 py-8 text-center typography-body text-muted-foreground">{t('mobile.files.empty.directory')}</div>
            ) : null}
            {entries.map((entry) => (
              <MobileFileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                directory={entry.isDirectory}
                meta={entry.isDirectory ? undefined : formatFileSize(entry.size)}
                onClick={() => entry.isDirectory ? openDirectory(entry.path) : openFile(entry.path)}
              />
            ))}
          </div>
        )}
      </ScrollShadow>
    </div>
  );
};

const MobileFileRow: React.FC<{
  name: string;
  path: string;
  directory: boolean;
  meta?: string;
  onClick: () => void;
}> = ({ name, path, directory, meta, onClick }) => (
  <button
    type="button"
    className="flex min-h-14 w-full items-center gap-3 border-b border-border/30 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
    onClick={onClick}
    style={{ touchAction: 'manipulation' }}
  >
    {directory ? (
      <RiFolder3Fill className="size-5 shrink-0 text-primary/80" />
    ) : (
      <FileTypeIcon filePath={path} className="size-5 shrink-0" />
    )}
    <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{name}</span>
    {meta ? <span className="shrink-0 typography-micro text-muted-foreground">{meta}</span> : null}
    {directory ? <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground/60" /> : null}
  </button>
);

const MobileSearchResults: React.FC<{
  results: FileSearchResult[];
  isSearching: boolean;
  onOpenFile: (path: string) => void;
}> = ({ results, isSearching, onOpenFile }) => {
  const { t } = useI18n();
  const root = normalizePath(useEffectiveDirectory() ?? null);
  if (isSearching) return <MobileFilesState loading message={t('common.loading')} />;
  if (results.length === 0) return <MobileFilesState message={t('mobile.files.search.empty')} />;
  return (
    <div className="overflow-hidden rounded-2xl border border-border/40 bg-[var(--surface-elevated)]">
      {results.map((result) => (
        <MobileFileRow
          key={result.path}
          name={getNameFromPath(result.path)}
          path={result.path}
          directory={false}
          meta={getRelativePath(result.path, root)}
          onClick={() => onOpenFile(result.path)}
        />
      ))}
    </div>
  );
};

const MobileFileDetail: React.FC<{
  path: string;
  content: string;
  error: string | null;
  isLoading: boolean;
  onBack: () => void;
}> = ({ path, content, error, isLoading, onBack }) => {
  const { t } = useI18n();

  // Ordered H1–H3 ToC model for the markdown preview. Empty for non-markdown or
  // zero-heading files → the bookmarks button AND the sheet are hidden. Strip
  // frontmatter so the extracted order matches the rendered <h1-3> tags 1:1.
  const isMarkdown = isMarkdownFile(path);
  const tocEntries = React.useMemo(
    () => (isMarkdown ? extractToc(content, { stripFrontmatter: true }) : []),
    [isMarkdown, content],
  );
  const hasToc = tocEntries.length > 0;
  const [tocOpen, setTocOpen] = React.useState(false);
  // The markdown ScrollShadow scroll element — both the scroller AND the content
  // root that holds the decorated heading ids (they live inside it).
  const scrollerRef = React.useRef<HTMLElement | null>(null);
  // Fires once the markdown render commit lands (heading ids in the live DOM);
  // a ToC tap awaits it only when the target id is not yet present.
  const commitSignal = React.useMemo(() => createCommitSignal(), []);

  // Close the sheet whenever the viewed file changes.
  React.useEffect(() => {
    setTocOpen(false);
  }, [path]);

  const handleTocSelect = React.useCallback(
    async (id: string) => {
      const scroller = scrollerRef.current;
      if (!scroller) {
        setTocOpen(false);
        return;
      }
      if (!scroller.querySelector(`#${CSS.escape(id)}`)) {
        await commitSignal.waitForCommit();
      }
      scrollToHeading(scroller, scroller, id, { smooth: true });
      setTocOpen(false);
    },
    [commitSignal],
  );

  const imageAuthKey = isImageFile(path) && !path.toLowerCase().endsWith('.svg') ? path : '';
  const [imageAuthReadyKey, setImageAuthReadyKey] = React.useState('');

  React.useEffect(() => {
    if (!imageAuthKey) {
      setImageAuthReadyKey('');
      return;
    }

    let cancelled = false;
    setImageAuthReadyKey('');
    void refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())
      .then((token) => {
        if (!cancelled && token) setImageAuthReadyKey(imageAuthKey);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [imageAuthKey]);

  const imageAuthLoading = Boolean(imageAuthKey && imageAuthReadyKey !== imageAuthKey);
  const imageSrc = imageAuthLoading ? '' : getImageSrc(path);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-3 border-b border-border/50 px-3 text-foreground">
        <button
          type="button"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('header.actions.backAria')}
          onClick={onBack}
        >
          <RiArrowLeftLine className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate typography-ui-header text-foreground">{getNameFromPath(path)}</h2>
        </div>
        {hasToc ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setTocOpen(true)}
            aria-label={t('markdown.toc.openAria')}
          >
            <Icon name="list-unordered" className="size-4" />
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading || imageAuthLoading ? (
          <MobileFilesState loading message={t('filesView.state.loading')} />
        ) : error ? (
          <MobileFilesState message={error} />
        ) : isImageFile(path) && imageSrc ? (
          <ScrollShadow className="h-full overflow-auto p-4">
            <img src={imageSrc} alt={getNameFromPath(path)} className="mx-auto max-h-full max-w-full rounded-lg object-contain" />
          </ScrollShadow>
        ) : isImageFile(path) ? (
          <ScrollShadow className="h-full overflow-auto p-4">
            <img src={`data:${getImageMimeType(path)};utf8,${encodeURIComponent(content)}`} alt={getNameFromPath(path)} className="mx-auto max-h-full max-w-full rounded-lg object-contain" />
          </ScrollShadow>
        ) : (
          <MobileTextFile
            path={path}
            content={content}
            scrollerRef={scrollerRef}
            injectHeadingIds={hasToc}
            onCommit={commitSignal.notify}
          />
        )}
      </div>
      {hasToc ? (
        <MobileSurfaceShell
          open={tocOpen}
          onClose={() => setTocOpen(false)}
          ariaLabel={t('markdown.toc.navAria')}
          title={t('markdown.toc.navAria')}
        >
          <ScrollShadow className="h-full overflow-y-auto px-2 py-2">
            <TocTree entries={tocEntries} onScrollToHeading={handleTocSelect} />
          </ScrollShadow>
        </MobileSurfaceShell>
      ) : null}
    </div>
  );
};

const MobileTextFile: React.FC<{
  path: string;
  content: string;
  /** Bound to the markdown ScrollShadow scroll element so the ToC sheet can scroll it. */
  scrollerRef?: React.Ref<HTMLElement>;
  /** Inject stable heading ids into the rendered markdown so the ToC can anchor-scroll. */
  injectHeadingIds?: boolean;
  /** Fires after each markdown render commit, once heading ids exist in the live DOM. */
  onCommit?: () => void;
}> = ({ path, content, scrollerRef, injectHeadingIds = false, onCommit }) => {
  const { currentTheme, availableThemes, lightThemeId, darkThemeId } = useThemeSystem();
  const lightTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? getDefaultTheme(false),
    [availableThemes, lightThemeId],
  );
  const darkTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? getDefaultTheme(true),
    [availableThemes, darkThemeId],
  );

  React.useEffect(() => {
    ensurePierreThemeRegistered(lightTheme);
    ensurePierreThemeRegistered(darkTheme);
  }, [darkTheme, lightTheme]);

  const pierreTheme = React.useMemo(
    () => ({ light: lightTheme.metadata.id, dark: darkTheme.metadata.id }),
    [darkTheme.metadata.id, lightTheme.metadata.id],
  );

  const { onShowPopup: onShowDiagramPopup, popupElement: diagramPopupElement } = useDiagramPopup();

  if (isMarkdownFile(path)) {
    return (
      <>
        <ScrollShadow ref={scrollerRef} className="h-full overflow-y-auto px-4 py-4">
          <SimpleMarkdownRenderer
            content={content}
            enableFileReferences={false}
            onShowPopup={onShowDiagramPopup}
            injectHeadingIds={injectHeadingIds}
            onCommit={onCommit}
          />
        </ScrollShadow>
        {diagramPopupElement}
      </>
    );
  }
  if (isJsonFile(path)) {
    return <JsonTreeView jsonString={content} className="h-full overflow-auto" />;
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ScrollShadow className="min-h-0 flex-1 overflow-auto bg-[var(--syntax-base-background)]">
        <PierreFile
          file={{
            name: getNameFromPath(path),
            contents: content,
            lang: getLanguageFromExtension(path) || undefined,
          }}
          options={{
            disableFileHeader: true,
            overflow: 'wrap',
            theme: pierreTheme,
            themeType: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light',
            unsafeCSS: PIERRE_RUNTIME_BASE_CSS,
          }}
          className="block min-h-full w-full"
          style={{ minHeight: '100%' }}
        />
      </ScrollShadow>
    </div>
  );
};

const MobileFilesState: React.FC<{ message: string; loading?: boolean }> = ({ message, loading = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <RiLoader4Line className="size-5 animate-spin text-muted-foreground" /> : <RiFolderOpenFill className="size-6 text-muted-foreground" />}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
    </div>
  </div>
);
