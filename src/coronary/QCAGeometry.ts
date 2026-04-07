import type {
  CoronaryVesselRecord,
  DerivedQCAMetrics,
  ManualQCAInput,
  WorldPoint3D,
  LumenContour,
  ClinicalMarkers,
  PlaqueMetrics
} from './QCATypes';

// Standardized Plaque HU Thresholds (e.g., SCCT Guidelines)
export const HU_THRESHOLD_LAP = 30;       // < 30 Low Attenuation
export const HU_THRESHOLD_FB_FATTY = 130;  // 30 - 130 Fibrofatty
export const HU_THRESHOLD_FIBROUS = 350;   // 130 - 350 Fibrous
export const HU_THRESHOLD_CALCIFIED = 350; // > 350 Calcified

export interface PlaqueComposition {
  lap: number;       // Volume/Area fraction < 30
  fibrofatty: number; // 30 - 130
  fibrous: number;   // 130 - 350
  calcified: number; // > 350
  total: number;     // Total plaque Area/Volume
}

export type Vec3 = [number, number, number];

export interface Frame3D {
  tangent: Vec3;
  lateral: Vec3;
  perpendicular: Vec3;
}

export function pointDistance(lhs: WorldPoint3D, rhs: WorldPoint3D): number {
  return Math.hypot(lhs.x - rhs.x, lhs.y - rhs.y, lhs.z - rhs.z);
}

export function polylineLength(points: WorldPoint3D[]): number {
  if (points.length < 2) {
    return 0;
  }

  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += pointDistance(points[i - 1], points[i]);
  }
  return total;
}

