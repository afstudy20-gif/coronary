import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import * as cornerstone from '@cornerstonejs/core';
import { DicomDropzone } from './components/DicomDropzone';
import { SeriesPanel } from './components/SeriesPanel';
import { Toolbar } from './components/Toolbar';
import { AngioViewer } from './components/AngioViewer';
import { QCAWorkspace } from './components/QCAWorkspace';
import { loadDicomFiles, preloadImages, type DicomSeriesInfo } from './core/dicomLoader';
import { initCornerstone } from './core/initCornerstone';
import { destroyToolGroup, setupToolGroup } from './core/toolManager';
import { createInitialSession, qcaReducer, type QCASession, type QCAAction } from './qca/QCATypes';

const RENDERING_ENGINE_ID = 'angioRenderingEngine';
const VIEWPORT_ID = 'angio-main';

interface AngioAppProps {
  onBack?: () => void;
  initialFiles?: File[];
}

export default function AngioApp({ onBack, initialFiles }: AngioAppProps = {}) {
  const renderingEngineRef = useRef<cornerstone.RenderingEngine | null>(null);
  const initialFilesConsumedRef = useRef(false);

  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [seriesList, setSeriesList] = useState<DicomSeriesInfo[]>([]);
  const [activeSeries, setActiveSeries] = useState<DicomSeriesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState('');
  const [qcaActive, setQcaActive] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);

  const [qcaSession, qcaDispatchRaw] = useReducer(qcaReducer, undefined, createInitialSession);
  const undoStackRef = useRef<QCASession[]>([]);
  const MAX_UNDO = 50;

  const qcaDispatch = useCallback((action: QCAAction) => {
    // Don't push undo for trivial/frequent actions
    const skipUndo = action.type === 'SET_CHART_MODE' || action.type === 'SET_ANALYSIS_TAB' || action.type === 'SET_INTERACTION' || action.type === 'SET_FRAME';
    if (!skipUndo) {
      undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO - 1)), qcaSession];
    }
    qcaDispatchRaw(action);
  }, [qcaSession]);

  const qcaUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    undoStackRef.current = stack.slice(0, -1);
    qcaDispatchRaw({ type: 'RESTORE', state: prev });
  }, []);

  // Ctrl+Z undo handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        qcaUndo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [qcaUndo]);

  useEffect(() => {
    if (!isInitialized || initialFilesConsumedRef.current) return;
    if (initialFiles && initialFiles.length > 0) {
      initialFilesConsumedRef.current = true;
      void handleFilesLoaded(initialFiles);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized]);

  useEffect(() => {
    let mounted = true;

    initCornerstone()
      .then(() => {
        if (!mounted) return;
        renderingEngineRef.current = new cornerstone.RenderingEngine(RENDERING_ENGINE_ID);
        setIsInitialized(true);
      })
      .catch((initError: Error) => {
        if (!mounted) return;
        setError(`Failed to initialize Cornerstone: ${initError.message}`);
      });

    return () => {
      mounted = false;
      destroyToolGroup();
      renderingEngineRef.current?.destroy();
    };
  }, []);

  // Sync current frame from viewport
  useEffect(() => {
    const engine = renderingEngineRef.current;
    if (!engine || !activeSeries) return;

    const vp = engine.getViewport(VIEWPORT_ID);
    if (!vp?.element) return;

    const handleRendered = () => {
      const svp = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
      if (svp && 'getCurrentImageIdIndex' in svp) {
        setCurrentFrame(svp.getCurrentImageIdIndex());
      }
    };

    vp.element.addEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, handleRendered);
    return () => vp.element.removeEventListener(cornerstone.Enums.Events.IMAGE_RENDERED, handleRendered);
  }, [activeSeries]);

  async function handleFilesLoaded(files: File[]) {
    if (!isInitialized) return;

    setIsLoading(true);
    setError(null);
    setLoadingProgress('Parsing DICOM files...');

    try {
      const series = await loadDicomFiles(files);
      setSeriesList(series);

      if (series.length === 0) {
        setError('No DICOM series found in the selected files.');
        return;
      }

      await loadSeries(series[0]);
    } catch (loadError: any) {
      setError(`Failed to load DICOM files: ${loadError.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadSeries(series: DicomSeriesInfo) {
    const engine = renderingEngineRef.current;
    if (!engine) return;

    setActiveSeries(series);
    setIsLoading(true);
    setLoadingProgress(`Loading images: 0/${series.imageIds.length}`);
    setQcaActive(false);
    qcaDispatch({ type: 'RESET' });

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    let stage = 'initialization';
    try {
      stage = 'destroyToolGroup';
      destroyToolGroup();
      // Skip cornerstone.cache.purgeCache() on a series switch: the
      // dicom-image-loader fileManager registers blob URLs up front; a
      // blanket purge revokes those blobs and the in-flight setStack()
      // loads immediately error out with "The image was purged from the
      // cache before it completed loading", leaving the viewport black.
      // Cache pressure is already bounded by the loader's own LRU policy.

      stage = 'resolveViewportElement';
      const viewportElement = document.getElementById('viewport-angio') as HTMLDivElement | null;
      if (!viewportElement) throw new Error('Viewport element not found in DOM');

      stage = 'setViewports';
      engine.setViewports([
        {
          viewportId: VIEWPORT_ID,
          type: cornerstone.Enums.ViewportType.STACK,
          element: viewportElement,
          defaultOptions: { background: [0, 0, 0] as cornerstone.Types.RGB },
        },
      ]);

      stage = 'setupToolGroup';
      setupToolGroup(RENDERING_ENGINE_ID, VIEWPORT_ID);

      stage = 'setStack';
      setLoadingProgress(`Setting up ${series.imageIds.length} frames...`);
      const viewport = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport;
      await viewport.setStack(series.imageIds);

      // Let Cornerstone use DICOM-embedded W/L or auto-compute from pixel data.
      // Only apply a fallback VOI if the image appears too dark after initial render.
      viewport.render();

      // After first render, check if VOI was set from DICOM metadata.
      // If not, compute a sensible default from the actual pixel range.
      try {
        const image = viewport.getImageData();
        if (image) {
          const props = viewport.getProperties();
          const voiRange = props.voiRange;
          // If no VOI was set or range is degenerate, auto-compute
          if (!voiRange || voiRange.lower === voiRange.upper) {
            viewport.resetProperties();
            viewport.render();
          }
        }
      } catch {
        // Non-fatal - default VOI is acceptable
      }
    } catch (seriesError: any) {
      console.error(`[loadSeries:${stage}]`, seriesError);
      setError(`Failed to load series at ${stage}: ${seriesError.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function handleReset() {
    setError(null);
    const engine = renderingEngineRef.current;
    if (!engine) return;

    const viewport = engine.getViewport(VIEWPORT_ID) as cornerstone.Types.IStackViewport | undefined;
    if (viewport) {
      viewport.resetCamera();
      viewport.resetProperties();
      viewport.setProperties({ invert: false });
      viewport.render();
    }
  }

  function toggleQCA() {
    if (qcaActive) {
      setQcaActive(false);
      qcaDispatch({ type: 'RESET' });
    } else {
      setQcaActive(true);
      qcaDispatch({ type: 'RESET' });
    }
  }

  function openFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.length) handleFilesLoaded(Array.from(target.files));
    };
    input.click();
  }

  function openFolderPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    input.onchange = (event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.length) handleFilesLoaded(Array.from(target.files));
    };
    input.click();
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="header-kicker">Angiography Suite</p>
          <h1>QCA + vFFR Workbench</h1>
        </div>
        <div className="header-meta">
          {activeSeries ? (
            <>
              <span>{activeSeries.patientName}</span>
              <span className="dot">&bull;</span>
              <span>{activeSeries.studyDescription}</span>
              <span className="dot">&bull;</span>
              <span>{activeSeries.modality} / {activeSeries.numImages} frames</span>
            </>
          ) : (
            <span>No active study</span>
          )}
        </div>
        <div className="header-actions">
          {onBack && (
            <button className="secondary-btn" onClick={onBack}>{'<- Modality'}</button>
          )}
          <button className="secondary-btn" onClick={openFilePicker} disabled={isLoading}>Open Files</button>
          <button className="secondary-btn" onClick={openFolderPicker} disabled={isLoading}>Open Folder</button>
        </div>
      </header>

      {activeSeries && (
        <Toolbar
          renderingEngineId={RENDERING_ENGINE_ID}
          viewportId={VIEWPORT_ID}
          onReset={handleReset}
          qcaActive={qcaActive}
          onToggleQCA={toggleQCA}
        />
      )}

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {!activeSeries ? (
        <DicomDropzone onFilesLoaded={handleFilesLoaded} isLoading={isLoading} />
      ) : (
        <main className={`workspace-layout ${qcaActive ? 'with-qca' : ''}`}>
          <SeriesPanel
            seriesList={seriesList}
            activeSeriesUID={activeSeries.seriesInstanceUID}
            onSelectSeries={loadSeries}
            isLoading={isLoading}
          />
          <div className="viewer-column">
            <AngioViewer
              renderingEngineId={RENDERING_ENGINE_ID}
              viewportId={VIEWPORT_ID}
              imageCount={activeSeries.numImages}
              qcaSession={qcaActive ? qcaSession : null}
              qcaDispatch={qcaActive ? qcaDispatch : null}
              seriesIndex={seriesList.indexOf(activeSeries)}
              seriesCount={seriesList.length}
              onPrevSeries={() => {
                const idx = seriesList.indexOf(activeSeries);
                if (idx > 0) loadSeries(seriesList[idx - 1]);
              }}
              onNextSeries={() => {
                const idx = seriesList.indexOf(activeSeries);
                if (idx < seriesList.length - 1) loadSeries(seriesList[idx + 1]);
              }}
            />
          </div>
          {qcaActive && (
            <QCAWorkspace
              session={qcaSession}
              dispatch={qcaDispatch}
              currentFrame={currentFrame}
              imageCount={activeSeries.numImages}
            />
          )}
        </main>
      )}

      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-card">
            <div className="spinner" />
            <p>{loadingProgress || 'Loading angiography...'}</p>
          </div>
        </div>
      )}
    </div>
  );
}
