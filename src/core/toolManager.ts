import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { getToolNames } from './initCornerstone';

const MPR_TOOL_GROUP_ID = 'coronaryMprToolGroup';
const MPR_VIEWPORT_IDS = ['axial', 'sagittal', 'coronal'];

export type ToolName = 'Crosshairs' | 'WindowLevel' | 'Pan' | 'Zoom' | 'Length' | 'Probe';

let mprToolGroup: cornerstoneTools.Types.IToolGroup | undefined;
let voiSync: cornerstoneTools.Synchronizer | undefined;
let zoomPanSync: cornerstoneTools.Synchronizer | undefined;

export function setupToolGroups(renderingEngineId: string): void {
  if (mprToolGroup) {
    return;
  }

  const names = getToolNames();
  let step = 'createToolGroup';

  try {
    let group = cornerstoneTools.ToolGroupManager.createToolGroup(MPR_TOOL_GROUP_ID);
    if (!group) {
      step = 'destroyStaleToolGroup';
      cornerstoneTools.ToolGroupManager.destroyToolGroup(MPR_TOOL_GROUP_ID);
      step = 'recreateToolGroup';
      group = cornerstoneTools.ToolGroupManager.createToolGroup(MPR_TOOL_GROUP_ID);
    }
    if (!group) {
      throw new Error('Failed to create coronary MPR tool group');
    }

    step = 'addTool:WindowLevel';
    group.addTool(names.WindowLevel);
    step = 'addTool:Pan';
    group.addTool(names.Pan);
    step = 'addTool:Zoom';
    group.addTool(names.Zoom);
    step = 'addTool:StackScroll';
    group.addTool(names.StackScroll);
    step = 'addTool:Length';
    group.addTool(names.Length);
    step = 'addTool:Probe';
    group.addTool(names.Probe);
    step = 'addTool:Crosshairs';
    group.addTool(names.Crosshairs, {
      getReferenceLineColor: (viewportId: string) => {
        const colors: Record<string, string> = {
          axial: 'rgb(255, 135, 91)',
          sagittal: 'rgb(97, 219, 251)',
          coronal: 'rgb(255, 209, 102)',
        };
        return colors[viewportId] || 'rgb(200, 200, 200)';
      },
      getReferenceLineControllable: () => true,
      getReferenceLineDraggableRotatable: () => true,
      getReferenceLineSlabThicknessControlsOn: () => false,
    });

    for (const viewportId of MPR_VIEWPORT_IDS) {
      step = `addViewport:${viewportId}`;
      group.addViewport(viewportId, renderingEngineId);
    }

    step = 'setToolActive:WindowLevel';
    group.setToolActive(names.WindowLevel, {
      bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
    });
    
    step = 'setToolActive:Pan';
    group.setToolActive(names.Pan, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary }, // Right-Click to Pan
      ],
    });
    
    step = 'setToolActive:Zoom';
    group.setToolActive(names.Zoom, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary }, // Middle-Click to Zoom
      ],
    });
    
    step = 'setToolActive:StackScroll';
    group.setToolActive(names.StackScroll, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel },
        // 'Razor Blade' Slicing: Right + Middle + Scroll
        { 
          mouseButton: (cornerstoneTools.Enums.MouseBindings.Secondary as any) | (cornerstoneTools.Enums.MouseBindings.Auxiliary as any) 
        }
      ],
    });

    step = 'createZoomPanSynchronizer';
    zoomPanSync = cornerstoneTools.synchronizers.createZoomPanSynchronizer('coronaryZoomPanSync');
    step = 'createVoiSynchronizer';
    voiSync = cornerstoneTools.synchronizers.createVOISynchronizer('coronaryVoiSync', {
      syncInvertState: false,
      syncColormap: false,
    });

    for (const viewportId of MPR_VIEWPORT_IDS) {
      step = `zoomPanSync:add:${viewportId}`;
      zoomPanSync.add({ renderingEngineId, viewportId });
      step = `zoomPanSync:setOptions:${viewportId}`;
      zoomPanSync.setOptions(viewportId, { syncPan: false });
      step = `voiSync:add:${viewportId}`;
      voiSync.add({ renderingEngineId, viewportId });
    }

    mprToolGroup = group;
  } catch (error: any) {
    throw new Error(`setupToolGroups:${step}: ${error?.message || String(error)}`);
  }
}