function nearestPointIndex(points: WorldPoint3D[], target: WorldPoint3D): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < points.length; i += 1) {
    const distance = pointDistance(points[i], target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

export function toVec(point: WorldPoint3D): Vec3 {
  return [point.x, point.y, point.z];
}

export function toPoint(vector: Vec3): WorldPoint3D {
  return { x: vector[0], y: vector[1], z: vector[2] };
}

export function add(lhs: Vec3, rhs: Vec3): Vec3 {
  return [lhs[0] + rhs[0], lhs[1] + rhs[1], lhs[2] + rhs[2]];
}

export function subtract(lhs: Vec3, rhs: Vec3): Vec3 {
  return [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]];
}

export function scale(vector: Vec3, factor: number): Vec3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

export function magnitude(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

export function normalize(vector: Vec3): Vec3 {
  const length = magnitude(vector);
  if (length === 0) return [0, 0, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function dot(lhs: Vec3, rhs: Vec3): number {
  return lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2];
}

export function cross(lhs: Vec3, rhs: Vec3): Vec3 {
  return [
    lhs[1] * rhs[2] - lhs[2] * rhs[1],
    lhs[2] * rhs[0] - lhs[0] * rhs[2],
    lhs[0] * rhs[1] - lhs[1] * rhs[0],
  ];
}

export function rotateAroundAxis(vector: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const unitAxis = normalize(axis);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const d = dot(vector, unitAxis);
  const cx = cross(unitAxis, vector);
  return [
    vector[0] * cos + cx[0] * sin + unitAxis[0] * d * (1 - cos),
    vector[1] * cos + cx[1] * sin + unitAxis[1] * d * (1 - cos),
    vector[2] * cos + cx[2] * sin + unitAxis[2] * d * (1 - cos),
  ];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerpPoint(lhs: WorldPoint3D, rhs: WorldPoint3D, t: number): WorldPoint3D {
  return {
    x: lhs.x + (rhs.x - lhs.x) * t,
    y: lhs.y + (rhs.y - lhs.y) * t,
    z: lhs.z + (rhs.z - lhs.z) * t,
  };
}

export function pointAtDist(points: WorldPoint3D[], distanceMm: number): WorldPoint3D {
  if (points.length === 0) return { x: 0, y: 0, z: 0 };
  if (distanceMm <= 0) return points[0];
  
  let current = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const d = pointDistance(points[i], points[i + 1]);
    if (current + d >= distanceMm) {
      const t = (distanceMm - current) / d;
      return lerpPoint(points[i], points[i + 1], t);
    }
    current += d;
  }
  return points[points.length - 1];
}

export function frameAtDist(points: WorldPoint3D[], distanceMm: number, rotationDegrees: number = 0): Frame3D {
  if (points.length < 2) {
    return { tangent: [0, 0, 1], lateral: [1, 0, 0], perpendicular: [0, 1, 0] };
  }
  
  const p1 = pointAtDist(points, distanceMm);
  const p2 = pointAtDist(points, distanceMm + 0.1);
  const tangent = normalize(subtract(toVec(p2), toVec(p1)));
  
  let up: Vec3 = [0, 1, 0];
  if (Math.abs(dot(tangent, up)) > 0.9) {
    up = [1, 0, 0];
  }
  
  const lateral = normalize(cross(up, tangent));
  const perpendicular = normalize(cross(tangent, lateral));
  
  // Apply rotation
  const rad = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  const rotatedLateral: Vec3 = [
    lateral[0] * cos + perpendicular[0] * sin,
    lateral[1] * cos + perpendicular[1] * sin,
    lateral[2] * cos + perpendicular[2] * sin,
  ];
  const rotatedPerp: Vec3 = [
    perpendicular[0] * cos - lateral[0] * sin,
    perpendicular[1] * cos - lateral[1] * sin,
    perpendicular[2] * cos - lateral[2] * sin,
  ];
  
  return { tangent, lateral: rotatedLateral, perpendicular: rotatedPerp };
}

function polylineSegmentLength(points: WorldPoint3D[], lhs: number, rhs: number): number {
  const start = Math.min(lhs, rhs);
  const end = Math.max(lhs, rhs);

  if (start === end) {
    return 0;
  }

  let total = 0;
  for (let i = start + 1; i <= end; i += 1) {
    total += pointDistance(points[i - 1], points[i]);
  }
  return total;
}

export function lesionLengthFromRecord(record: CoronaryVesselRecord): number | null {
  if (!record.lesionStart || !record.lesionEnd) {
    return null;
  }

  if (record.centerlinePoints.length >= 2) {
    const startIndex = nearestPointIndex(record.centerlinePoints, record.lesionStart);
    const endIndex = nearestPointIndex(record.centerlinePoints, record.lesionEnd);
    const centerlineLength = polylineSegmentLength(record.centerlinePoints, startIndex, endIndex);
    if (centerlineLength > 0) {
      return centerlineLength;
    }
  }

  return pointDistance(record.lesionStart, record.lesionEnd);
}

export function referenceDiameterFromManual(manual: ManualQCAInput): number | null {
  const values = [manual.proximalReferenceDiameterMm, manual.distalReferenceDiameterMm].filter(
    (value): value is number => value != null && value > 0
  );

  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function diameterStenosisPercent(manual: ManualQCAInput): number | null {
  const referenceDiameter = referenceDiameterFromManual(manual);
  const minimalLumenDiameter = manual.minimalLumenDiameterMm;

  if (!referenceDiameter || !minimalLumenDiameter || referenceDiameter <= 0) {
    return null;
  }

  return Math.max(0, (1 - minimalLumenDiameter / referenceDiameter) * 100);
}

export function referenceAreaFromManual(manual: ManualQCAInput): number | null {
  const values = [manual.proximalReferenceAreaMm2, manual.distalReferenceAreaMm2].filter(
    (value): value is number => value != null && value > 0
  );

  if (values.length === 0) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function areaStenosisPercent(manual: ManualQCAInput): number | null {
  const referenceArea = referenceAreaFromManual(manual);
  const minimalLumenArea = manual.minimalLumenAreaMm2;

  if (!referenceArea || !minimalLumenArea || referenceArea <= 0) {
    return null;
  }

  return Math.max(0, (1 - minimalLumenArea / referenceArea) * 100);
}

export function stenosisSeverityLabel(stenosisPercent: number | null): string {
  if (stenosisPercent == null) {
    return 'Incomplete';
  }
  if (stenosisPercent < 25) {
    return 'Minimal';
  }
  if (stenosisPercent < 50) {
    return 'Mild';
  }
  if (stenosisPercent < 70) {
    return 'Moderate';
  }
  return 'Severe';
}

export function deriveQCAMetrics(record: CoronaryVesselRecord): DerivedQCAMetrics {
  const centerlineLengthMm =
    record.centerlinePoints.length >= 2 ? polylineLength(record.centerlinePoints) : null;
  const lesionLengthMm = lesionLengthFromRecord(record);
  const referenceDiameterMm = referenceDiameterFromManual(record.manual);
  const diameterPercent = diameterStenosisPercent(record.manual);
  const referenceAreaMm2 = referenceAreaFromManual(record.manual);
  const areaPercent = areaStenosisPercent(record.manual);
  const solverReady =
    record.centerlinePoints.length >= 3 &&
    lesionLengthMm != null &&
    referenceDiameterMm != null &&
    record.manual.minimalLumenDiameterMm != null &&
    (record.manual.meanAorticPressureMmHg ?? 0) > 0 &&
    (record.manual.myocardialMassG ?? 0) > 0;

  return {
    centerlineLengthMm,
    lesionLengthMm,
    referenceDiameterMm,
    diameterStenosisPercent: diameterPercent,
    referenceAreaMm2,
    areaStenosisPercent: areaPercent,
    severityLabel: stenosisSeverityLabel(diameterPercent),
    solverReady,
    plaque: calculatePlaqueMetricsFromContours(record),
    clinical: findClinicalMarkers(record.lumenContours, record.centerlinePoints),
  };
}

function calculatePlaqueMetricsFromContours(record: CoronaryVesselRecord) {
  const sorted = [...record.lumenContours]
    .filter((c) => c.vesselPoints && c.vesselPoints.length > 0)
    .sort((a, b) => a.distanceMm - b.distanceMm);

  if (sorted.length < 2) return undefined;

  const plaque: PlaqueMetrics = {
    totalVolumeMm3: 0,
    calcifiedVolumeMm3: 0,
    fibrousVolumeMm3: 0,
    fibrofattyVolumeMm3: 0,
    lapVolumeMm3: 0,
    plaqueBurdenPercent: 0,
    remodelingIndex: null,
  };

  let totalVesselVolume = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const c1 = sorted[i];
    const c2 = sorted[i + 1];
    const segmentLen = c2.distanceMm - c1.distanceMm;
    if (segmentLen <= 0) continue;

    // We don't have intensities here (they were sampled during contour creation/editing)
    // For now, we'll assume the areas are stored or we'll need to re-sample.
    // OPTIMIZATION: In a real app, we'd store the areas in the contour object.
    // For this prototype, we'll implement a placeholder that assumes 'points' vs 'vesselPoints' area.
    
    const area1 = contourArea(c1.points);
    const areaV1 = contourArea(c1.vesselPoints!);
    const area2 = contourArea(c2.points);
    const areaV2 = contourArea(c2.vesselPoints!);

    const segPlaqueVol = ((areaV1 - area1 + (areaV2 - area2)) / 2) * segmentLen;
    const segVesselVol = ((areaV1 + areaV2) / 2) * segmentLen;

    plaque.totalVolumeMm3 += segPlaqueVol;
    totalVesselVolume += segVesselVol;
    
    if (c1.composition && c2.composition) {
      plaque.lapVolumeMm3 += ((c1.composition.lapAreaMm2 + c2.composition.lapAreaMm2) / 2) * segmentLen;
      plaque.fibrofattyVolumeMm3 += ((c1.composition.fibrofattyAreaMm2 + c2.composition.fibrofattyAreaMm2) / 2) * segmentLen;
      plaque.fibrousVolumeMm3 += ((c1.composition.fibrousAreaMm2 + c2.composition.fibrousAreaMm2) / 2) * segmentLen;
      plaque.calcifiedVolumeMm3 += ((c1.composition.calcifiedAreaMm2 + c2.composition.calcifiedAreaMm2) / 2) * segmentLen;
    } else {
      // If no composition data, we can't estimate phenotype volumes
    }
  }

  if (totalVesselVolume > 0) {
    plaque.plaqueBurdenPercent = (plaque.totalVolumeMm3 / totalVesselVolume) * 100;
  }

  return plaque;
}

function contourArea(points: WorldPoint3D[]): number {
  if (points.length < 3) return 0;
  // 3D polygon area via cross-product summation (works for nearly-planar polygons)
  let cx = 0, cy = 0, cz = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    cx += a.y * b.z - a.z * b.y;
    cy += a.z * b.x - a.x * b.z;
    cz += a.x * b.y - a.y * b.x;
  }
  return 0.5 * Math.hypot(cx, cy, cz);
}

export function contourInnerOuterRadii(contour: LumenContour, center: WorldPoint3D): { inner: number; outer: number } {
  const rLSum = contour.points.reduce((s, p) => s + pointDistance(p, center), 0);
  const rLAvg = rLSum / contour.points.length;
  
  if (!contour.vesselPoints || contour.vesselPoints.length === 0) {
    return { inner: rLAvg, outer: rLAvg };
  }
  
  const rVSum = contour.vesselPoints.reduce((s, p) => s + pointDistance(p, center), 0);
  const rVAvg = rVSum / contour.vesselPoints.length;
  
  return { inner: rLAvg, outer: rVAvg };
}

function interpolateContourRadiiSorted(sorted: LumenContour[], centerline: WorldPoint3D[], distanceMm: number): { inner: number; outer: number } {
  if (sorted.length === 0) return { inner: 0, outer: 0 };

  if (distanceMm <= sorted[0].distanceMm) {
     return contourInnerOuterRadii(sorted[0], pointAtDist(centerline, sorted[0].distanceMm));
  }
  if (distanceMm >= sorted[sorted.length - 1].distanceMm) {
     return contourInnerOuterRadii(sorted[sorted.length - 1], pointAtDist(centerline, sorted[sorted.length - 1].distanceMm));
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const c1 = sorted[i];
    const c2 = sorted[i + 1];
    if (distanceMm >= c1.distanceMm && distanceMm <= c2.distanceMm) {
      const t = (distanceMm - c1.distanceMm) / (c2.distanceMm - c1.distanceMm);
      const r1 = contourInnerOuterRadii(c1, pointAtDist(centerline, c1.distanceMm));
      const r2 = contourInnerOuterRadii(c2, pointAtDist(centerline, c2.distanceMm));
      return {
        inner: r1.inner + (r2.inner - r1.inner) * t,
        outer: r1.outer + (r2.outer - r1.outer) * t,
      };
    }
  }

  return { inner: 0, outer: 0 };
}

export function interpolateContourRadii(contours: LumenContour[], centerline: WorldPoint3D[], distanceMm: number): { inner: number; outer: number } {
  const sorted = [...contours].sort((a, b) => a.distanceMm - b.distanceMm);
  return interpolateContourRadiiSorted(sorted, centerline, distanceMm);
}

export function findClinicalMarkers(contours: LumenContour[], centerline: WorldPoint3D[]): ClinicalMarkers {
  if (contours.length === 0) return { mldDistanceMm: 0, mldDiameterMm: 0 };

  const sorted = [...contours].sort((a, b) => a.distanceMm - b.distanceMm);
  let mldDist = sorted[0].distanceMm;
  let minD = Infinity;

  const totalLength = polylineLength(centerline);
  const StepMm = 0.5;

  for (let d = 0; d <= totalLength; d += StepMm) {
     const radii = interpolateContourRadiiSorted(sorted, centerline, d);
     const diam = radii.inner * 2;
     if (diam < minD) {
        minD = diam;
        mldDist = d;
     }
  }
  
  // Proximal Ref (5mm proximal to MLD, i.e. closer to ostium / smaller distance)
  const proximalRefDist = Math.max(0, mldDist - 5);
  const proximalRefRadii = interpolateContourRadiiSorted(sorted, centerline, proximalRefDist);

  // Distal Ref (5mm distal to MLD, i.e. further from ostium / larger distance)
  const distalRefDist = Math.min(totalLength, mldDist + 5);
  const distalRefRadii = interpolateContourRadiiSorted(sorted, centerline, distalRefDist);
  
  return {
     mldDistanceMm: mldDist,
     mldDiameterMm: minD,
     proximalReferenceDistanceMm: proximalRefDist,
     proximalReferenceDiameterMm: proximalRefRadii.inner * 2,
     distalReferenceDistanceMm: distalRefDist,
     distalReferenceDiameterMm: distalRefRadii.inner * 2
  };
}

export function generateCircularContour(center: WorldPoint3D, frame: Frame3D, radiusMm: number, segments: number = 32): WorldPoint3D[] {
  const points: WorldPoint3D[] = [];
  const c = toVec(center);
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const du = Math.cos(angle) * radiusMm;
    const dv = Math.sin(angle) * radiusMm;
    const p = add(add(c, scale(frame.lateral, du)), scale(frame.perpendicular, dv));
    points.push(toPoint(p));
  }
  return points;
}

export function applySphereBrush(
  points: WorldPoint3D[],
  center: WorldPoint3D,
  frame: Frame3D,
  brushCenterMm: [number, number],
  brushRadiusMm: number
): WorldPoint3D[] {
  const c = toVec(center);
  return points.map((p) => {
    const v = subtract(toVec(p), c);
    const u = v[0] * frame.lateral[0] + v[1] * frame.lateral[1] + v[2] * frame.lateral[2];
    const w = v[0] * frame.perpendicular[0] + v[1] * frame.perpendicular[1] + v[2] * frame.perpendicular[2];
    
    const du = u - brushCenterMm[0];
    const dw = w - brushCenterMm[1];
    const dist = Math.hypot(du, dw);
    
    if (dist < brushRadiusMm) {
      if (dist < 0.001) {
        // Move slightly if exactly at center
        const nu = brushCenterMm[0] + brushRadiusMm;
        const nw = brushCenterMm[1];
        const res = add(add(c, scale(frame.lateral, nu)), scale(frame.perpendicular, nw));
        return toPoint(res);
      }
      const t = brushRadiusMm / dist;
      const nu = brushCenterMm[0] + du * t;
      const nw = brushCenterMm[1] + dw * t;
      const res = add(add(c, scale(frame.lateral, nu)), scale(frame.perpendicular, nw));
      return toPoint(res);
    }
    return p;
  });
}

export function generateVesselWallContour(
  lumenPoints: WorldPoint3D[],
  center: WorldPoint3D,
  frame: Frame3D,
  offsetMm: number = 0.8
): WorldPoint3D[] {
  const c = toVec(center);
  return lumenPoints.map((p) => {
    const v = subtract(toVec(p), c);
    const u = v[0] * frame.lateral[0] + v[1] * frame.lateral[1] + v[2] * frame.lateral[2];
    const w = v[0] * frame.perpendicular[0] + v[1] * frame.perpendicular[1] + v[2] * frame.perpendicular[2];
    
    const dist = Math.hypot(u, w) || 0.001;
    const nu = u + (u / dist) * offsetMm;
    const nw = w + (w / dist) * offsetMm;
    
    const res = add(add(c, scale(frame.lateral, nu)), scale(frame.perpendicular, nw));
    return toPoint(res);
  });
}

export function samplePlaqueComposition(
  lumenPoints: WorldPoint3D[],
  vesselPoints: WorldPoint3D[],
  center: WorldPoint3D,
  frame: Frame3D,
  sampleIntensity: (world: Vec3) => number
): PlaqueComposition {
  const comp: PlaqueComposition = { lap: 0, fibrofatty: 0, fibrous: 0, calcified: 0, total: 0 };
  if (lumenPoints.length === 0 || vesselPoints.length === 0) {
    return comp;
  }
  
  const c = toVec(center);
  const angularSteps = lumenPoints.length;
  const radialSteps = 8;
  
  for (let i = 0; i < angularSteps; i++) {
    const pL = toVec(lumenPoints[i]);
    const pV = toVec(vesselPoints[i]);
    
    const vL = subtract(pL, c);
    const vV = subtract(pV, c);
    const rL = Math.hypot(vL[0], vL[1], vL[2]);
    const rV = Math.hypot(vV[0], vV[1], vV[2]);
    
    if (rV <= rL) continue;

    for (let r = 0; r < radialSteps; r++) {
      const t = (r + 0.5) / radialSteps;
      const world = add(scale(pL, 1 - t), scale(pV, t));
      const intensity = sampleIntensity(world);
      
      const thickness = rV - rL;
      const stepRadius = rL + thickness * t;
      const arcLength = (Math.PI * 2 * stepRadius) / angularSteps;
      const area = arcLength * (thickness / radialSteps);
      
      if (intensity < HU_THRESHOLD_LAP) comp.lap += area;
      else if (intensity < HU_THRESHOLD_FB_FATTY) comp.fibrofatty += area;
      else if (intensity < HU_THRESHOLD_FIBROUS) comp.fibrous += area;
      else comp.calcified += area;
      
      comp.total += area;
    }
  }
  
  return comp;
}
