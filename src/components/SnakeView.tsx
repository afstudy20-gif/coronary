import * as cornerstone from '@cornerstonejs/core';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { CoronaryVesselRecord, WorldPoint3D, LumenContour } from '../coronary/QCATypes';
import { 
  toVec, toPoint, add, subtract, scale, dot, cross, magnitude, normalize, clamp, lerpPoint,
  type Vec3, type Frame3D,
  generateCircularContour, applySphereBrush, generateVesselWallContour,
  pointAtDist, frameAtDist, interpolateContourRadii
} from '../coronary/QCAGeometry';

export type SnakeViewMode = 'curved' | 'stretched' | 'calcifications';

type CanvasKind = 'snake' | 'perpendicular';

interface CanvasPoint {
  x: number;
  y: number;
}

interface SnakePoint {
  x: number;
  y: number;
  distanceMm: number;
}

interface SnakeLayout {
  width: number;
  height: number;
  margin: number;
  scaleX: number;
  scaleY: number;
  centerY: number;
  minX: number;
  maxX: number;
  flattened: SnakePoint[];
  pixels: SnakePoint[];
}

interface PerpendicularLayout {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  scale: number;
  pixels: SnakePoint[];
}

interface DragState {
  kind: 'none' | 'snake-point' | 'perpendicular-point' | 'rotate-candidate' | 'rotate' | 'cursor-line' | 'sculpt' | 'diameter-handle-min' | 'diameter-handle-max';
  canvas: CanvasKind;
  pointIndex: number;
  startClientX: number;
  startClientY: number;
  startPoint: WorldPoint3D | null;
  startPoints: WorldPoint3D[];
  startRotation: number;
  moved: boolean;
}

interface Props {
  visible: boolean;
  volumeId: string;
  record: CoronaryVesselRecord;
  selectedPointIndex: number | null;
  rotationDegrees: number;
  onClose: () => void;
  onRotationChange: (degrees: number) => void;
  onSelectPoint: (index: number) => void;
  onPointsChange: (points: WorldPoint3D[]) => void;
  onRequestPointMenu: (pointIndex: number, clientX: number, clientY: number) => void;
  onRequestSnakeMenu?: (distanceMm: number, clientX: number, clientY: number) => void;
  onStatusChange?: (message: string) => void;
  cursorDistanceMm?: number;
  onCursorChange?: (distanceMm: number) => void;
  onContourChange?: (contour: LumenContour) => void;
  pendingStenosisProximalMm?: number | null;
  onStenosisCommitted?: (distalMm: number) => void;
  editContourMode?: boolean;
  onEditContourModeChange?: (active: boolean) => void;
  editVesselWallMode?: boolean;
  onEditVesselWallModeChange?: (active: boolean) => void;
  diameterHandlesVisible?: boolean;
  onDiameterOverrideChange?: (distanceMm: number, minDiameterMm?: number, maxDiameterOverrideMm?: number) => void;
  clinical?: {
    mldDistanceMm: number;
    mldDiameterMm: number;
    proximalReferenceDistanceMm?: number;
    proximalReferenceDiameterMm?: number;
    distalReferenceDistanceMm?: number;
    distalReferenceDiameterMm?: number;
  };
}

const SNAKE_CANVAS_HEIGHT = 360;
const PERPENDICULAR_CANVAS_SIZE = 300;
const HIT_RADIUS = 10;
const SEGMENT_HIT_DISTANCE = 8;
const VOI_LOWER = 0;
const VOI_UPPER = 700;
const SNAKE_SLAB_HALF_WIDTH_MM = 2.5;
const SNAKE_SLAB_SAMPLES = 7;
const PERPENDICULAR_TANGENT_HALF_WIDTH_MM = 2.0;
const PERPENDICULAR_TANGENT_SAMPLES = 7;

interface VolumeContext {
  imageData: any;
  dimensions: [number, number, number];
  voxelManager?: any;
  scalarData?: any;
}

function clonePoints(points: WorldPoint3D[]): WorldPoint3D[] {
  return points.map((point) => ({ ...point }));
}

function frameAt(points: WorldPoint3D[], index: number, rotationDegrees: number): Frame3D {
  const current = toVec(points[index]);
  const previous = toVec(points[Math.max(0, index - 1)] || points[index]);
  const next = toVec(points[Math.min(points.length - 1, index + 1)] || points[index]);

  let tangent = normalize(subtract(next, previous));
  if (magnitude(tangent) === 0) {
    tangent = normalize(subtract(next, current));
  }
  if (magnitude(tangent) === 0) {
    tangent = [1, 0, 0];
  }

  const helper: Vec3 = Math.abs(dot(tangent, [0, 0, 1])) < 0.82 ? [0, 0, 1] : [0, 1, 0];
  let baseLateral = normalize(cross(helper, tangent));
  if (magnitude(baseLateral) === 0) {
    baseLateral = normalize(cross([1, 0, 0], tangent));
  }
  let basePerpendicular = normalize(cross(tangent, baseLateral));
  if (magnitude(basePerpendicular) === 0) {
    basePerpendicular = [0, 1, 0];
  }

  const radians = (rotationDegrees * Math.PI) / 180;
  const rotatedLateral = normalize(
    add(scale(baseLateral, Math.cos(radians)), scale(basePerpendicular, Math.sin(radians)))
  );
  const rotatedPerpendicular = normalize(cross(tangent, rotatedLateral));

  return {
    tangent,
    lateral: rotatedLateral,
    perpendicular: rotatedPerpendicular,
  };
}



function buildSnakeLayout(
  points: WorldPoint3D[],
  rotationDegrees: number,
  width: number,
  height: number,
  viewMode: SnakeViewMode
): SnakeLayout {
  const margin = 18;
  if (points.length === 0) {
    return {
      width,
      height,
      margin,
      scaleX: 1,
      scaleY: 1,
      centerY: height / 2,
      minX: 0,
      maxX: 0,
      flattened: [],
      pixels: [],
    };
  }

  let currentDistance = 0;
  const flattened: SnakePoint[] = [{ x: 0, y: 0, distanceMm: 0 }];
  for (let index = 0; index < points.length - 1; index += 1) {
    const frame = frameAt(points, index, rotationDegrees);
    const delta = subtract(toVec(points[index + 1]), toVec(points[index]));
    currentDistance += magnitude(delta);
    if (viewMode === 'curved') {
      flattened.push({
        x: flattened[index].x + dot(delta, frame.tangent),
        y: flattened[index].y + dot(delta, frame.lateral),
        distanceMm: currentDistance,
      });
    } else {
      flattened.push({
        x: flattened[index].x + magnitude(delta),
        y: 0,
        distanceMm: currentDistance,
      });
    }
  }

  const minX = Math.min(...flattened.map((point) => point.x));
  const maxX = Math.max(...flattened.map((point) => point.x));
  const maxAbsY = Math.max(14, ...flattened.map((point) => Math.abs(point.y)));
  const scaleX = (width - margin * 2) / Math.max(12, maxX - minX || 12);
  const scaleY = Math.min((height - 34) / (maxAbsY * 2), Math.max(scaleX * 0.65, 1));
  const centerY = height / 2;

  return {
    width,
    height,
    margin,
    scaleX,
    scaleY,
    centerY,
    minX,
    maxX,
    flattened,
    pixels: flattened.map((point) => ({
      x: margin + (point.x - minX) * scaleX,
      y: centerY - point.y * scaleY,
      distanceMm: point.distanceMm,
    })),
  };
}