export function setActiveTool(name: ToolName): void {
  if (!mprToolGroup) {
    return;
  }

  const names = getToolNames();
  const selectedTool = names[name];
  const primaryTools = [
    names.Crosshairs,
    names.WindowLevel,
    names.Length,
    names.Probe,
    names.Pan,
    names.Zoom,
  ];

  for (const toolName of primaryTools) {
    if (toolName === names.Crosshairs && name === 'Probe') {
      mprToolGroup.setToolDisabled(toolName);
    } else {
      mprToolGroup.setToolPassive(toolName);
    }
  }

  mprToolGroup.setToolActive(selectedTool, {
    bindings: [{ mouseButton: cornerstoneTools.Enums.MouseBindings.Primary }],
  });

  if (name !== 'Pan') {
    mprToolGroup.setToolActive(names.Pan, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Secondary },
      ],
    });
  }

  if (name !== 'Zoom') {
    mprToolGroup.setToolActive(names.Zoom, {
      bindings: [
        { mouseButton: cornerstoneTools.Enums.MouseBindings.Auxiliary },
      ],
    });
  }

  mprToolGroup.setToolActive(names.StackScroll, {
    bindings: [
      { mouseButton: cornerstoneTools.Enums.MouseBindings.Wheel },
      { 
        mouseButton: (cornerstoneTools.Enums.MouseBindings.Secondary as any) | (cornerstoneTools.Enums.MouseBindings.Auxiliary as any) 
      }
    ],
  });
}

export function centerViewportsOnCrosshairs(renderingEngineId: string): void {
  if (!mprToolGroup) {
    return;
  }

  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) {
    return;
  }

  const names = getToolNames();
  const tool = mprToolGroup.getToolInstance(names.Crosshairs) as any;
  let center = tool?.toolCenter as cornerstone.Types.Point3 | undefined;

  if (!center) {
    for (const viewportId of MPR_VIEWPORT_IDS) {
      const viewport = engine.getViewport(viewportId);
      if (!viewport?.element) {
        continue;
      }
      const annotations = cornerstoneTools.annotation.state.getAnnotations(names.Crosshairs, viewport.element);
      const annotationCenter = annotations?.[0]?.data?.handles?.toolCenter;
      if (annotationCenter) {
        center = annotationCenter as cornerstone.Types.Point3;
        break;
      }
    }
  }

  if (!center) {
    return;
  }

  for (const viewportId of MPR_VIEWPORT_IDS) {
    const viewport = engine.getViewport(viewportId);
    if (!viewport) {
      continue;
    }

    const camera = viewport.getCamera();
    const normal = camera.viewPlaneNormal || [0, 0, 1];
    const distance =
      camera.position && camera.focalPoint
        ? Math.hypot(
            camera.position[0] - camera.focalPoint[0],
            camera.position[1] - camera.focalPoint[1],
            camera.position[2] - camera.focalPoint[2]
          )
        : 1000;

    viewport.setCamera({
      focalPoint: center,
      position: [
        center[0] + normal[0] * distance,
        center[1] + normal[1] * distance,
        center[2] + normal[2] * distance,
      ] as cornerstone.Types.Point3,
    });
    viewport.render();
  }
}

