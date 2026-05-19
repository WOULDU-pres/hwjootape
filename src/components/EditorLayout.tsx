"use client";

import { useEffect, useMemo, useState } from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useToast } from '@/hooks/useToast';
import { useEditorStore } from '@/stores/useEditorStore';
import { useCanvasStore } from '@/stores/useCanvasStore';
import { useHistoryStore } from '@/stores/useHistoryStore';
import type { CanvasImage } from '@/types/canvas';
import { CanvasContainer } from './Canvas/CanvasContainer';
import { PromptComposerProvider, usePromptComposer } from './Composer/PromptComposerProvider';
import { BottomComposer } from './Composer/BottomComposer';
import { ExportModal } from './Export/ExportModal';
import { HistorySidebar } from './Sidebar/HistorySidebar';
import { LeftPanel } from './Sidebar/LeftPanel';
import { TopBar } from './Shell/TopBar';
import { ToastContainer } from './ToastContainer';

export function EditorLayout() {
  return (
    <PromptComposerProvider>
      <StandaloneEditorShell />
    </PromptComposerProvider>
  );
}

function StandaloneEditorShell() {
  useKeyboardShortcuts();

  const { toasts, removeToast } = useToast();
  const baseImage = useEditorStore((s) => s.baseImage);
  const setBaseImage = useEditorStore((s) => s.setBaseImage);
  const canvasImageCount = useCanvasStore((s) => s.imageOrder.length);
  const focusedImageIds = useCanvasStore((s) => s.focusedImageIds);
  const hydrateCanvas = useCanvasStore((s) => s.hydrate);
  const hydrateEntries = useHistoryStore((s) => s.hydrateEntries);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [projectName, setProjectName] = useState('Untitled design');

  useEffect(() => {
    let cancelled = false;
    async function hydrateProjectHistory() {
      try {
        const sessionRes = await fetch('/api/projects/current', { cache: 'no-store' });
        if (!sessionRes.ok) return;
        const session = await sessionRes.json();
        if (session.persistence !== 'project') return;
        if (typeof session.projectName === 'string' && session.projectName.trim()) {
          setProjectName(session.projectName);
        }
        const historyRes = await fetch('/api/projects/history', { cache: 'no-store' });
        if (!historyRes.ok) return;
        const history = await historyRes.json();
        if (cancelled || !Array.isArray(history.entries)) return;
        const first = history.entries[0];
        const rootImageId = typeof first?.imageId === 'string' ? first.imageId : (typeof first?.id === 'string' ? first.id : null);
        const entries = history.entries.map((entry: { id?: string; imageId?: string; assetUrl?: string; imageDataUrl?: string }) => ({
          ...entry,
          imageId: entry.imageId ?? rootImageId ?? undefined,
          imageDataUrl: entry.imageDataUrl ?? entry.assetUrl,
        }));
        hydrateEntries(entries);
        if (first?.assetUrl) {
          setBaseImage(first.assetUrl, { width: 0, height: 0 });
          if (rootImageId && canvasImageCount === 0) {
            const rootImage: CanvasImage = {
              id: rootImageId,
              url: first.assetUrl,
              assetId: typeof first.assetId === 'string' ? first.assetId : undefined,
              size: { width: 1024, height: 1024 },
              position: { x: 0, y: 0 },
              parentId: null,
              generationIndex: 0,
              prompt: typeof first.prompt === 'string' ? first.prompt : '',
              provider: first.provider === 'god-tibo' ? 'god-tibo' : 'openai',
              type: first.type === 'edit' ? 'edit' : 'generate',
              createdAt: typeof first.timestamp === 'number' ? first.timestamp : Date.now(),
              paths: [],
              boxes: [],
              memos: [],
              status: 'ready',
            };
            hydrateCanvas({ [rootImageId]: rootImage }, [rootImageId], [rootImageId]);
          }
        }
      } catch {
        // No active local project; keep no-project fallback behavior.
      }
    }
    void hydrateProjectHistory();
    return () => { cancelled = true; };
  }, [canvasImageCount, hydrateCanvas, hydrateEntries, setBaseImage]);

  useEffect(() => {
    if (!baseImage || canvasImageCount > 0) return;
    const editor = useEditorStore.getState();
    const id = crypto.randomUUID();
    const rootImage: CanvasImage = {
      id,
      url: baseImage,
      size: editor.imageSize.width > 0 && editor.imageSize.height > 0
        ? editor.imageSize
        : { width: 1024, height: 1024 },
      position: { x: 0, y: 0 },
      parentId: null,
      generationIndex: 0,
      prompt: '',
      provider: 'openai',
      type: 'generate',
      createdAt: Date.now(),
      paths: editor.paths,
      boxes: editor.boxes,
      memos: editor.memos,
      status: 'ready',
    };
    hydrateCanvas({ [id]: rootImage }, [id], [id]);
  }, [baseImage, canvasImageCount, hydrateCanvas]);

  const {
    prompt,
    setPrompt,
    referenceImages,
    systemPrompt,
    setSystemPrompt,
    designContext,
    designContextFileName,
    replaceDesignContext,
    clearDesignContext,
    addReferenceFiles,
    removeReferenceImage,
    clearReferenceImages,
    handleGenerate,
    handleEdit,
  } = usePromptComposer();

  const referencePreviews = useMemo(() => (
    referenceImages.map((reference) => ({
      id: reference.id,
      previewUrl: reference.previewUrl,
      file: reference.file,
      name: reference.file.name,
    }))
  ), [referenceImages]);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[#1e1e1e] text-[#e6e6e6]">
      <TopBar canExport={focusedImageIds.length > 0} onExportClick={() => setIsExportOpen(true)} projectName={projectName} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <LeftPanel
          references={referencePreviews}
          onAddReferenceFiles={addReferenceFiles}
          onRemoveReference={removeReferenceImage}
          onClearReferences={clearReferenceImages}
          systemPrompt={systemPrompt}
          onSystemPromptChange={setSystemPrompt}
          designContext={designContext}
          designContextFileName={designContextFileName}
          onReplaceDesignContext={replaceDesignContext}
          onClearDesignContext={clearDesignContext}
        />
        <main className="relative min-w-0 flex-1 overflow-hidden">
          <CanvasContainer className="h-full w-full" />
        </main>
        <HistorySidebar />
      </div>
      <BottomComposer
        prompt={prompt}
        onPromptChange={setPrompt}
        references={referencePreviews}
        onAddReferenceFiles={addReferenceFiles}
        onRemoveReference={removeReferenceImage}
        onGenerate={handleGenerate}
        onEdit={handleEdit}
      />
      <ExportModal open={isExportOpen} onOpenChange={setIsExportOpen} canExport={focusedImageIds.length > 0} />
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </div>
  );
}