function buildPerpendicularLayout(
  points: WorldPoint3D[],
  cursorDistanceMm: number,
  rotationDegrees: number,
  width: number,
  height: number
): PerpendicularLayout {
  const centerX = width / 2;
  const centerY = height / 2;

  if (points.length === 0) {
    return {
      width,
      height,
      centerX,
      centerY,
      scale: 1,
      pixels: [],
    };
  }

  const distances = [0];
  for (let i = 0; i < points.length - 1; i++) {
    distances.push(distances[i] + magnitude(subtract(toVec(points[i + 1]), toVec(points[i]))));
  }

  let pointIndex = 0;
  let t = 0;
  for (let i = 0; i < distances.length - 1; i += 1) {
    if (cursorDistanceMm >= distances[i] && cursorDistanceMm <= distances[i + 1]) {
      pointIndex = i;
      t = distances[i + 1] - distances[i] === 0 ? 0 : (cursorDistanceMm - distances[i]) / (distances[i + 1] - distances[i]);
      break;
    }
  }
  if (cursorDistanceMm > distances[distances.length - 1]) {
    pointIndex = distances.length - 1;
    t = 0;
  }

  const frame = frameAt(points, pointIndex, rotationDegrees);
  const origin = toVec(
    pointIndex < points.length - 1
      ? lerpPoint(points[pointIndex], points[pointIndex + 1], t)
      : points[pointIndex]
  );
  
  const projected = points.map((point) => {
    const delta = subtract(toVec(point), origin);
    return {
      x: dot(delta, frame.lateral),
      y: dot(delta, frame.perpendicular),
    };
  });
  const maxAbs = Math.max(
    18,
    ...projected.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)])
  );
  const scaleFactor = (Math.min(width, height) / 2 - 22) / maxAbs;

  return {
    width,
    height,
    centerX,
    centerY,
    scale: scaleFactor,
    pixels: projected.map((point, i) => ({
      x: centerX + point.x * scaleFactor,
      y: centerY - point.y * scaleFactor,
      distanceMm: distances[i],
    })),
  };
}

function pointDistance(point: CanvasPoint, target: CanvasPoint): number {
  return Math.hypot(point.x - target.x, point.y - target.y);
}

function hitPoint(pixels: CanvasPoint[], target: CanvasPoint, radius = HIT_RADIUS): number {
  return pixels.findIndex((point) => pointDistance(point, target) <= radius);
}

function projectOntoSegment(point: CanvasPoint, lhs: SnakePoint, rhs: SnakePoint): { distance: number; t: number } {
  const dx = rhs.x - lhs.x;
  const dy = rhs.y - lhs.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return { distance: pointDistance(point, lhs), t: 0 };
  }

  let t = ((point.x - lhs.x) * dx + (point.y - lhs.y) * dy) / lengthSquared;
  t = clamp(t, 0, 1);
  const nearest = {
    x: lhs.x + dx * t,
    y: lhs.y + dy * t,
    distanceMm: lhs.distanceMm + (rhs.distanceMm - lhs.distanceMm) * t,
  };
  return {
    distance: pointDistance(point, nearest),
    t,
  };
}

function hitSnakeSegment(
  pixels: SnakePoint[],
  target: CanvasPoint
): { segmentIndex: number; t: number } | null {
  for (let index = 0; index < pixels.length - 1; index += 1) {
    const projection = projectOntoSegment(target, pixels[index], pixels[index + 1]);
    if (projection.distance <= SEGMENT_HIT_DISTANCE) {
      return { segmentIndex: index, t: projection.t };
    }
  }
  return null;
}

function syncCanvasBackingStore(canvas: HTMLCanvasElement | null): boolean {
  if (!canvas) {
    return false;
  }

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.floor(rect.width * dpr));
  const nextHeight = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    return true;
  }
  return false;
}

function canvasPointFromMouse(event: ReactMouseEvent<HTMLCanvasElement>): CanvasPoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function getVolumeContext(volumeId: string): VolumeContext | null {
  try {
    let volume = cornerstone.cache.getVolume(volumeId) as any;
    
    // RADICAL CACHE LOOKUP: If ID lookup fails, search for any volume containing 'coronary'
    // This is necessary because streaming loaders often prefix the ID (e.g. streaming:UID)
    if (!volume) {
      const allVolumes = (cornerstone.cache as any).getVolumes();
      volume = allVolumes.find((v: any) => 
         v.volumeId.includes('coronary') || v.volumeId.includes(volumeId) || v.volumeId.includes('Volume')
      );
    }
    
    if (!volume) return null;

    // Use getVtkImageData() for v2.0+ compatibility if needed
    const imageData = volume.imageData || (typeof volume.getVtkImageData === 'function' ? volume.getVtkImageData() : null);
    if (!imageData) return null;

    const dimensions = volume.dimensions || (imageData.getDimensions ? imageData.getDimensions() : [0, 0, 0]);
    if (dimensions[0] <= 1) return null;

    return {
      imageData,
      voxelManager: volume.voxelManager,
      scalarData: volume.scalarData || (typeof volume.getScalarData === 'function' ? (() => { try { return volume.getScalarData(); } catch(e){ return null; } })() : null),
      dimensions: [dimensions[0], dimensions[1], dimensions[2]],
    };
  } catch (err) {
     return null;
  }
}


function sampleVoxelTrilinear(volume: VolumeContext, world: Vec3): number {
  const continuousIndex = volume.imageData.worldToIndex(world as unknown as cornerstone.Types.Point3);
  if (!continuousIndex) return VOI_LOWER;

  const [dimX, dimY, dimZ] = volume.dimensions;
  const x = continuousIndex[0], y = continuousIndex[1], z = continuousIndex[2];

  if (x < 0 || y < 0 || z < 0 || x > dimX - 1 || y > dimY - 1 || z > dimZ - 1) {
    return VOI_LOWER;
  }

  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, dimX - 1), y1 = Math.min(y0 + 1, dimY - 1), z1 = Math.min(z0 + 1, dimZ - 1);
  const tx = x - x0, ty = y - y0, tz = z - z0;

  // Use voxelManager.getAt for Streaming volumes (prevents "No scalar data" exceptions)
  const getV = (ix: number, iy: number, iz: number): number => {
     if (volume.voxelManager && typeof volume.voxelManager.getAt === 'function') {
        return volume.voxelManager.getAt(ix, iy, iz) ?? VOI_LOWER;
     }
     if (volume.scalarData) {
        const offset = iz * dimX * dimY + iy * dimX + ix;
        return volume.scalarData[offset] ?? VOI_LOWER;
     }
     return VOI_LOWER;
  };

  const c000 = Number(getV(x0, y0, z0)), c100 = Number(getV(x1, y0, z0));
  const c010 = Number(getV(x0, y1, z0)), c110 = Number(getV(x1, y1, z0));
  const c001 = Number(getV(x0, y0, z1)), c101 = Number(getV(x1, y0, z1));
  const c011 = Number(getV(x0, y1, z1)), c111 = Number(getV(x1, y1, z1));

  const c00 = c000 * (1 - tx) + c100 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;

  return c0 * (1 - tz) + c1 * tz;
}

