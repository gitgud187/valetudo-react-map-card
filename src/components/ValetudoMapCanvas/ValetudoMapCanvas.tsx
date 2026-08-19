/* eslint-disable react-hooks/refs */
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import type { RawMapData, RawMapLayer } from '../../utils/ValetudoRawMapData';
import type { CleaningMode, Zone } from '../../types/homeassistant';
import type { RestrictionsState, VirtualWall, RestrictedZone } from '../../types/valetudo';
import { useTranslation } from '../../hooks/useTranslation';
import type { SupportedLanguage } from '../../i18n/locales';
import './ValetudoMapCanvas.scss';

// Segment color palette (4-color theorem friendly)
const SEGMENT_COLORS = [
  'rgba(90,  155, 212, 0.85)',
  'rgba(120, 195, 130, 0.85)',
  'rgba(255, 190,  80, 0.85)',
  'rgba(220, 100, 100, 0.85)',
  'rgba(170, 120, 210, 0.85)',
  'rgba( 80, 185, 185, 0.85)',
];

const FLOOR_COLOR = 'rgba(120, 164, 193, 0.6)';
const WALL_COLOR = 'rgba( 50,  50,  50, 1)';
const PATH_COLOR = 'rgba(255, 255, 255, 0.85)';
const CHARGER_COLOR = '#4CAF50';
const ROBOT_COLOR = '#2196F3';
const SCALE = 3; // px per map pixel

/** Supported map rotations in degrees (clockwise). */
export type MapRotate = 0 | 90 | 180 | 270;

/**
 * Inverse of the map_rotate bitmap transform: rotated-canvas px → content px.
 * w/h are the ORIGINAL (unrotated) content size in canvas logical px.
 */
function unrotatePoint(x: number, y: number, w: number, h: number, rot: MapRotate): { x: number; y: number } {
  switch (rot) {
    case 90:
      return { x: y, y: h - x };
    case 180:
      return { x: w - x, y: h - y };
    case 270:
      return { x: w - y, y: x };
    default:
      return { x, y };
  }
}