export function resetCrosshairsToCenter(renderingEngineId: string, volumeId: string): void {
  if (!mprToolGroup) {
    return;
  }

  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) {
    return;
  }

  const names = getToolNames();
  const crosshairsTool = mprToolGroup.getToolInstance(names.Crosshairs) as any;
  if (!crosshairsTool) {
    return;
  }

  let volumeCenter: number[] | null = null;
  const volume = cornerstone.cache.getVolume(volumeId);
  const bounds = (volume as any)?.imageData?.getBounds?.();
  if (bounds && bounds.length === 6) {
    volumeCenter = [
      (bounds[0] + bounds[1]) / 2,
      (bounds[2] + bounds[3]) / 2,
      (bounds[4] + bounds[5]) / 2,
    ];
  }

  if (!volumeCenter) {
    const focalPoints = MPR_VIEWPORT_IDS
      .map((viewportId) => engine.getViewport(viewportId)?.getCamera()?.focalPoint)
      .filter(Boolean) as cornerstone.Types.Point3[];
    if (focalPoints.length > 0) {
      volumeCenter = [
        focalPoints.reduce((sum, point) => sum + point[0], 0) / focalPoints.length,
        focalPoints.reduce((sum, point) => sum + point[1], 0) / focalPoints.length,
        focalPoints.reduce((sum, point) => sum + point[2], 0) / focalPoints.length,
      ];
    }
  }

  if (!volumeCenter) {
    return;
  }

  for (const viewportId of MPR_VIEWPORT_IDS) {
    const viewport = engine.getViewport(viewportId);
    if (!viewport) {
      continue;
    }
    const camera = viewport.getCamera();
    const normal = camera.viewPlaneNormal || [0, 0, 1];
    const distance =
      camera.position && camera.focalPoint
        ? Math.hypot(
            camera.position[0] - camera.focalPoint[0],
            camera.position[1] - camera.focalPoint[1],
            camera.position[2] - camera.focalPoint[2]
          )
        : 1000;

    viewport.setCamera({
      focalPoint: volumeCenter as cornerstone.Types.Point3,
      position: [
        volumeCenter[0] + normal[0] * distance,
        volumeCenter[1] + normal[1] * distance,
        volumeCenter[2] + normal[2] * distance,
      ] as cornerstone.Types.Point3,
    });
  }

  for (const viewportId of MPR_VIEWPORT_IDS) {
    try {
      crosshairsTool.initializeViewport({ renderingEngineId, viewportId });
    } catch {
      // Ignore repeat initialization.
    }
  }

  crosshairsTool.toolCenter = [...volumeCenter];
  engine.renderViewports(MPR_VIEWPORT_IDS);
}

/**
 * Attaches advanced clinical interaction listeners for Phase 11.
 * Supports: Ctrl + Middle + Wheel -> Dynamic Slab Thickness
 */
export function attachAdvancedInteractions(renderingEngineId: string): () => void {
  const engine = cornerstone.getRenderingEngine(renderingEngineId);
  if (!engine) return () => {};

  const handleWheel = (evt: WheelEvent) => {
    if (!evt.ctrlKey || !(evt.buttons & 4)) return; // Ctrl + Middle Button
    evt.preventDefault();
    evt.stopPropagation();

    const targetElement = evt.currentTarget as HTMLElement;
    const viewportId = targetElement.getAttribute('data-viewport-id');
    if (!viewportId) return;

    const viewport = engine.getViewport(viewportId) as cornerstone.Types.IVolumeViewport;
    if (!viewport) return;

    const delta = evt.deltaY > 0 ? 1 : -1;
    const actors = viewport.getActors();
    
    actors.forEach(actor => {
      if (actor.uid.includes('coronaryVolume')) {
         const currentSlab = (viewport as any).getSlabThickness?.() || 0;
         const nextSlab = Math.max(0, currentSlab + delta * 2);
         viewport.setSlabThickness(nextSlab);
         viewport.render();
      }
    });

    // Also update Crosshairs tool if active
    if (mprToolGroup) {
      const crosshairsTool = mprToolGroup.getToolInstance(getToolNames().Crosshairs) as any;
      if (crosshairsTool) {
        // Force crosshairs to re-render or update its own thickness if needed
      }
    }
  };

  const viewports = MPR_VIEWPORT_IDS.map(id => document.getElementById(`viewport-${id}`));
  viewports.forEach(v => {
    if (v) v.addEventListener('wheel', handleWheel, { passive: false });
  });

  return () => {
    viewports.forEach(v => {
      if (v) v.removeEventListener('wheel', handleWheel);
    });
  };
}

export function destroyToolGroups(): void {
  if (zoomPanSync) {
    cornerstoneTools.SynchronizerManager.destroySynchronizer(zoomPanSync.id);
    zoomPanSync = undefined;
  }

  if (voiSync) {
    cornerstoneTools.SynchronizerManager.destroySynchronizer(voiSync.id);
    voiSync = undefined;
  }

  if (mprToolGroup) {
    cornerstoneTools.ToolGroupManager.destroyToolGroup(MPR_TOOL_GROUP_ID);
    mprToolGroup = undefined;
  }
}