function sampleSlabMax(
  volume: VolumeContext,
  origin: Vec3,
  axis: Vec3,
  halfWidthMm: number,
  steps: number
): number {
  if (steps <= 1 || halfWidthMm <= 0) {
    return sampleVoxelTrilinear(volume, origin);
  }

  let best = -Infinity;
  for (let step = 0; step < steps; step += 1) {
    const t = steps === 1 ? 0 : step / (steps - 1);
    const offset = -halfWidthMm + t * halfWidthMm * 2;
    const world = add(origin, scale(axis, offset));
    best = Math.max(best, sampleVoxelTrilinear(volume, world));
  }
  return best;
}

function intensityToGray(value: number, mode: SnakeViewMode): number {
  const lower = mode === 'calcifications' ? 130 : VOI_LOWER;
  const upper = mode === 'calcifications' ? 1000 : VOI_UPPER;
  const normalized = clamp((value - lower) / (upper - lower), 0, 1);
  return Math.round(Math.pow(normalized, 0.75) * 255);
}

function drawGrayscaleImage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewMode: SnakeViewMode,
  sampleValue: (x: number, y: number) => number
) {
  const imageData = ctx.createImageData(width, height);
  const pixels = imageData.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gray = intensityToGray(sampleValue(x, y), viewMode);
      const offset = (y * width + x) * 4;
      pixels[offset] = gray;
      pixels[offset + 1] = gray;
      pixels[offset + 2] = gray;
      pixels[offset + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

function sampleSnakeColumn(
  layout: SnakeLayout,
  points: WorldPoint3D[],
  rotationDegrees: number,
  canvasX: number
): { centerWorld: Vec3; frame: Frame3D; centerCanvasY: number } | null {
  if (points.length === 0 || layout.flattened.length === 0) {
    return null;
  }

  if (points.length === 1) {
    const frame = frameAt(points, 0, rotationDegrees);
    return {
      centerWorld: toVec(points[0]),
      frame,
      centerCanvasY: layout.pixels[0]?.y ?? layout.centerY,
    };
  }

  const xMm = layout.minX + (canvasX - layout.margin) / Math.max(layout.scaleX, 0.001);
  for (let index = 0; index < layout.flattened.length - 1; index += 1) {
    const lhs = layout.flattened[index];
    const rhs = layout.flattened[index + 1];
    const minX = Math.min(lhs.x, rhs.x);
    const maxX = Math.max(lhs.x, rhs.x);
    if (xMm < minX || xMm > maxX) {
      continue;
    }

    const deltaX = rhs.x - lhs.x;
    const t = Math.abs(deltaX) < 1e-5 ? 0 : clamp((xMm - lhs.x) / deltaX, 0, 1);
    const world = lerpPoint(points[index], points[index + 1], t);
    const centerYmm = lhs.y + (rhs.y - lhs.y) * t;
    return {
      centerWorld: toVec(world),
      frame: frameAt(points, index, rotationDegrees),
      centerCanvasY: layout.centerY - centerYmm * layout.scaleY,
    };
  }

  const fallbackIndex = xMm < layout.flattened[0].x ? 0 : points.length - 1;
  return {
    centerWorld: toVec(points[fallbackIndex]),
    frame: frameAt(points, fallbackIndex, rotationDegrees),
    centerCanvasY: layout.pixels[fallbackIndex]?.y ?? layout.centerY,
  };
}

export function SnakeView({
  visible,
  volumeId,
  record,
  selectedPointIndex,
  rotationDegrees,
  onClose,
  onRotationChange,
  onSelectPoint,
  onPointsChange,
  onRequestPointMenu,
  onRequestSnakeMenu,
  onStatusChange,
  cursorDistanceMm: externalCursorDistanceMm,
  onCursorChange,
  onContourChange,
  pendingStenosisProximalMm = null,
  onStenosisCommitted,
  editContourMode = false,
  onEditContourModeChange,
  editVesselWallMode = false,
  onEditVesselWallModeChange,
  diameterHandlesVisible = false,
  onDiameterOverrideChange,
  clinical,
}: Props) {
  const [viewMode, setViewMode] = useState<SnakeViewMode>('stretched');
  const [internalCursorDistanceMm, setInternalCursorDistanceMm] = useState<number>(0);
  const cursorDistanceMm = externalCursorDistanceMm ?? internalCursorDistanceMm;
  const setCursorDistanceMm = onCursorChange ?? setInternalCursorDistanceMm;

  const [brushRadiusMm, setBrushRadiusMm] = useState(3);
  const [perpendicularMousePos, setPerpendicularMousePos] = useState<CanvasPoint>({ x: -100, y: -100 });

  const snakeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const perpendicularCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState>({
    kind: 'none',
    canvas: 'snake',
    pointIndex: -1,
    startClientX: 0,
    startClientY: 0,
    startPoint: null,
    startPoints: [],
    startRotation: rotationDegrees,
    moved: false,
  });
  const suppressClickRef = useRef<CanvasKind | null>(null);

  const points = record.centerlinePoints;
  const activeIndex =
    points.length === 0
      ? -1
      : clamp(selectedPointIndex ?? points.length - 1, 0, points.length - 1);

  useEffect(() => {
    if (!visible || points.length === 0 || selectedPointIndex != null) {
      return;
    }
    onSelectPoint(points.length - 1);
  }, [onSelectPoint, points.length, selectedPointIndex, visible]);

  useEffect(() => {
    if (activeIndex >= 0 && points.length > 0) {
      let d = 0;
      for (let i = 0; i < activeIndex; i++) {
        d += magnitude(subtract(toVec(points[i + 1]), toVec(points[i])));
      }
      setCursorDistanceMm(d);
    }
  }, [activeIndex, points]);

  useEffect(() => {
    if (points.length === 0) return;
    const distances = [0];
    for (let i = 0; i < points.length - 1; i++) {
      distances.push(distances[i] + magnitude(subtract(toVec(points[i + 1]), toVec(points[i]))));
    }
    let pointIndex = 0;
    let t = 0;
    for (let i = 0; i < distances.length - 1; i += 1) {
      if (cursorDistanceMm >= distances[i] && cursorDistanceMm <= distances[i + 1]) {
        pointIndex = i;
        t = distances[i + 1] - distances[i] === 0 ? 0 : (cursorDistanceMm - distances[i]) / (distances[i + 1] - distances[i]);
        break;
      }
    }
    if (cursorDistanceMm > distances[distances.length - 1]) {
      pointIndex = distances.length - 1;
      t = 0;
    }
    const frame = frameAt(points, pointIndex, rotationDegrees);
    const point = pointIndex < points.length - 1 ? lerpPoint(points[pointIndex], points[pointIndex + 1], t) : points[pointIndex];
    window.dispatchEvent(new CustomEvent('coronary:cursor-moved', { detail: { point, frame } }));
  }, [cursorDistanceMm, points, rotationDegrees]);

  function redrawSnakeCanvas(): SnakeLayout | null {
    const canvas = snakeCanvasRef.current;
    if (!canvas) {
      return null;
    }
    if (syncCanvasBackingStore(canvas)) { }
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = { width: canvas.width / dpr, height: canvas.height / dpr };
    if (!ctx || width <= 1 || height <= 1) return null;

    const layout = buildSnakeLayout(points, rotationDegrees, width, height, viewMode);
    const volume = getVolumeContext(volumeId);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(7, 16, 24, 0.94)';
    ctx.fillRect(0, 0, width, height);

    // Render centerline immediately 
    if (layout.pixels.length > 0) {
      ctx.beginPath();
      ctx.moveTo(layout.pixels[0].x, layout.pixels[0].y);
      for (let i = 1; i < layout.pixels.length; i++) ctx.lineTo(layout.pixels[i].x, layout.pixels[i].y);
      ctx.strokeStyle = record.color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(121, 199, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.margin, layout.centerY);
    ctx.lineTo(width - layout.margin, layout.centerY);
    ctx.stroke();

    if (layout.pixels.length === 0) {
      ctx.fillStyle = '#a9b9c9';
      ctx.font = '12px "Avenir Next", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Create at least one control point to open Snake View.', width / 2, height / 2);
      ctx.restore();
      return layout;
    }

    if (volume) {
      drawGrayscaleImage(ctx, Math.floor(width), Math.floor(height), viewMode, (x, y) => {
        const sample = sampleSnakeColumn(layout, points, rotationDegrees, x + 0.5);
        if (!sample) {
          return VOI_LOWER;
        }
        const lateralOffsetMm = (sample.centerCanvasY - (y + 0.5)) / Math.max(layout.scaleY, 0.001);
        const origin = add(sample.centerWorld, scale(sample.frame.lateral, lateralOffsetMm));
        return sampleSlabMax(
          volume,
          origin,
          sample.frame.perpendicular,
          SNAKE_SLAB_HALF_WIDTH_MM,
          SNAKE_SLAB_SAMPLES
        );
      });
      ctx.fillStyle = 'rgba(7, 16, 24, 0.18)';
      ctx.fillRect(0, 0, width, 24);
      ctx.fillRect(0, height - 22, width, 22);
    }

    ctx.beginPath();
    ctx.moveTo(layout.pixels[0].x, layout.pixels[0].y);
    for (let index = 1; index < layout.pixels.length; index += 1) {
      ctx.lineTo(layout.pixels[index].x, layout.pixels[index].y);
    }
    ctx.strokeStyle = record.color;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Render Longitudinal Plaque (Lumen & EEM) in Stretched Mode
    if (viewMode === 'stretched' && record.lumenContours.length > 0) {
       const topLumen: {x: number, y: number}[] = [];
       const bottomLumen: {x: number, y: number}[] = [];
       const topEEM: {x: number, y: number}[] = [];
       const bottomEEM: {x: number, y: number}[] = [];
       
       layout.pixels.forEach(p => {
          const radii = interpolateContourRadii(record.lumenContours, points, p.distanceMm);
          topLumen.push({ x: p.x, y: p.y - radii.inner * layout.scaleY });
          bottomLumen.push({ x: p.x, y: p.y + radii.inner * layout.scaleY });
          topEEM.push({ x: p.x, y: p.y - radii.outer * layout.scaleY });
          bottomEEM.push({ x: p.x, y: p.y + radii.outer * layout.scaleY });
       });

       // 1. Fill Plaque Area (between Lumen and EEM)
       ctx.beginPath();
       ctx.moveTo(topEEM[0].x, topEEM[0].y);
       for(let i=1; i<topEEM.length; i++) ctx.lineTo(topEEM[i].x, topEEM[i].y);
       for(let i=topLumen.length-1; i>=0; i--) ctx.lineTo(topLumen[i].x, topLumen[i].y);
       ctx.closePath();
       ctx.fillStyle = 'rgba(255, 140, 0, 0.25)'; // Plaque color
       ctx.fill();

       ctx.beginPath();
       ctx.moveTo(bottomEEM[0].x, bottomEEM[0].y);
       for(let i=1; i<bottomEEM.length; i++) ctx.lineTo(bottomEEM[i].x, bottomEEM[i].y);
       for(let i=bottomLumen.length-1; i>=0; i--) ctx.lineTo(bottomLumen[i].x, bottomLumen[i].y);
       ctx.closePath();
       ctx.fill();
       
       // 2. Draw Lumen Boundary
       ctx.beginPath();
       ctx.moveTo(topLumen[0].x, topLumen[0].y);
       for(let i=1; i<topLumen.length; i++) ctx.lineTo(topLumen[i].x, topLumen[i].y);
       ctx.strokeStyle = '#00BFFF';
       ctx.lineWidth = 1.5;
       ctx.stroke();

       ctx.beginPath();
       ctx.moveTo(bottomLumen[0].x, bottomLumen[0].y);
       for(let i=1; i<bottomLumen.length; i++) ctx.lineTo(bottomLumen[i].x, bottomLumen[i].y);
       ctx.stroke();

       // 3. Draw EEM Boundary (Vessel Wall)
       ctx.beginPath();
       ctx.moveTo(topEEM[0].x, topEEM[0].y);
       for(let i=1; i<topEEM.length; i++) ctx.lineTo(topEEM[i].x, topEEM[i].y);
       ctx.strokeStyle = 'rgba(255, 160, 0, 0.4)';
       ctx.lineWidth = 1;
       ctx.stroke();

       ctx.beginPath();
       ctx.moveTo(bottomEEM[0].x, bottomEEM[0].y);
       for(let i=1; i<bottomEEM.length; i++) ctx.lineTo(bottomEEM[i].x, bottomEEM[i].y);
       ctx.stroke();
    }

    layout.pixels.forEach((point, index) => {
      // We don't render activeIndex circles anymore, we render the cursor line
    });

    const cursorPoint = layout.pixels.find(p => p.distanceMm >= cursorDistanceMm) || layout.pixels[layout.pixels.length - 1];
    if (cursorPoint) {
      let canvasX = cursorPoint.x;
      // Interpolate x accurately
      const idx = layout.pixels.findIndex(p => p.distanceMm >= cursorDistanceMm);
      if (idx > 0) {
        const p1 = layout.pixels[idx - 1];
        const p2 = layout.pixels[idx];
        const t = (cursorDistanceMm - p1.distanceMm) / (p2.distanceMm - p1.distanceMm);
        canvasX = p1.x + (p2.x - p1.x) * t;
      } else if (idx === 0) {
        canvasX = layout.pixels[0].x;
      }
      ctx.beginPath();
      ctx.moveTo(canvasX, 0);
      ctx.lineTo(canvasX, height);
      ctx.strokeStyle = '#22d8e4';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    function drawVerticalLineAtDist(distMm: number, color: string, dashed: boolean) {
      if (!ctx) return;
      const idx = layout.pixels.findIndex(p => p.distanceMm >= distMm);
      let canvasX: number | null = null;
      if (idx > 0) {
        const p1 = layout.pixels[idx - 1];
        const p2 = layout.pixels[idx];
        const t = (distMm - p1.distanceMm) / (p2.distanceMm - p1.distanceMm);
        canvasX = p1.x + (p2.x - p1.x) * t;
      } else if (idx === 0) {
        canvasX = layout.pixels[0].x;
      } else if (idx === -1 && layout.pixels.length > 0 && distMm > layout.pixels[layout.pixels.length - 1].distanceMm) {
        canvasX = layout.pixels[layout.pixels.length - 1].x;
      }
      
      if (canvasX !== null) {
        ctx.beginPath();
        ctx.moveTo(canvasX, 0);
        ctx.lineTo(canvasX, height);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        if (dashed) ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (pendingStenosisProximalMm != null) {
      drawVerticalLineAtDist(pendingStenosisProximalMm, '#f8d16c', true);
    }

    if (record.stenosisMeasurement) {
      drawVerticalLineAtDist(record.stenosisMeasurement.lesionStartMm, '#ff4757', false);
      drawVerticalLineAtDist(record.stenosisMeasurement.lesionEndMm, '#ff4757', false);
      drawVerticalLineAtDist(record.stenosisMeasurement.proximalReferenceMm, '#2ed573', true);
      drawVerticalLineAtDist(record.stenosisMeasurement.distalReferenceMm, '#2ed573', true);
    }

    if (clinical) {
      if (clinical.mldDiameterMm > 0) {
        drawVerticalLineAtDist(clinical.mldDistanceMm, '#ff5252', true);
        // Add text label for MLD
        const x = layout.pixels.find(p => p.distanceMm >= clinical.mldDistanceMm)?.x ?? 0;
        ctx.fillStyle = '#ff5252';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`MLD: ${clinical.mldDiameterMm.toFixed(2)}`, x, 38);
      }
      if (clinical.proximalReferenceDistanceMm != null) {
        drawVerticalLineAtDist(clinical.proximalReferenceDistanceMm, 'rgba(255,255,255,0.4)', false);
      }
    }

    record.markers.forEach((marker) => {
      drawVerticalLineAtDist(marker.distanceMm, marker.color, false);
      const idx = layout.pixels.findIndex(p => p.distanceMm >= marker.distanceMm);
      let canvasX: number | null = null;
      if (idx > 0) {
        const p1 = layout.pixels[idx - 1];
        const p2 = layout.pixels[idx];
        const t = (marker.distanceMm - p1.distanceMm) / (p2.distanceMm - p1.distanceMm);
        canvasX = p1.x + (p2.x - p1.x) * t;
      } else if (idx === 0) {
        canvasX = layout.pixels[0].x;
      }
      if (canvasX !== null && ctx) {
        ctx.fillStyle = marker.color;
        ctx.font = '10px "Avenir Next", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(marker.label, canvasX + 4, 28);
      }
    });

    const distalPoint = layout.pixels[layout.pixels.length - 1];
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(distalPoint.x, distalPoint.y);
    ctx.lineTo(width - layout.margin, distalPoint.y);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#edf4fb';
    ctx.font = '12px "Avenir Next", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${record.label} snake`, 14, 18);
    ctx.textAlign = 'right';
    ctx.fillText(`rotation ${rotationDegrees.toFixed(0)}°`, width - 14, 18);

    ctx.fillStyle = '#a9b9c9';
    ctx.font = '11px "Avenir Next", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      'Wheel: change point  |  Drag point: edit  |  Click segment: insert  |  Click right side: extend',
      width / 2,
      height - 12
    );

    ctx.restore();
    return layout;
  }

  function redrawPerpendicularCanvas(snakeLayoutPixels: SnakePoint[], distances: number[]) {
    const canvas = perpendicularCanvasRef.current;
    if (!canvas) {
      return;
    }
    syncCanvasBackingStore(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const layout = buildPerpendicularLayout(points, cursorDistanceMm, rotationDegrees, width, height);
    const volume = getVolumeContext(volumeId);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(7, 16, 24, 0.92)';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(121, 199, 255, 0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.centerX, 16);
    ctx.lineTo(layout.centerX, height - 16);
    ctx.moveTo(16, layout.centerY);
    ctx.lineTo(width - 16, layout.centerY);
    ctx.stroke();

    if (layout.pixels.length === 0) {
      ctx.fillStyle = '#a9b9c9';
      ctx.font = '12px "Avenir Next", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Perpendicular view', width / 2, height / 2 - 8);
      ctx.fillText('Select a control point to center it here.', width / 2, height / 2 + 12);
      ctx.restore();
      return;
    }

    const frame = frameAtDist(points, cursorDistanceMm, rotationDegrees);
    const centerWorld = toVec(pointAtDist(points, cursorDistanceMm));

    if (volume) {
      drawGrayscaleImage(ctx, Math.floor(width), Math.floor(height), viewMode, (x, y) => {
        const lateralMm = ((x + 0.5) - layout.centerX) / Math.max(layout.scale, 0.001);
        const perpendicularMm = (layout.centerY - (y + 0.5)) / Math.max(layout.scale, 0.001);
        const origin = add(
          add(centerWorld, scale(frame.lateral, lateralMm)),
          scale(frame.perpendicular, perpendicularMm)
        );
        return sampleSlabMax(
          volume,
          origin,
          frame.tangent,
          PERPENDICULAR_TANGENT_HALF_WIDTH_MM,
          PERPENDICULAR_TANGENT_SAMPLES
        );
      });
      ctx.fillStyle = 'rgba(7, 16, 24, 0.14)';
      ctx.fillRect(0, 0, width, 24);
      ctx.fillRect(0, height - 22, width, 22);
    }

    const currentContour = record.lumenContours.find(c => Math.abs(c.distanceMm - cursorDistanceMm) < 0.1);
    if (currentContour && currentContour.points.length > 0) {
      ctx.beginPath();
      currentContour.points.forEach((p, i) => {
        const v = subtract(toVec(p), centerWorld);
        const u = v[0] * frame.lateral[0] + v[1] * frame.lateral[1] + v[2] * frame.lateral[2];
        const w = v[0] * frame.perpendicular[0] + v[1] * frame.perpendicular[1] + v[2] * frame.perpendicular[2];
        const cx = layout.centerX + u * layout.scale;
        const cy = layout.centerY - w * layout.scale;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.closePath();
      ctx.strokeStyle = '#2ed573';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const defaultRadiusMm = 1.5;
      const defaultRadiusCanvas = defaultRadiusMm * Math.max(layout.scale, 0.001);
      ctx.beginPath();
      ctx.arc(layout.centerX, layout.centerY, defaultRadiusCanvas, 0, Math.PI * 2);
      ctx.strokeStyle = '#2ed573';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (editContourMode) {
      const mx = perpendicularMousePos.x;
      const my = perpendicularMousePos.y;
      if (mx >= 0 && my >= 0) {
        ctx.beginPath();
        ctx.arc(mx, my, brushRadiusMm * layout.scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.fill();
        
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${brushRadiusMm.toFixed(1)}mm`, mx, my - brushRadiusMm * layout.scale - 4);
      }
    }

    if (diameterHandlesVisible) {
      const currentContour = record.lumenContours.find(c => Math.abs(c.distanceMm - cursorDistanceMm) < 0.1);
      const minD = currentContour?.minDiameterOverrideMm ?? 1.5;
      const maxD = currentContour?.maxDiameterOverrideMm ?? 2.0;
      const minCanvas = (minD / 2) * layout.scale;
      const maxCanvas = (maxD / 2) * layout.scale;

      // Min diameter (Horizontal?)
      ctx.beginPath();
      ctx.moveTo(layout.centerX - minCanvas, layout.centerY);
      ctx.lineTo(layout.centerX + minCanvas, layout.centerY);
      ctx.strokeStyle = '#79c7ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      
      // Min handles
      ctx.fillStyle = '#79c7ff';
      ctx.beginPath(); ctx.arc(layout.centerX - minCanvas, layout.centerY, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(layout.centerX + minCanvas, layout.centerY, 4, 0, Math.PI * 2); ctx.fill();

      // Max diameter (Vertical?)
      ctx.beginPath();
      ctx.moveTo(layout.centerX, layout.centerY - maxCanvas);
      ctx.lineTo(layout.centerX, layout.centerY + maxCanvas);
      ctx.strokeStyle = '#ff9f68';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Max handles
      ctx.fillStyle = '#ff9f68';
      ctx.beginPath(); ctx.arc(layout.centerX, layout.centerY - maxCanvas, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(layout.centerX, layout.centerY + maxCanvas, 4, 0, Math.PI * 2); ctx.fill();
    }

    // Render Plaque Area (Optional Colorized HU?)
    if (currentContour?.points && currentContour?.vesselPoints) {
       // Just a simple fill for now, colorizing HU requires complex fan rendering
       ctx.beginPath();
       const lp = currentContour.points.map(p => {
          const v = subtract(toVec(p), centerWorld);
          const u = v[0] * frame.lateral[0] + v[1] * frame.lateral[1] + v[2] * frame.lateral[2];
          const w = v[0] * frame.perpendicular[0] + v[1] * frame.perpendicular[1] + v[2] * frame.perpendicular[2];
          return { x: layout.centerX + u * layout.scale, y: layout.centerY - w * layout.scale };
       });
       const vp = currentContour.vesselPoints.map(p => {
          const v = subtract(toVec(p), centerWorld);
          const u = v[0] * frame.lateral[0] + v[1] * frame.lateral[1] + v[2] * frame.lateral[2];
          const w = v[0] * frame.perpendicular[0] + v[1] * frame.perpendicular[1] + v[2] * frame.perpendicular[2];
          return { x: layout.centerX + u * layout.scale, y: layout.centerY - w * layout.scale };
       });
       
       ctx.fillStyle = 'rgba(255, 160, 0, 0.2)'; // Plaque area tint
       ctx.moveTo(vp[0].x, vp[0].y);
       for(let i=1; i<vp.length; i++) ctx.lineTo(vp[i].x, vp[i].y);
       ctx.closePath();
       ctx.moveTo(lp[0].x, lp[0].y);
       for(let i=1; i<lp.length; i++) ctx.lineTo(lp[i].x, lp[i].y);
       ctx.closePath();
       ctx.fill('evenodd');

       // Render EEM (Vessel Wall) Contour
       ctx.beginPath();
       ctx.moveTo(vp[0].x, vp[0].y);
       for(let i=1; i<vp.length; i++) ctx.lineTo(vp[i].x, vp[i].y);
       ctx.closePath();
       ctx.strokeStyle = '#ffb300';
       ctx.lineWidth = editVesselWallMode ? 3 : 2;
       ctx.stroke();
    }

    ctx.fillStyle = '#edf4fb';
    ctx.font = '12px "Avenir Next", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Perpendicular view', 14, 18);
    ctx.textAlign = 'center';
    ctx.fillText(
      `Distance: ${cursorDistanceMm.toFixed(1)} mm`,
      width / 2,
      height - 12
    );

    ctx.restore();
  }

  useEffect(() => {
    if (!visible) {
      return;
    }

    const snakeCanvas = snakeCanvasRef.current;
    const perpendicularCanvas = perpendicularCanvasRef.current;
    if (!snakeCanvas || !perpendicularCanvas) {
      return;
    }

    let rafId: number;
    const redrawAll = () => {
       rafId = requestAnimationFrame(() => {
          try {
             const sl = redrawSnakeCanvas();
             if (sl) redrawPerpendicularCanvas(sl.pixels, sl.pixels.map(p => p.distanceMm));
          } catch (e) { console.error(e); }
       });
    };

    redrawAll();
    const obs = new ResizeObserver(redrawAll);
    obs.observe(snakeCanvas);
    obs.observe(perpendicularCanvas);
    return () => {
      cancelAnimationFrame(rafId);
      obs.disconnect();
    };
  }, [activeIndex, points, record.color, record.label, rotationDegrees, visible, viewMode, record.lumenContours, editContourMode, brushRadiusMm, perpendicularMousePos]);

  useEffect(() => {
    const handleWindowMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (drag.kind === 'none') {
        return;
      }

      if (drag.kind === 'diameter-handle-min' && onDiameterOverrideChange) {
        const layout = buildPerpendicularLayout(points, cursorDistanceMm, rotationDegrees, 200, 200); // Rough dimensions
        const distToCenter = Math.abs((event.clientX - layout.centerX - (perpendicularCanvasRef.current?.getBoundingClientRect().left || 0)) / Math.max(layout.scale, 0.001));
        const currentContour = record.lumenContours.find(c => Math.abs(c.distanceMm - cursorDistanceMm) < 0.1);
        onDiameterOverrideChange(cursorDistanceMm, distToCenter * 2, currentContour?.maxDiameterOverrideMm);
        return;
      }
      
      if (drag.kind === 'diameter-handle-max' && onDiameterOverrideChange) {
        const layout = buildPerpendicularLayout(points, cursorDistanceMm, rotationDegrees, 200, 200);
        const distToCenter = Math.abs((event.clientY - layout.centerY - (perpendicularCanvasRef.current?.getBoundingClientRect().top || 0)) / Math.max(layout.scale, 0.001));
        const currentContour = record.lumenContours.find(c => Math.abs(c.distanceMm - cursorDistanceMm) < 0.1);
        onDiameterOverrideChange(cursorDistanceMm, currentContour?.minDiameterOverrideMm, distToCenter * 2);
        return;
      }

      if (drag.kind === 'sculpt' && onContourChange) {
        const canvas = perpendicularCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const layout = buildPerpendicularLayout(points, cursorDistanceMm, rotationDegrees, canvas.clientWidth, canvas.clientHeight);
        const xCanvas = event.clientX - rect.left;
        const yCanvas = event.clientY - rect.top;
        
        setPerpendicularMousePos({ x: xCanvas, y: yCanvas });
        
        const u = (xCanvas - layout.centerX) / Math.max(layout.scale, 0.001);
        const v = (layout.centerY - yCanvas) / Math.max(layout.scale, 0.001);

        const currentContour = record.lumenContours.find(c => Math.abs(c.distanceMm - cursorDistanceMm) < 0.1) || ({
          distanceMm: cursorDistanceMm,
          points: generateCircularContour(pointAtDist(points, cursorDistanceMm), frameAtDist(points, cursorDistanceMm, rotationDegrees), 1.5)
        } as LumenContour);

        const center = pointAtDist(points, cursorDistanceMm);
        const frame = frameAtDist(points, cursorDistanceMm, rotationDegrees);
        
        if (editVesselWallMode) {
          let vPoints = currentContour.vesselPoints;
          if (!vPoints || vPoints.length === 0) {
            vPoints = generateVesselWallContour(currentContour.points, center, frame, 0.8);
          }
          const nextVPoints = applySphereBrush(vPoints, center, frame, [u, v], brushRadiusMm);
          onContourChange({ ...currentContour, vesselPoints: nextVPoints });
        } else {
          const nextPoints = applySphereBrush(currentContour.points, center, frame, [u, v], brushRadiusMm);
          onContourChange({ ...currentContour, points: nextPoints });
        }
        return;
      }

      (window as any)._lastMousePos = { x: event.clientX, y: event.clientY };

      if (drag.kind === 'cursor-line') {
        const canvas = snakeCanvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const layout = buildSnakeLayout(points, rotationDegrees, canvas.clientWidth, canvas.clientHeight, viewMode);
        const xMm = layout.minX + (event.clientX - rect.left - layout.margin) / Math.max(layout.scaleX, 0.001);
        const nextDist = Math.max(0, xMm); // Assuming xMm is roughly distanceMm
        setCursorDistanceMm(nextDist);
        return;
      }

      const deltaX = event.clientX - drag.startClientX;
      const deltaY = event.clientY - drag.startClientY;

      if (drag.kind === 'rotate-candidate') {
        if (Math.abs(deltaX) < 3 && Math.abs(deltaY) < 3) {
          return;
        }
        drag.kind = 'rotate';
        drag.moved = true;
      }

      if (drag.kind === 'rotate') {
        onRotationChange(drag.startRotation + deltaX * 0.45);
        return;
      }

      if (drag.kind === 'snake-point') {
        const canvas = snakeCanvasRef.current;
        if (!canvas || drag.pointIndex < 0 || !drag.startPoint) {
          return;
        }
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const layout = buildSnakeLayout(drag.startPoints, drag.startRotation, width, height, viewMode);
        const frame = frameAt(drag.startPoints, drag.pointIndex, drag.startRotation);
        const dxMm = deltaX / Math.max(layout.scaleX, 0.001);
        const dyMm = -deltaY / Math.max(layout.scaleY, 0.001);
        const updated = add(
          add(toVec(drag.startPoint), scale(frame.tangent, dxMm)),
          scale(frame.lateral, dyMm)
        );
        const nextPoints = clonePoints(drag.startPoints);
        nextPoints[drag.pointIndex] = toPoint(updated);
        drag.moved = true;
        onPointsChange(nextPoints);
        return;
      }

      if (drag.kind === 'perpendicular-point') {
        const canvas = perpendicularCanvasRef.current;
        if (!canvas || drag.pointIndex < 0 || !drag.startPoint) {
          return;
        }
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const layout = buildPerpendicularLayout(
          drag.startPoints,
          drag.startPoints.length > 0 && drag.pointIndex >= 0 ? 
            (function() {
               let d = 0;
               for (let i = 0; i < drag.pointIndex; i++) {
                 d += magnitude(subtract(toVec(drag.startPoints[i + 1]), toVec(drag.startPoints[i])));
               }
               return d;
            })() : 0,
          drag.startRotation,
          width,
          height
        );
        const frame = frameAt(drag.startPoints, drag.pointIndex, drag.startRotation);
        const dxMm = deltaX / Math.max(layout.scale, 0.001);
        const dyMm = -deltaY / Math.max(layout.scale, 0.001);
        const updated = add(
          add(toVec(drag.startPoint), scale(frame.lateral, dxMm)),
          scale(frame.perpendicular, dyMm)
        );
        const nextPoints = clonePoints(drag.startPoints);
        nextPoints[drag.pointIndex] = toPoint(updated);
        drag.moved = true;
        onPointsChange(nextPoints);
      }
    }

    function handleWindowMouseUp() {
      const drag = dragRef.current;
      if (drag.kind !== 'none' && drag.moved) {
        suppressClickRef.current = drag.canvas;
      }
      dragRef.current = {
        kind: 'none',
        canvas: 'snake',
        pointIndex: -1,
        startClientX: 0,
        startClientY: 0,
        startPoint: null,
        startPoints: [],
        startRotation: rotationDegrees,
        moved: false,
      };
    }

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [onPointsChange, onRotationChange, rotationDegrees, viewMode]);

  function handleSnakeMouseDown(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (points.length === 0) {
      return;
    }

    const target = canvasPointFromMouse(event);
    const layout = buildSnakeLayout(points, rotationDegrees, event.currentTarget.clientWidth, event.currentTarget.clientHeight, viewMode);
    
    // Check if hitting cursor line
    let cursorX = layout.margin;
    const idx = layout.pixels.findIndex(p => p.distanceMm >= cursorDistanceMm);
    if (idx > 0) {
      const p1 = layout.pixels[idx - 1];
      const p2 = layout.pixels[idx];
      const t = (cursorDistanceMm - p1.distanceMm) / (p2.distanceMm - p1.distanceMm);
      cursorX = p1.x + (p2.x - p1.x) * t;
    } else if (idx === 0) {
      cursorX = layout.pixels[0].x;
    }
    
    if (Math.abs(target.x - cursorX) < 15) {
      dragRef.current = {
        kind: 'cursor-line' as any,
        canvas: 'snake',
        pointIndex: -1,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPoint: null,
        startPoints: clonePoints(points),
        startRotation: rotationDegrees,
        moved: false,
      };
      return;
    }

    if (pendingStenosisProximalMm != null && onStenosisCommitted) {
      const xMm = layout.minX + (target.x - layout.margin) / Math.max(layout.scaleX, 0.001);
      const hitDistanceMm = Math.max(0, xMm);
      onStenosisCommitted(hitDistanceMm);
      return;
    }

    const pointIndex = hitPoint(layout.pixels, target);
    if (pointIndex >= 0) {
      onSelectPoint(pointIndex);
      dragRef.current = {
        kind: 'snake-point',
        canvas: 'snake',
        pointIndex,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPoint: { ...points[pointIndex] },
        startPoints: clonePoints(points),
        startRotation: rotationDegrees,
        moved: false,
      };
      return;
    }

    dragRef.current = {
      kind: 'rotate-candidate',
      canvas: 'snake',
      pointIndex: -1,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: null,
      startPoints: clonePoints(points),
      startRotation: rotationDegrees,
      moved: false,
    };
  }

  function handleSnakeClick(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (suppressClickRef.current === 'snake') {
      suppressClickRef.current = null;
      return;
    }

    const target = canvasPointFromMouse(event);
    const layout = buildSnakeLayout(points, rotationDegrees, event.currentTarget.clientWidth, event.currentTarget.clientHeight, viewMode);
    const pointIndex = hitPoint(layout.pixels, target);
    if (pointIndex >= 0) {
      onSelectPoint(pointIndex);
      onStatusChange?.(`${record.label}: centered control point ${pointIndex + 1}.`);
      return;
    }

    const segment = hitSnakeSegment(layout.pixels, target);
    if (segment) {
      const nextPoints = clonePoints(points);
      nextPoints.splice(
        segment.segmentIndex + 1,
        0,
        lerpPoint(points[segment.segmentIndex], points[segment.segmentIndex + 1], segment.t)
      );
      onPointsChange(nextPoints);
      onSelectPoint(segment.segmentIndex + 1);
      onStatusChange?.(`${record.label}: control point inserted.`);
      return;
    }

    if (layout.pixels.length === 0) {
      return;
    }

    const distalPixel = layout.pixels[layout.pixels.length - 1];
    if (target.x <= distalPixel.x + 8) {
      return;
    }

    const frame = frameAt(points, points.length - 1, rotationDegrees);
    const dxMm = Math.max((target.x - distalPixel.x) / Math.max(layout.scaleX, 0.001), 0.8);
    const dyMm = (distalPixel.y - target.y) / Math.max(layout.scaleY, 0.001);
    const newPoint = add(
      add(toVec(points[points.length - 1]), scale(frame.tangent, dxMm)),
      scale(frame.lateral, dyMm)
    );
    const nextPoints = [...clonePoints(points), toPoint(newPoint)];
    onPointsChange(nextPoints);
    onSelectPoint(nextPoints.length - 1);
    onStatusChange?.(`${record.label}: distal control point extended from Snake View.`);
  }

  function handleSnakeWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    if (points.length === 0) {
      return;
    }
    event.preventDefault();
    const baseIndex = activeIndex >= 0 ? activeIndex : points.length - 1;
    const nextIndex = clamp(baseIndex + (event.deltaY > 0 ? 1 : -1), 0, points.length - 1);
    onSelectPoint(nextIndex);
    onStatusChange?.(`${record.label}: centered control point ${nextIndex + 1}.`);
  }

  function handleSnakeContextMenu(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (points.length === 0) {
      return;
    }

    event.preventDefault();
    const target = canvasPointFromMouse(event);
    const layout = buildSnakeLayout(points, rotationDegrees, event.currentTarget.clientWidth, event.currentTarget.clientHeight, viewMode);
    const pointIndex = hitPoint(layout.pixels, target);
    if (pointIndex >= 0) {
      onSelectPoint(pointIndex);
      onRequestPointMenu(pointIndex, event.clientX, event.clientY);
      return;
    }

    if (onRequestSnakeMenu) {
      const xMm = layout.minX + (event.clientX - event.currentTarget.getBoundingClientRect().left - layout.margin) / Math.max(layout.scaleX, 0.001);
      onRequestSnakeMenu(Math.max(0, xMm), event.clientX, event.clientY);
    }
  }

  function handlePerpendicularMouseMove(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (editContourMode) {
       const rect = event.currentTarget.getBoundingClientRect();
       setPerpendicularMousePos({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
  }

  function handlePerpendicularMouseDown(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (activeIndex < 0 || points.length === 0) {
      return;
    }

    const target = canvasPointFromMouse(event);
    const layout = buildPerpendicularLayout(
      points,
      cursorDistanceMm,
      rotationDegrees,
      event.currentTarget.clientWidth,
      event.currentTarget.clientHeight
    );

    const currentContour = record.lumenContours.find(c => Math.abs(c.distanceMm - cursorDistanceMm) < 0.1);

    if (diameterHandlesVisible) {
       const minD = currentContour?.minDiameterOverrideMm ?? 1.5;
       const maxD = currentContour?.maxDiameterOverrideMm ?? 2.0;
       const minCanvas = (minD / 2) * layout.scale;
       const maxCanvas = (maxD / 2) * layout.scale;
       const hitMin = Math.abs(target.y - layout.centerY) < 10 && (Math.abs(target.x - (layout.centerX - minCanvas)) < 10 || Math.abs(target.x - (layout.centerX + minCanvas)) < 10);
       const hitMax = Math.abs(target.x - layout.centerX) < 10 && (Math.abs(target.y - (layout.centerY - maxCanvas)) < 10 || Math.abs(target.y - (layout.centerY + maxCanvas)) < 10);
       
       if (hitMin) {
          dragRef.current = { kind: 'diameter-handle-min', canvas: 'perpendicular', pointIndex: -1, startClientX: event.clientX, startClientY: event.clientY, startPoint: null, startPoints: [], startRotation: 0, moved: false };
          return;
       }
       if (hitMax) {
          dragRef.current = { kind: 'diameter-handle-max', canvas: 'perpendicular', pointIndex: -1, startClientX: event.clientX, startClientY: event.clientY, startPoint: null, startPoints: [], startRotation: 0, moved: false };
          return;
       }
    }

    if (editContourMode || editVesselWallMode) {
      dragRef.current = {
        kind: 'sculpt',
        canvas: 'perpendicular',
        pointIndex: -1,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPoint: null,
        startPoints: clonePoints(points),
        startRotation: rotationDegrees,
        moved: false,
      };
      return;
    }

    const pointIndex = hitPoint(layout.pixels, target);

    if (pointIndex === activeIndex) {
      dragRef.current = {
        kind: 'perpendicular-point',
        canvas: 'perpendicular',
        pointIndex: activeIndex,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPoint: { ...points[activeIndex] },
        startPoints: clonePoints(points),
        startRotation: rotationDegrees,
        moved: false,
      };
      return;
    }

    if (pointIndex >= 0) {
      onSelectPoint(pointIndex);
      return;
    }

    dragRef.current = {
      kind: 'rotate-candidate',
      canvas: 'perpendicular',
      pointIndex: -1,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: null,
      startPoints: clonePoints(points),
      startRotation: rotationDegrees,
      moved: false,
    };
  }

  function handlePerpendicularClick(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (suppressClickRef.current === 'perpendicular') {
      suppressClickRef.current = null;
      return;
    }

    if (activeIndex < 0 || points.length === 0) {
      return;
    }

    const target = canvasPointFromMouse(event);
    const layout = buildPerpendicularLayout(
      points,
      cursorDistanceMm,
      rotationDegrees,
      event.currentTarget.clientWidth,
      event.currentTarget.clientHeight
    );
    const pointIndex = hitPoint(layout.pixels, target);
    if (pointIndex >= 0) {
      onSelectPoint(pointIndex);
      onStatusChange?.(`${record.label}: centered control point ${pointIndex + 1}.`);
    }
  }

  function handlePerpendicularWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    if (points.length === 0) {
      return;
    }
    if (editContourMode && event.shiftKey) {
       event.preventDefault();
       setBrushRadiusMm(prev => Math.max(0.2, Math.min(10, prev + (event.deltaY > 0 ? -0.2 : 0.2))));
       return;
    }
    event.preventDefault();
    const baseIndex = activeIndex >= 0 ? activeIndex : points.length - 1;
    const nextIndex = clamp(baseIndex + (event.deltaY > 0 ? 1 : -1), 0, points.length - 1);
    onSelectPoint(nextIndex);
    onStatusChange?.(`${record.label}: perpendicular view centered on control point ${nextIndex + 1}.`);
  }

  function handlePerpendicularContextMenu(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (points.length === 0) {
      return;
    }
    event.preventDefault();
    onRequestPointMenu(-2, event.clientX, event.clientY);
  }

  if (!visible) {
    return null;
  }

  return (
    <div className="snake-floating-panel">
      <div className="snake-panel-header">
        <div>
          <div className="header-kicker">Edit Centerline Layout</div>
          <h3>{record.label} Snake View</h3>
        </div>
        <div className="snake-panel-actions">
          <select value={viewMode} onChange={(event) => setViewMode(event.target.value as SnakeViewMode)} className="ghost-btn">
            <option value="curved">Curved View</option>
            <option value="stretched">Stretched View</option>
            <option value="calcifications">Calcifications View</option>
          </select>
          <button className="ghost-btn" onClick={() => onRotationChange(0)}>
            Reset Rotation
          </button>
          <button className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <canvas
        ref={snakeCanvasRef}
        className="snake-canvas"
        style={{ height: `${SNAKE_CANVAS_HEIGHT}px` }}
        onMouseDown={handleSnakeMouseDown}
        onClick={handleSnakeClick}
        onWheel={handleSnakeWheel}
        onContextMenu={handleSnakeContextMenu}
      />

      <div className="snake-footer">
        <canvas
          ref={perpendicularCanvasRef}
          className="perpendicular-canvas"
          style={{ width: `${PERPENDICULAR_CANVAS_SIZE}px`, height: `${PERPENDICULAR_CANVAS_SIZE}px`, cursor: editContourMode ? 'none' : 'crosshair' }}
          onMouseDown={handlePerpendicularMouseDown}
          onMouseMove={handlePerpendicularMouseMove}
          onClick={handlePerpendicularClick}
          onWheel={handlePerpendicularWheel}
          onContextMenu={handlePerpendicularContextMenu}
        />

        <div className="snake-hints">
          <div className="metric-row">
            <span>Selected point</span>
            <strong>{activeIndex >= 0 ? `#${activeIndex + 1}` : '—'}</strong>
          </div>
          <div className="metric-row">
            <span>Rotation</span>
            <strong>{rotationDegrees.toFixed(0)}°</strong>
          </div>
          <p className="mini-copy">
            Drag background to rotate the layout. Drag the selected point in the perpendicular view for fine
            positioning.
          </p>
        </div>
      </div>
    </div>
  );
}