function getBoundingBox(mapData: RawMapData) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const layer of mapData.layers) {
    for (let i = 0; i < layer.pixels.length; i += 2) {
      const x = layer.pixels[i];
      const y = layer.pixels[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  // Fallback to map size
  if (minX === Infinity) {
    minX = 0;
    minY = 0;
    maxX = mapData.size.x;
    maxY = mapData.size.y;
  }

  return { minX, minY, maxX, maxY };
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: RawMapLayer, color: string, offsetX: number, offsetY: number) {
  ctx.fillStyle = color;
  for (let i = 0; i < layer.pixels.length; i += 2) {
    ctx.fillRect((layer.pixels[i] - offsetX) * SCALE, (layer.pixels[i + 1] - offsetY) * SCALE, SCALE, SCALE);
  }
}

function assignSegmentColors(layers: RawMapLayer[]): Map<string, string> {
  const map = new Map<string, string>();
  let idx = 0;
  for (const layer of layers) {
    if (layer.type === 'segment' && layer.metaData.segmentId) {
      if (!map.has(layer.metaData.segmentId)) {
        map.set(layer.metaData.segmentId, SEGMENT_COLORS[idx % SEGMENT_COLORS.length]);
        idx++;
      }
    }
  }
  return map;
}

interface ValetudoMapCanvasProps {
  mapData: RawMapData;
  mode?: CleaningMode;
  selectedRooms?: Map<number, string>;
  zone?: Zone | null;
  onZoneChange?: (zone: Zone | null) => void;
  onSegmentClick?: (segmentId: number) => void;
  // Restrictions editing
  restrictions?: RestrictionsState;
  /** Optimistic display after save: show saved walls/zones while mapData is still stale */
  displayRestrictions?: { walls: VirtualWall[]; zones: RestrictedZone[] } | null;
  onRestrictionDrawn?: (type: 'wall' | 'zone', p1: { x: number; y: number }, p2: { x: number; y: number }) => void;
  onRestrictionSelect?: (id: string | null) => void;
  // Iterations cycling
  iterations?: number;
  onIterationsChange?: (value: number) => void;
  language?: SupportedLanguage;
  /** Visual size multipliers (default 1.0) */
  robotSize?: number;
  chargerSize?: number;
  pathWidth?: number;
  /** Max display height of the map canvas in px (aspect preserved). Default: unset (fill width). */
  mapMaxHeight?: number;
  /** Rotate the rendered map clockwise by 0/90/180/270 degrees. Default: 0. */
  mapRotate?: MapRotate;
}

// Stored state for coordinate conversion (filled during render)
interface MapGeometry {
  bb: { minX: number; minY: number; maxX: number; maxY: number };
  pixelSize: number;
}

export function ValetudoMapCanvas({
  mapData,
  mode,
  selectedRooms,
  zone,
  onZoneChange,
  onSegmentClick,
  restrictions,
  displayRestrictions,
  onRestrictionDrawn,
  onRestrictionSelect,
  iterations = 1,
  onIterationsChange,
  language,
  robotSize = 1,
  chargerSize = 1,
  pathWidth = 1,
  mapMaxHeight,
  mapRotate = 0,
}: ValetudoMapCanvasProps) {
  const { t } = useTranslation(language);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const geoRef = useRef<MapGeometry>({
    bb: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    pixelSize: 50,
  });
  const segLookupRef = useRef<Map<string, number>>(new Map());

  // ─── Zoom/Pan state ────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // pinch tracking
  const lastPinchDist = useRef<number | null>(null);
  const lastPanPos = useRef<{ x: number; y: number } | null>(null);
  const isPanning = useRef(false);
  // track active pointer ids for multi-touch detection
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());

  // ─── Zone drag state (desktop: drag-to-draw) ───────────────────────────────
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);

  // ─── Widget zone state (mobile: movable rectangle) ────────────────────────
  // widgetZone: position/size in canvas px coords (before scale)
  const [widgetZone, setWidgetZone] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const widgetDragRef = useRef<{
    mode: 'move' | 'resize';
    startPtr: { x: number; y: number };
    startZone: { x: number; y: number; w: number; h: number };
  } | null>(null);

  // ─── Mobile pending restriction widget (tap-to-place) ─────────────────────
  // Wall: two independent draggable endpoints; Zone: movable/resizable rect
  const [pendingRestriction, setPendingRestriction] = useState<
    | { kind: 'wall'; pA: { x: number; y: number }; pB: { x: number; y: number } }
    | { kind: 'zone'; x: number; y: number; w: number; h: number; type: 'no_go' | 'no_mop' }
    | null
  >(null);
  const pendingDragRef = useRef<{
    mode: 'move' | 'resize';
    startPtr: { x: number; y: number };
    startItem: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const wallEndpointDragRef = useRef<{
    endpoint: 'pA' | 'pB';
    startPtr: { x: number; y: number };
    startPoint: { x: number; y: number };
  } | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);

  const isTouchDevice = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);

  const canvasToMm = useCallback(
    (cx: number, cy: number): { x: number; y: number } => {
      const { bb, pixelSize } = geoRef.current;
      const w = (bb.maxX - bb.minX + 2) * SCALE;
      const h = (bb.maxY - bb.minY + 2) * SCALE;
      const p = unrotatePoint(cx, cy, w, h, mapRotate);
      return {
        x: (p.x / SCALE + bb.minX) * pixelSize,
        y: (p.y / SCALE + bb.minY) * pixelSize,
      };
    },
    [mapRotate]
  );

  const mmToCanvas = useCallback((mmX: number, mmY: number): { x: number; y: number } => {
    const { bb, pixelSize } = geoRef.current;
    return {
      x: (mmX / pixelSize - bb.minX) * SCALE,
      y: (mmY / pixelSize - bb.minY) * SCALE,
    };
  }, []);

  // Convert screen point → canvas pixel (accounting for zoom/pan/css scale)
  const screenToCanvas = useCallback(
    (screenX: number, screenY: number): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      // Transformed rect includes zoom+pan (translate(pan) scale(zoom), origin center)
      const rect = canvas.getBoundingClientRect();
      // Untransformed CSS size
      const cssW = rect.width / zoom;
      const cssH = rect.height / zoom;
      // Untransformed element top-left: rect.left = left + cssW/2*(1-zoom) + pan.x
      const left = rect.left - pan.x - (cssW * (1 - zoom)) / 2;
      const top = rect.top - pan.y - (cssH * (1 - zoom)) / 2;
      // canvas CSS px → canvas logical px ratio
      return {
        x: (screenX - left) * (canvas.width / cssW),
        y: (screenY - top) * (canvas.height / cssH),
      };
    },
    [zoom, pan]
  );

  // Reset zoom/pan when mode changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setWidgetZone(null);
    setPendingRestriction(null);
    tapStartRef.current = null;
  }, [mode]);

  // Clear pending restriction when restriction tool changes
  useEffect(() => {
    setPendingRestriction(null);
    tapStartRef.current = null;
  }, [restrictions?.tool]);

  // When zone mode is activated on touch device, place a default widget zone
  useEffect(() => {
    if (mode === 'zone' && isTouchDevice) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Place zone at center, 30% of canvas size
      const w = canvas.width * 0.3;
      const h = canvas.height * 0.3;
      const x = (canvas.width - w) / 2;
      const y = (canvas.height - h) / 2;
      setWidgetZone({ x, y, w, h });
    } else {
      setWidgetZone(null);
    }
  }, [mode, isTouchDevice]);

  // Sync widget zone → mm zone whenever widget changes
  useEffect(() => {
    if (widgetZone === null) return;
    const mm1 = canvasToMm(widgetZone.x, widgetZone.y);
    const mm2 = canvasToMm(widgetZone.x + widgetZone.w, widgetZone.y + widgetZone.h);
    onZoneChange?.({
      x1: Math.round(Math.min(mm1.x, mm2.x)),
      y1: Math.round(Math.min(mm1.y, mm2.y)),
      x2: Math.round(Math.max(mm1.x, mm2.x)),
      y2: Math.round(Math.max(mm1.y, mm2.y)),
    });
  }, [widgetZone, canvasToMm, onZoneChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const bb = getBoundingBox(mapData);
    const pixelSize = mapData.pixelSize || 50;
    geoRef.current = { bb, pixelSize };

    const lookup = new Map<string, number>();
    for (const layer of mapData.layers) {
      if (layer.type === 'segment' && layer.metaData.segmentId) {
        const sid = parseInt(layer.metaData.segmentId, 10);
        for (let i = 0; i < layer.pixels.length; i += 2) {
          lookup.set(`${layer.pixels[i]},${layer.pixels[i + 1]}`, sid);
        }
      }
    }
    segLookupRef.current = lookup;

    const w = (bb.maxX - bb.minX + 2) * SCALE;
    const h = (bb.maxY - bb.minY + 2) * SCALE;
    // Rotate the bitmap: canvas dims follow the rotation (90/270 swap aspect)
    const nw = mapRotate === 90 || mapRotate === 270 ? h : w;
    const nh = mapRotate === 90 || mapRotate === 270 ? w : h;

    canvas.width = nw;
    canvas.height = nh;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, nw, nh);

    // Draw the whole map in content space, rotated into the canvas.
    ctx.save();
    if (mapRotate === 90) {
      ctx.translate(h, 0);
      ctx.rotate(Math.PI / 2);
    } else if (mapRotate === 180) {
      ctx.translate(w, h);
      ctx.rotate(Math.PI);
    } else if (mapRotate === 270) {
      ctx.translate(0, w);
      ctx.rotate(-Math.PI / 2);
    }

    const segColors = assignSegmentColors(mapData.layers);
    const segIdToNumber = (sid: string): number => parseInt(sid, 10);

    for (const layer of mapData.layers) {
      if (layer.type === 'floor') drawLayer(ctx, layer, FLOOR_COLOR, bb.minX, bb.minY);
    }
    for (const layer of mapData.layers) {
      if (layer.type === 'segment') {
        const sid = layer.metaData.segmentId;
        const baseColor = sid ? (segColors.get(sid) ?? FLOOR_COLOR) : FLOOR_COLOR;
        const isSelected =
          sid && selectedRooms && selectedRooms.size > 0 ? selectedRooms.has(segIdToNumber(sid)) : true;
        const color = isSelected ? baseColor : baseColor.replace(/[\d.]+\)$/, '0.35)');
        drawLayer(ctx, layer, color, bb.minX, bb.minY);
      }
    }
    for (const layer of mapData.layers) {
      if (layer.type === 'wall') drawLayer(ctx, layer, WALL_COLOR, bb.minX, bb.minY);
    }

    for (const entity of mapData.entities) {
      if (entity.type !== 'path' && entity.type !== 'predicted_path') continue;
      ctx.beginPath();
      ctx.strokeStyle = entity.type === 'predicted_path' ? 'rgba(255,255,255,0.4)' : PATH_COLOR;
      ctx.lineWidth = SCALE * 0.75 * pathWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash(entity.type === 'predicted_path' ? [4, 3] : []);
      for (let i = 0; i < entity.points.length; i += 2) {
        const x = (entity.points[i] / pixelSize - bb.minX) * SCALE;
        const y = (entity.points[i + 1] / pixelSize - bb.minY) * SCALE;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
      ctx.setLineDash([]);
    }

    for (const entity of mapData.entities) {
      if (entity.type !== 'charger_location' || entity.points.length < 2) continue;
      const cx = (entity.points[0] / pixelSize - bb.minX) * SCALE;
      const cy = (entity.points[1] / pixelSize - bb.minY) * SCALE;
      const r = SCALE * 3.4 * chargerSize;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = SCALE * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.fillStyle = CHARGER_COLOR;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = SCALE * 0.7;
      ctx.stroke();
      // lightning bolt symbol
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.15, cy - r * 0.65);
      ctx.lineTo(cx - r * 0.2, cy + r * 0.05);
      ctx.lineTo(cx + r * 0.05, cy + r * 0.05);
      ctx.lineTo(cx - r * 0.15, cy + r * 0.65);
      ctx.lineTo(cx + r * 0.2, cy - r * 0.05);
      ctx.lineTo(cx - r * 0.05, cy - r * 0.05);
      ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();
    }

    for (const entity of mapData.entities) {
      if (entity.type !== 'robot_position' || entity.points.length < 2) continue;
      const rx = (entity.points[0] / pixelSize - bb.minX) * SCALE;
      const ry = (entity.points[1] / pixelSize - bb.minY) * SCALE;
      const angle = (entity.metaData.angle ?? 0) * (Math.PI / 180);
      const r = SCALE * 3 * robotSize;
      ctx.save();
      ctx.translate(rx, ry);
      ctx.rotate(angle);
      // drop shadow
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = SCALE * 4;
      // body
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, 2 * Math.PI);
      ctx.fillStyle = ROBOT_COLOR;
      ctx.fill();
      // white ring
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = SCALE * 0.9;
      ctx.stroke();
      // direction chevron
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.62); // tip
      ctx.lineTo(r * 0.38, r * 0.42); // bottom-right
      ctx.lineTo(0, r * 0.18); // centre notch
      ctx.lineTo(-r * 0.38, r * 0.42); // bottom-left
      ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();
    }

    // Draw active_zone entities from map data (zones currently being cleaned)
    for (const entity of mapData.entities) {
      if (entity.type !== 'active_zone' || entity.points.length < 8) continue;
      // points: [x0,y0, x1,y1, x2,y2, x3,y3] in mm
      ctx.beginPath();
      for (let i = 0; i < entity.points.length; i += 2) {
        const px = (entity.points[i] / pixelSize - bb.minX) * SCALE;
        const py = (entity.points[i + 1] / pixelSize - bb.minY) * SCALE;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 152, 0, 0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 152, 0, 0.9)';
      ctx.lineWidth = SCALE;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (zone && !isTouchDevice) {
      const zc1 = mmToCanvas(zone.x1, zone.y1);
      const zc2 = mmToCanvas(zone.x2, zone.y2);
      const zx = Math.min(zc1.x, zc2.x);
      const zy = Math.min(zc1.y, zc2.y);
      const zw = Math.abs(zc2.x - zc1.x);
      const zh = Math.abs(zc2.y - zc1.y);
      ctx.fillStyle = 'rgba(255, 152, 0, 0.25)';
      ctx.fillRect(zx, zy, zw, zh);
      ctx.strokeStyle = 'rgba(255, 152, 0, 0.9)';
      ctx.lineWidth = SCALE;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(zx, zy, zw, zh);
      ctx.setLineDash([]);
    }

    // ─── Virtual restrictions ─────────────────────────────────────────────────
    // Use displayRestrictions (optimistic) if available so that saved walls are
    // visible while mapData is still stale after save.  Fall back to mapData.entities.
    if (displayRestrictions) {
      const toC = (mmX: number, mmY: number) => ({
        x: (mmX / pixelSize - bb.minX) * SCALE,
        y: (mmY / pixelSize - bb.minY) * SCALE,
      });
      for (const w of displayRestrictions.walls) {
        const p1 = toC(w.pA.x, w.pA.y);
        const p2 = toC(w.pB.x, w.pB.y);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = 'rgba(244, 67, 54, 0.6)';
        ctx.lineWidth = SCALE * 1.2;
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
      for (const z of displayRestrictions.zones) {
        const pts = [z.pA, z.pB, z.pC, z.pD].map((p) => toC(p.x, p.y));
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        const isMop = z.type === 'mop';
        ctx.fillStyle = isMop ? 'rgba(33,150,243,0.1)' : 'rgba(244,67,54,0.1)';
        ctx.fill();
        ctx.strokeStyle = isMop ? 'rgba(33,150,243,0.5)' : 'rgba(244,67,54,0.5)';
        ctx.lineWidth = SCALE;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (mode !== 'restrictions') {
      // draw server-side restrictions at reduced opacity in non-edit modes
      for (const entity of mapData.entities) {
        if (entity.type === 'virtual_wall' && entity.points.length >= 4) {
          const x1 = (entity.points[0] / pixelSize - bb.minX) * SCALE;
          const y1 = (entity.points[1] / pixelSize - bb.minY) * SCALE;
          const x2 = (entity.points[2] / pixelSize - bb.minX) * SCALE;
          const y2 = (entity.points[3] / pixelSize - bb.minY) * SCALE;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.strokeStyle = 'rgba(244, 67, 54, 0.6)';
          ctx.lineWidth = SCALE * 1.2;
          ctx.setLineDash([]);
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.lineCap = 'butt';
        }
        if ((entity.type === 'no_go_area' || entity.type === 'no_mop_area') && entity.points.length >= 8) {
          const isMop = entity.type === 'no_mop_area';
          const fillColor = isMop ? 'rgba(33, 150, 243, 0.1)' : 'rgba(244, 67, 54, 0.1)';
          const strokeColor = isMop ? 'rgba(33, 150, 243, 0.5)' : 'rgba(244, 67, 54, 0.5)';
          ctx.beginPath();
          for (let i = 0; i < entity.points.length; i += 2) {
            const px = (entity.points[i] / pixelSize - bb.minX) * SCALE;
            const py = (entity.points[i + 1] / pixelSize - bb.minY) * SCALE;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = fillColor;
          ctx.fill();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = SCALE;
          ctx.setLineDash([5, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
    // ─── Restrictions editor overlay ──────────────────────────────────────────
    // Drawn here (inside the main effect) so every canvas clear re-draws the
    // current local state. Adding `restrictions` to deps ensures the canvas
    // also redraws whenever items are added, deleted, or selected.
    if (mode === 'restrictions' && restrictions) {
      const { bb: rBB, pixelSize: rPixelSize } = geoRef.current;
      const toC = (mmX: number, mmY: number) => ({
        x: (mmX / rPixelSize - rBB.minX) * SCALE,
        y: (mmY / rPixelSize - rBB.minY) * SCALE,
      });

      const drawWall = (w: VirtualWall, selected: boolean) => {
        const p1 = toC(w.pA.x, w.pA.y);
        const p2 = toC(w.pB.x, w.pB.y);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.strokeStyle = selected ? '#ff9800' : 'rgba(244,67,54,1)';
        ctx.lineWidth = selected ? SCALE * 3 : SCALE * 2;
        ctx.setLineDash([]);
        ctx.lineCap = 'round';
        ctx.stroke();
        ctx.lineCap = 'butt';
        for (const p of [p1, p2]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, selected ? SCALE * 2.5 : SCALE * 1.5, 0, 2 * Math.PI);
          ctx.fillStyle = selected ? '#ff9800' : 'rgba(244,67,54,0.9)';
          ctx.fill();
        }
      };

      const drawZone = (z: RestrictedZone, selected: boolean) => {
        const pts = [z.pA, z.pB, z.pC, z.pD].map((p) => toC(p.x, p.y));
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        const isMop = z.type === 'mop';
        if (selected) {
          ctx.fillStyle = 'rgba(255,152,0,0.25)';
          ctx.strokeStyle = '#ff9800';
        } else {
          ctx.fillStyle = isMop ? 'rgba(33,150,243,0.2)' : 'rgba(244,67,54,0.2)';
          ctx.strokeStyle = isMop ? 'rgba(33,150,243,0.9)' : 'rgba(244,67,54,0.9)';
        }
        ctx.fill();
        ctx.lineWidth = selected ? SCALE * 2 : SCALE * 1.5;
        ctx.setLineDash([5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      for (const w of restrictions.walls) drawWall(w, w.id === restrictions.selectedId);
      for (const z of restrictions.zones) drawZone(z, z.id === restrictions.selectedId);
    }
    ctx.restore();
  }, [
    mapData,
    selectedRooms,
    zone,
    mode,
    mmToCanvas,
    isTouchDevice,
    displayRestrictions,
    restrictions,
    robotSize,
    chargerSize,
    pathWidth,
    mapRotate,
  ]);

  // Restrictions overlay is now drawn inside the main canvas effect above.

  // ─── Zoom: wheel ────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom((prev) => {
        const nz = Math.min(8, Math.max(1, prev * delta));
        if (nz <= 1) setPan({ x: 0, y: 0 });
        return nz;
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // ─── Pointer events: pan + zone drawing ────────────────────────────────────
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.current.size === 2) {
        // Two fingers → pinch zoom, cancel any pan/drag
        isDragging.current = false;
        isPanning.current = false;
        setDragStart(null);
        setDragCurrent(null);
        return;
      }

      e.currentTarget.setPointerCapture(e.pointerId);

      if (mode === 'zone' && !isTouchDevice) {
        // Desktop drag-to-draw
        isDragging.current = true;
        const pt = screenToCanvas(e.clientX, e.clientY);
        setDragStart(pt);
        setDragCurrent(pt);
        onZoneChange?.(null);
        return;
      }

      if (mode === 'restrictions' && restrictions) {
        if (!isTouchDevice) {
          // Desktop: drag-to-draw
          const tool = restrictions.tool;
          if (tool === 'wall' || tool === 'no_go' || tool === 'no_mop') {
            isDragging.current = true;
            const pt = screenToCanvas(e.clientX, e.clientY);
            setDragStart(pt);
            setDragCurrent(pt);
            return;
          }
          // select tool — handled in click
          return;
        }
        // Mobile: record tap start for widget placement; panning handled below
        if (restrictions.tool !== 'select') {
          tapStartRef.current = { x: e.clientX, y: e.clientY };
        }
        // fall through to panning logic
      }

      if (zoom > 1) {
        // Pan
        isPanning.current = true;
        lastPanPos.current = { x: e.clientX, y: e.clientY };
      }
    },
    [mode, isTouchDevice, zoom, screenToCanvas, onZoneChange, restrictions]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Pinch zoom
      if (activePointers.current.size === 2) {
        const pts = Array.from(activePointers.current.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (lastPinchDist.current !== null) {
          const delta = dist / lastPinchDist.current;
          setZoom((z) => Math.min(8, Math.max(1, z * delta)));
        }
        lastPinchDist.current = dist;
        return;
      }
      lastPinchDist.current = null;

      if (isDragging.current && mode === 'zone' && !isTouchDevice) {
        setDragCurrent(screenToCanvas(e.clientX, e.clientY));
        return;
      }

      if (isDragging.current && mode === 'restrictions' && !isTouchDevice) {
        setDragCurrent(screenToCanvas(e.clientX, e.clientY));
        return;
      }

      if (isPanning.current && lastPanPos.current) {
        const dx = e.clientX - lastPanPos.current.x;
        const dy = e.clientY - lastPanPos.current.y;
        lastPanPos.current = { x: e.clientX, y: e.clientY };
        const container = containerRef.current;
        if (!container) return;
        const maxPan = ((zoom - 1) * container.getBoundingClientRect().width) / 2;
        setPan((p) => ({
          x: Math.max(-maxPan, Math.min(maxPan, p.x + dx)),
          y: Math.max(-maxPan, Math.min(maxPan, p.y + dy)),
        }));
      }
    },
    [mode, isTouchDevice, zoom, screenToCanvas]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      activePointers.current.delete(e.pointerId);
      lastPinchDist.current = null;

      if (isDragging.current && mode === 'zone' && !isTouchDevice) {
        isDragging.current = false;
        const end = screenToCanvas(e.clientX, e.clientY);
        if (dragStart && (Math.abs(end.x - dragStart.x) > 8 || Math.abs(end.y - dragStart.y) > 8)) {
          const mm1 = canvasToMm(dragStart.x, dragStart.y);
          const mm2 = canvasToMm(end.x, end.y);
          onZoneChange?.({
            x1: Math.round(Math.min(mm1.x, mm2.x)),
            y1: Math.round(Math.min(mm1.y, mm2.y)),
            x2: Math.round(Math.max(mm1.x, mm2.x)),
            y2: Math.round(Math.max(mm1.y, mm2.y)),
          });
        }
        setDragStart(null);
        setDragCurrent(null);
        return;
      }

      if (isDragging.current && mode === 'restrictions' && restrictions && !isTouchDevice) {
        isDragging.current = false;
        const end = screenToCanvas(e.clientX, e.clientY);
        if (dragStart && (Math.abs(end.x - dragStart.x) > 5 || Math.abs(end.y - dragStart.y) > 5)) {
          const mm1 = canvasToMm(dragStart.x, dragStart.y);
          const mm2 = canvasToMm(end.x, end.y);
          const p1 = { x: Math.round(mm1.x), y: Math.round(mm1.y) };
          const p2 = { x: Math.round(mm2.x), y: Math.round(mm2.y) };
          const drawType = restrictions.tool === 'wall' ? 'wall' : 'zone';
          onRestrictionDrawn?.(drawType, p1, p2);
        }
        setDragStart(null);
        setDragCurrent(null);
        return;
      }

      // Mobile: tap detection — place a pending restriction widget at tap location
      if (mode === 'restrictions' && restrictions && isTouchDevice && tapStartRef.current) {
        const start = tapStartRef.current;
        tapStartRef.current = null;
        if (
          Math.abs(e.clientX - start.x) < 10 &&
          Math.abs(e.clientY - start.y) < 10 &&
          restrictions.tool !== 'select'
        ) {
          const canvas = canvasRef.current;
          if (canvas) {
            const pt = screenToCanvas(e.clientX, e.clientY);
            if (restrictions.tool === 'wall') {
              // Place a horizontal line centred on the tap point
              const lineLen = canvas.width * 0.3;
              setPendingRestriction({
                kind: 'wall',
                pA: { x: Math.max(0, pt.x - lineLen / 2), y: pt.y },
                pB: { x: Math.min(canvas.width, pt.x + lineLen / 2), y: pt.y },
              });
            } else {
              const defaultW = canvas.width * 0.25;
              const defaultH = canvas.height * 0.15;
              setPendingRestriction({
                kind: 'zone',
                x: Math.max(0, Math.min(canvas.width - defaultW, pt.x - defaultW / 2)),
                y: Math.max(0, Math.min(canvas.height - defaultH, pt.y - defaultH / 2)),
                w: defaultW,
                h: defaultH,
                type: restrictions.tool as 'no_go' | 'no_mop',
              });
            }
          }
        }
      }

      isPanning.current = false;
      lastPanPos.current = null;
    },
    [mode, isTouchDevice, dragStart, screenToCanvas, canvasToMm, onZoneChange, restrictions, onRestrictionDrawn]
  );

  // Room click / restrictions select
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (mode === 'restrictions' && restrictions && restrictions.tool === 'select' && onRestrictionSelect) {
        const pt = screenToCanvas(e.clientX, e.clientY);
        const { bb, pixelSize } = geoRef.current;
        const cw = (bb.maxX - bb.minX + 2) * SCALE;
        const ch = (bb.maxY - bb.minY + 2) * SCALE;
        const up = unrotatePoint(pt.x, pt.y, cw, ch, mapRotate);
        const toC = (mmX: number, mmY: number) => ({
          x: (mmX / pixelSize - bb.minX) * SCALE,
          y: (mmY / pixelSize - bb.minY) * SCALE,
        });
        // Hit-test walls (within SCALE*4 px)
        const HIT_PX = SCALE * 5;
        for (const w of [...restrictions.walls].reverse()) {
          const p1 = toC(w.pA.x, w.pA.y);
          const p2 = toC(w.pB.x, w.pB.y);
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? ((up.x - p1.x) * dx + (up.y - p1.y) * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          const nearX = p1.x + t * dx;
          const nearY = p1.y + t * dy;
          if (Math.hypot(up.x - nearX, up.y - nearY) <= HIT_PX) {
            onRestrictionSelect(w.id);
            return;
          }
        }
        // Hit-test zones (point-in-rect)
        for (const z of [...restrictions.zones].reverse()) {
          const pts = [z.pA, z.pB, z.pC, z.pD].map((p) => toC(p.x, p.y));
          const minX = Math.min(...pts.map((p) => p.x));
          const maxX = Math.max(...pts.map((p) => p.x));
          const minY = Math.min(...pts.map((p) => p.y));
          const maxY = Math.max(...pts.map((p) => p.y));
          if (up.x >= minX - HIT_PX && up.x <= maxX + HIT_PX && up.y >= minY - HIT_PX && up.y <= maxY + HIT_PX) {
            onRestrictionSelect(z.id);
            return;
          }
        }
        onRestrictionSelect(null);
        return;
      }

      if (mode !== 'room' || !onSegmentClick) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pt = screenToCanvas(e.clientX, e.clientY);
      const { bb } = geoRef.current;
      const cw = (bb.maxX - bb.minX + 2) * SCALE;
      const ch = (bb.maxY - bb.minY + 2) * SCALE;
      const up = unrotatePoint(pt.x, pt.y, cw, ch, mapRotate);
      const mx = Math.floor(up.x / SCALE) + bb.minX;
      const my = Math.floor(up.y / SCALE) + bb.minY;
      const segId = segLookupRef.current.get(`${mx},${my}`);
      if (segId !== undefined) onSegmentClick(segId);
    },
    [mode, onSegmentClick, screenToCanvas, restrictions, onRestrictionSelect, mapRotate]
  );

  // ─── Widget zone drag handles ──────────────────────────────────────────────
  // widgetZone coords are in canvas logical px; on screen they appear scaled
  // The overlay is absolutely positioned over the canvas CSS area
  const widgetZoneStyle = useMemo(() => {
    if (!widgetZone || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    const canvasCssW = canvas.width; // we'll use % of canvas logical
    const canvasCssH = canvas.height;
    return {
      left: `${(widgetZone.x / canvasCssW) * 100}%`,
      top: `${(widgetZone.y / canvasCssH) * 100}%`,
      width: `${(widgetZone.w / canvasCssW) * 100}%`,
      height: `${(widgetZone.h / canvasCssH) * 100}%`,
    };
  }, [widgetZone]);

  const pendingZoneStyle = useMemo(() => {
    if (!pendingRestriction || pendingRestriction.kind !== 'zone' || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    return {
      left: `${(pendingRestriction.x / canvas.width) * 100}%`,
      top: `${(pendingRestriction.y / canvas.height) * 100}%`,
      width: `${(pendingRestriction.w / canvas.width) * 100}%`,
      height: `${(pendingRestriction.h / canvas.height) * 100}%`,
    };
  }, [pendingRestriction]);

  const pendingWallLayout = useMemo(() => {
    if (!pendingRestriction || pendingRestriction.kind !== 'wall' || !canvasRef.current) return null;
    const canvas = canvasRef.current;
    const { pA, pB } = pendingRestriction;
    const cw = canvas.width;
    const ch = canvas.height;
    const mx = (pA.x + pB.x) / 2;
    const my = (pA.y + pB.y) / 2;
    return {
      cw,
      ch,
      pAStyle: { left: `${(pA.x / cw) * 100}%`, top: `${(pA.y / ch) * 100}%` },
      pBStyle: { left: `${(pB.x / cw) * 100}%`, top: `${(pB.y / ch) * 100}%` },
      midStyle: { left: `${(mx / cw) * 100}%`, top: `${(my / ch) * 100}%` },
    };
  }, [pendingRestriction]);

  const handleWidgetPointerDown = useCallback(
    (dragMode: 'move' | 'resize', e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (!widgetZone) return;
      widgetDragRef.current = {
        mode: dragMode,
        startPtr: { x: e.clientX, y: e.clientY },
        startZone: { ...widgetZone },
      };
    },
    [widgetZone]
  );

  const handleWidgetPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!widgetDragRef.current || !canvasRef.current) return;
      e.stopPropagation();
      const { mode: dm, startPtr, startZone } = widgetDragRef.current;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!container) return;

      // screen delta → canvas px delta (accounting for zoom + canvas CSS scale)
      const rect = container.getBoundingClientRect();
      const cssToLogical = canvas.width / rect.width / zoom;
      const dx = (e.clientX - startPtr.x) * cssToLogical;
      const dy = (e.clientY - startPtr.y) * cssToLogical;

      setWidgetZone((prev) => {
        if (!prev) return prev;
        const cw = canvas.width;
        const ch = canvas.height;
        if (dm === 'move') {
          return {
            ...prev,
            x: Math.max(0, Math.min(cw - startZone.w, startZone.x + dx)),
            y: Math.max(0, Math.min(ch - startZone.h, startZone.y + dy)),
          };
        } else {
          // resize: bottom-right corner
          const minSize = 20;
          const newW = Math.max(minSize, Math.min(cw - startZone.x, startZone.w + dx));
          const newH = Math.max(minSize, Math.min(ch - startZone.y, startZone.h + dy));
          return { ...prev, w: newW, h: newH };
        }
      });
    },
    [zoom]
  );

  const handleWidgetPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    widgetDragRef.current = null;
  }, []);

  // ─── Pending restriction widget handlers ───────────────────────────────────
  const confirmPendingRestriction = useCallback(() => {
    if (!pendingRestriction || !onRestrictionDrawn) return;
    if (pendingRestriction.kind === 'wall') {
      const mmA = canvasToMm(pendingRestriction.pA.x, pendingRestriction.pA.y);
      const mmB = canvasToMm(pendingRestriction.pB.x, pendingRestriction.pB.y);
      onRestrictionDrawn(
        'wall',
        { x: Math.round(mmA.x), y: Math.round(mmA.y) },
        { x: Math.round(mmB.x), y: Math.round(mmB.y) }
      );
    } else {
      const mm1 = canvasToMm(pendingRestriction.x, pendingRestriction.y);
      const mm2 = canvasToMm(pendingRestriction.x + pendingRestriction.w, pendingRestriction.y + pendingRestriction.h);
      onRestrictionDrawn(
        'zone',
        { x: Math.round(mm1.x), y: Math.round(mm1.y) },
        { x: Math.round(mm2.x), y: Math.round(mm2.y) }
      );
    }
    setPendingRestriction(null);
  }, [pendingRestriction, canvasToMm, onRestrictionDrawn]);

  const handlePendingPointerDown = useCallback(
    (dragMode: 'move' | 'resize', e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (!pendingRestriction || pendingRestriction.kind !== 'zone') return;
      pendingDragRef.current = {
        mode: dragMode,
        startPtr: { x: e.clientX, y: e.clientY },
        startItem: {
          x: pendingRestriction.x,
          y: pendingRestriction.y,
          w: pendingRestriction.w,
          h: pendingRestriction.h,
        },
      };
    },
    [pendingRestriction]
  );

  const handlePendingPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pendingDragRef.current || !canvasRef.current) return;
      e.stopPropagation();
      const { mode: dm, startPtr, startItem } = pendingDragRef.current;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cssToLogical = canvas.width / rect.width / zoom;
      const dx = (e.clientX - startPtr.x) * cssToLogical;
      const dy = (e.clientY - startPtr.y) * cssToLogical;
      setPendingRestriction((prev) => {
        if (!prev || prev.kind !== 'zone') return prev;
        const cw = canvas.width;
        const ch = canvas.height;
        if (dm === 'move') {
          return {
            ...prev,
            x: Math.max(0, Math.min(cw - startItem.w, startItem.x + dx)),
            y: Math.max(0, Math.min(ch - startItem.h, startItem.y + dy)),
          };
        }
        const minSize = 20;
        return {
          ...prev,
          w: Math.max(minSize, Math.min(cw - startItem.x, startItem.w + dx)),
          h: Math.max(minSize, Math.min(ch - startItem.y, startItem.h + dy)),
        };
      });
    },
    [zoom]
  );

  const handlePendingPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    pendingDragRef.current = null;
  }, []);

  // ─── Wall endpoint drag handlers ──────────────────────────────────────────
  const handleWallEndpointPointerDown = useCallback(
    (endpoint: 'pA' | 'pB', e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (!pendingRestriction || pendingRestriction.kind !== 'wall') return;
      wallEndpointDragRef.current = {
        endpoint,
        startPtr: { x: e.clientX, y: e.clientY },
        startPoint: { ...pendingRestriction[endpoint] },
      };
    },
    [pendingRestriction]
  );

  const handleWallEndpointPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!wallEndpointDragRef.current || !canvasRef.current) return;
      e.stopPropagation();
      const { endpoint, startPtr, startPoint } = wallEndpointDragRef.current;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cssToLogical = canvas.width / rect.width / zoom;
      const dx = (e.clientX - startPtr.x) * cssToLogical;
      const dy = (e.clientY - startPtr.y) * cssToLogical;
      setPendingRestriction((prev) => {
        if (!prev || prev.kind !== 'wall') return prev;
        return {
          ...prev,
          [endpoint]: {
            x: Math.max(0, Math.min(canvas.width, startPoint.x + dx)),
            y: Math.max(0, Math.min(canvas.height, startPoint.y + dy)),
          },
        };
      });
    },
    [zoom]
  );

  const handleWallEndpointPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    wallEndpointDragRef.current = null;
  }, []);

  // ─── Desktop drag rect (% of canvas CSS area) ─────────────────────────────
  let dragRect: { left: string; top: string; width: string; height: string } | null = null;
  let restrictionPreviewRect: { left: string; top: string; width: string; height: string } | null = null;
  let restrictionPreviewLine: { x1: number; y1: number; x2: number; y2: number; cw: number; ch: number } | null = null;
  if (dragStart && dragCurrent && canvasRef.current) {
    const cw = canvasRef.current.width;
    const ch = canvasRef.current.height;
    if (mode === 'zone') {
      const x = (Math.min(dragStart.x, dragCurrent.x) / cw) * 100;
      const y = (Math.min(dragStart.y, dragCurrent.y) / ch) * 100;
      const w = (Math.abs(dragCurrent.x - dragStart.x) / cw) * 100;
      const h = (Math.abs(dragCurrent.y - dragStart.y) / ch) * 100;
      dragRect = { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` };
    } else if (mode === 'restrictions' && restrictions) {
      if (restrictions.tool === 'wall') {
        restrictionPreviewLine = { x1: dragStart.x, y1: dragStart.y, x2: dragCurrent.x, y2: dragCurrent.y, cw, ch };
      } else if (restrictions.tool === 'no_go' || restrictions.tool === 'no_mop') {
        const x = (Math.min(dragStart.x, dragCurrent.x) / cw) * 100;
        const y = (Math.min(dragStart.y, dragCurrent.y) / ch) * 100;
        const w = (Math.abs(dragCurrent.x - dragStart.x) / cw) * 100;
        const h = (Math.abs(dragCurrent.y - dragStart.y) / ch) * 100;
        restrictionPreviewRect = { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` };
      }
    }
  }

  const isZoneMode = mode === 'zone';
  const isRoomMode = mode === 'room' && !!onSegmentClick;
  const isRestrictionsMode = mode === 'restrictions';
  const restrictionsTool = restrictions?.tool ?? 'select';

  return (
    <div
      ref={containerRef}
      className={`valetudo-map-canvas${isZoneMode ? ' valetudo-map-canvas--zone-mode' : ''}${isRoomMode ? ' valetudo-map-canvas--room-mode' : ''}${isRestrictionsMode ? ` valetudo-map-canvas--restrictions-${restrictionsTool}` : ''}`}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div
        className="valetudo-map-canvas__inner"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <canvas
          ref={canvasRef}
          className="valetudo-map-canvas__canvas"
          style={mapMaxHeight ? { maxHeight: mapMaxHeight, width: 'auto', maxWidth: '100%' } : undefined}
        />

        {/* Desktop drag-to-draw zone */}
        {dragRect && <div className="valetudo-map-canvas__zone-drag" style={dragRect} />}

        {/* Restrictions draw preview */}
        {restrictionPreviewRect && (
          <div
            className={`valetudo-map-canvas__restriction-preview valetudo-map-canvas__restriction-preview--${restrictions?.tool}`}
            style={restrictionPreviewRect}
          />
        )}
        {restrictionPreviewLine && (
          <svg
            className="valetudo-map-canvas__restriction-preview-svg"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              overflow: 'visible',
            }}
            viewBox={`0 0 ${restrictionPreviewLine.cw} ${restrictionPreviewLine.ch}`}
            preserveAspectRatio="none"
          >
            <line
              x1={restrictionPreviewLine.x1}
              y1={restrictionPreviewLine.y1}
              x2={restrictionPreviewLine.x2}
              y2={restrictionPreviewLine.y2}
              stroke="rgba(244,67,54,0.9)"
              strokeWidth={SCALE * 2}
              strokeLinecap="round"
            />
            <circle
              cx={restrictionPreviewLine.x1}
              cy={restrictionPreviewLine.y1}
              r={SCALE * 1.5}
              fill="rgba(244,67,54,0.9)"
            />
            <circle
              cx={restrictionPreviewLine.x2}
              cy={restrictionPreviewLine.y2}
              r={SCALE * 1.5}
              fill="rgba(244,67,54,0.9)"
            />
          </svg>
        )}

        {/* Mobile widget zone */}
        {isZoneMode && isTouchDevice && widgetZone && widgetZoneStyle && (
          <div className="valetudo-map-canvas__widget-zone" style={widgetZoneStyle}>
            {/* Move handle — center */}
            <div
              className="valetudo-map-canvas__widget-zone-move"
              onPointerDown={(e) => handleWidgetPointerDown('move', e)}
              onPointerMove={handleWidgetPointerMove}
              onPointerUp={handleWidgetPointerUp}
              onPointerCancel={handleWidgetPointerUp}
            />
            {/* Resize handle — bottom-right corner */}
            <div
              className="valetudo-map-canvas__widget-zone-resize"
              onPointerDown={(e) => handleWidgetPointerDown('resize', e)}
              onPointerMove={handleWidgetPointerMove}
              onPointerUp={handleWidgetPointerUp}
              onPointerCancel={handleWidgetPointerUp}
            />
            {/* Delete button — top-right */}
            <button
              className="valetudo-map-canvas__widget-zone-delete"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setWidgetZone(null);
                onZoneChange?.(null);
              }}
              type="button"
            >
              ×
            </button>
          </div>
        )}

        {/* Mobile pending zone widget (no_go / no_mop, tap-to-place) */}
        {isRestrictionsMode && isTouchDevice && pendingRestriction?.kind === 'zone' && pendingZoneStyle && (
          <div
            className={`valetudo-map-canvas__pending-restriction valetudo-map-canvas__pending-restriction--${pendingRestriction.type}`}
            style={pendingZoneStyle}
          >
            {/* Move handle — center */}
            <div
              className="valetudo-map-canvas__pending-restriction-move"
              onPointerDown={(e) => handlePendingPointerDown('move', e)}
              onPointerMove={handlePendingPointerMove}
              onPointerUp={handlePendingPointerUp}
              onPointerCancel={handlePendingPointerUp}
            />
            {/* Resize handle — bottom-right corner */}
            <div
              className="valetudo-map-canvas__pending-restriction-resize"
              onPointerDown={(e) => handlePendingPointerDown('resize', e)}
              onPointerMove={handlePendingPointerMove}
              onPointerUp={handlePendingPointerUp}
              onPointerCancel={handlePendingPointerUp}
            />
            {/* Delete button — top-right */}
            <button
              className="valetudo-map-canvas__pending-restriction-delete"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setPendingRestriction(null);
              }}
              type="button"
            >
              ×
            </button>
            {/* Confirm button — bottom-left */}
            <button
              className="valetudo-map-canvas__pending-restriction-confirm"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                confirmPendingRestriction();
              }}
              type="button"
            >
              ✓
            </button>
          </div>
        )}

        {/* Mobile pending wall widget — two independently draggable endpoints */}
        {isRestrictionsMode &&
          isTouchDevice &&
          pendingRestriction?.kind === 'wall' &&
          pendingWallLayout &&
          (() => {
            const wall = pendingRestriction;
            const layout = pendingWallLayout;
            return (
              <>
                {/* Line SVG (pointer-events disabled) */}
                <svg
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                    overflow: 'visible',
                  }}
                  viewBox={`0 0 ${layout.cw} ${layout.ch}`}
                  preserveAspectRatio="none"
                >
                  <line
                    x1={wall.pA.x}
                    y1={wall.pA.y}
                    x2={wall.pB.x}
                    y2={wall.pB.y}
                    stroke="rgba(244,67,54,0.9)"
                    strokeWidth={SCALE * 2}
                    strokeLinecap="round"
                  />
                </svg>
                {/* Endpoint A handle */}
                <div
                  className="valetudo-map-canvas__wall-endpoint"
                  style={{ position: 'absolute', ...layout.pAStyle, transform: 'translate(-50%, -50%)' }}
                  onPointerDown={(e) => handleWallEndpointPointerDown('pA', e)}
                  onPointerMove={handleWallEndpointPointerMove}
                  onPointerUp={handleWallEndpointPointerUp}
                  onPointerCancel={handleWallEndpointPointerUp}
                />
                {/* Endpoint B handle */}
                <div
                  className="valetudo-map-canvas__wall-endpoint"
                  style={{ position: 'absolute', ...layout.pBStyle, transform: 'translate(-50%, -50%)' }}
                  onPointerDown={(e) => handleWallEndpointPointerDown('pB', e)}
                  onPointerMove={handleWallEndpointPointerMove}
                  onPointerUp={handleWallEndpointPointerUp}
                  onPointerCancel={handleWallEndpointPointerUp}
                />
                {/* Delete button above midpoint */}
                <button
                  className="valetudo-map-canvas__wall-action-btn valetudo-map-canvas__wall-action-btn--delete"
                  style={{ position: 'absolute', ...layout.midStyle, transform: 'translate(-50%, -160%)' }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingRestriction(null);
                  }}
                  type="button"
                >
                  ×
                </button>
                {/* Confirm button below midpoint */}
                <button
                  className="valetudo-map-canvas__wall-action-btn valetudo-map-canvas__wall-action-btn--confirm"
                  style={{ position: 'absolute', ...layout.midStyle, transform: 'translate(-50%, 60%)' }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    confirmPendingRestriction();
                  }}
                  type="button"
                >
                  ✓
                </button>
              </>
            );
          })()}
      </div>

      {/* Bottom-right controls: iterations + zoom */}
      <div
        className="valetudo-map-canvas__bottom-controls"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
      >
        {onIterationsChange && mode !== 'restrictions' && (
          <button
            type="button"
            className="valetudo-map-canvas__iterations-btn"
            title={t('valetudo.cleaning.iterations')}
            onClick={(e) => {
              e.stopPropagation();
              onIterationsChange(iterations >= 4 ? 1 : iterations + 1);
            }}
          >
            {iterations}×
          </button>
        )}
        <div className="valetudo-map-canvas__zoom-controls">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => Math.min(8, z * 1.5));
            }}
          >
            +
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setZoom((prev) => {
                const nz = Math.max(1, prev / 1.5);
                if (nz <= 1) {
                  setPan({ x: 0, y: 0 });
                  return 1;
                }
                return nz;
              });
            }}
          >
            −
          </button>
          {zoom > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              style={{ fontSize: '0.7rem' }}
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
