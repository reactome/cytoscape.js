// SVG-recording shim for CanvasRenderingContext2D, used by cy.svg() export.
// Implements only the Canvas 2D APIs used by the cytoscape.js canvas renderer.

const SVG_NS = 'http://www.w3.org/2000/svg';

const xmlEscape = s => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const fmtNum = n => {
  if( !isFinite(n) ) return '0';
  // round to 3 decimals to keep file size down; canvas precision is fine here
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

const fmtMatrix = m =>
  `matrix(${fmtNum(m[0])} ${fmtNum(m[1])} ${fmtNum(m[2])} ${fmtNum(m[3])} ${fmtNum(m[4])} ${fmtNum(m[5])})`;

const identityMatrix = () => [1, 0, 0, 1, 0, 0];

const multiplyMatrix = (a, b) => [
  a[0]*b[0] + a[2]*b[1],
  a[1]*b[0] + a[3]*b[1],
  a[0]*b[2] + a[2]*b[3],
  a[1]*b[2] + a[3]*b[3],
  a[0]*b[4] + a[2]*b[5] + a[4],
  a[1]*b[4] + a[3]*b[5] + a[5],
];

const isIdentityMatrix = m =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

// Approximate uniform scale of the matrix (used to scale stroke widths when
// geometry is baked into world-space coords). For an axis-aligned scale this
// is exactly |sx|; for rotation+uniform-scale it is sqrt(a^2 + b^2).
const matrixScale = m => Math.sqrt( m[0]*m[0] + m[1]*m[1] );

// True if the matrix has no rotation/skew (only scale + translate). Used to
// decide whether image/rect emission can fully bake the matrix or needs to
// emit a transform attribute.
const isAxisAligned = m =>
  Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;

// Apply a 2D affine matrix to a point.
const transformPoint = (m, x, y) => [
  m[0]*x + m[2]*y + m[4],
  m[1]*x + m[3]*y + m[5],
];

class Path2DShim {
  constructor( other ){
    this.cmds = [];
    if( other instanceof Path2DShim ){
      this.cmds = other.cmds.slice();
    }
  }

  // Build SVG path-data 'd' attribute from recorded commands.
  // Per the Canvas 2D spec, lineTo/quadraticCurveTo/bezierCurveTo with no
  // current point implicitly establish one (acting like moveTo). SVG path
  // syntax does not have this leniency — it requires a leading M — so we
  // convert as needed.
  toPathData(){
    const parts = [];
    let hasCurrent = false;
    // arcTo needs to know where the pen is, so the current point is tracked
    // alongside the emitted commands, as is the subpath start for Z.
    let cur = null;
    let sub = null;
    for( const c of this.cmds ){
      switch( c[0] ){
        case 'M':
          parts.push(`M ${fmtNum(c[1])} ${fmtNum(c[2])}`);
          hasCurrent = true;
          cur = { x: c[1], y: c[2] };
          sub = cur;
          break;
        case 'L':
          parts.push(`${hasCurrent ? 'L' : 'M'} ${fmtNum(c[1])} ${fmtNum(c[2])}`);
          hasCurrent = true;
          cur = { x: c[1], y: c[2] };
          if( !sub ) sub = cur;
          break;
        case 'Q':
          if( !hasCurrent ){
            // No current point — establish one at the control point.
            parts.push(`M ${fmtNum(c[1])} ${fmtNum(c[2])}`);
          }
          parts.push(`Q ${fmtNum(c[1])} ${fmtNum(c[2])} ${fmtNum(c[3])} ${fmtNum(c[4])}`);
          hasCurrent = true;
          cur = { x: c[3], y: c[4] };
          if( !sub ) sub = cur;
          break;
        case 'C':
          if( !hasCurrent ){
            parts.push(`M ${fmtNum(c[1])} ${fmtNum(c[2])}`);
          }
          parts.push(`C ${fmtNum(c[1])} ${fmtNum(c[2])} ${fmtNum(c[3])} ${fmtNum(c[4])} ${fmtNum(c[5])} ${fmtNum(c[6])}`);
          hasCurrent = true;
          cur = { x: c[5], y: c[6] };
          if( !sub ) sub = cur;
          break;
        case 'Z':
          parts.push('Z');
          // Z returns the pen to the start of the current subpath.
          if( sub ) cur = sub;
          break;
        case 'A': {
          const [, cx, cy, r, a0, a1, ccw] = c;
          parts.push(arcToSvg(cx, cy, r, a0, a1, ccw, hasCurrent));
          hasCurrent = true;
          cur = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
          if( !sub ) sub = cur;
          break;
        }
        case 'AT': {
          const [, x1, y1, x2, y2, r] = c;
          const arc = arcToSvgFromArcTo(cur, x1, y1, x2, y2, r, hasCurrent);
          parts.push(arc.d);
          hasCurrent = true;
          cur = arc.end;
          if( !sub ) sub = cur;
          break;
        }
        case 'R': {
          const [, x, y, w, h] = c;
          parts.push(`M ${fmtNum(x)} ${fmtNum(y)} h ${fmtNum(w)} v ${fmtNum(h)} h ${fmtNum(-w)} Z`);
          hasCurrent = true;
          cur = { x, y };
          sub = cur;
          break;
        }
      }
    }
    return parts.join(' ');
  }

  beginPath(){ this.cmds = []; }
  closePath(){ this.cmds.push(['Z']); }
  moveTo(x, y){ this.cmds.push(['M', x, y]); }
  lineTo(x, y){ this.cmds.push(['L', x, y]); }
  quadraticCurveTo(cpx, cpy, x, y){ this.cmds.push(['Q', cpx, cpy, x, y]); }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y){ this.cmds.push(['C', cp1x, cp1y, cp2x, cp2y, x, y]); }
  arc(cx, cy, r, a0, a1, ccw){ this.cmds.push(['A', cx, cy, r, a0, a1, !!ccw]); }
  arcTo(x1, y1, x2, y2, r){ this.cmds.push(['AT', x1, y1, x2, y2, r]); }
  rect(x, y, w, h){ this.cmds.push(['R', x, y, w, h]); }

  addPath( other, transform ){
    if( !( other instanceof Path2DShim ) ) return;
    if( transform ){
      // Not used by cytoscape; left unimplemented intentionally.
    }
    for( const c of other.cmds ){
      this.cmds.push(c.slice());
    }
  }
}

// Convert a Canvas-style arc to one or more SVG arc commands.
// Canvas arc draws a circular arc from (cx + r*cos(a0), cy + r*sin(a0)) to
// (cx + r*cos(a1), cy + r*sin(a1)) sweeping in the direction set by ccw.
// `hasCurrent` indicates whether a current point already exists in the path —
// if so, we emit `L` from the current point to the arc start (Canvas's
// implicit line); if not, we emit `M` to the start instead.
function arcToSvg(cx, cy, r, a0, a1, ccw, hasCurrent){
  let delta = a1 - a0;
  if( !ccw ){
    if( delta < 0 ) delta += Math.PI * 2;
    if( delta > Math.PI * 2 ) delta = Math.PI * 2;
  } else {
    if( delta > 0 ) delta -= Math.PI * 2;
    if( delta < -Math.PI * 2 ) delta = -Math.PI * 2;
  }

  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a0 + delta);
  const y1 = cy + r * Math.sin(a0 + delta);
  const startCmd = hasCurrent ? 'L' : 'M';

  // SVG can't draw a full circle in one arc command (start==end), so split.
  if( Math.abs(delta) >= Math.PI * 2 - 1e-9 ){
    const xm = cx + r * Math.cos(a0 + Math.PI);
    const ym = cy + r * Math.sin(a0 + Math.PI);
    const sweep = ccw ? 0 : 1;
    return `${startCmd} ${fmtNum(x0)} ${fmtNum(y0)} `
      + `A ${fmtNum(r)} ${fmtNum(r)} 0 0 ${sweep} ${fmtNum(xm)} ${fmtNum(ym)} `
      + `A ${fmtNum(r)} ${fmtNum(r)} 0 0 ${sweep} ${fmtNum(x0)} ${fmtNum(y0)}`;
  }

  const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
  const sweep = delta >= 0 ? 1 : 0;
  return `${startCmd} ${fmtNum(x0)} ${fmtNum(y0)} A ${fmtNum(r)} ${fmtNum(r)} 0 ${largeArc} ${sweep} ${fmtNum(x1)} ${fmtNum(y1)}`;
}

// Canvas arcTo: an arc of radius r tangent to the leg coming in from the
// current point and the leg going out to (x2,y2), preceded by a line to where
// that arc starts. The round-rectangle node shape is drawn entirely out of
// these, so emitting the tangent points joined by straight lines -- as this
// did before -- squared off every rounded corner in the export.
//
// The geometry is worked out once here and consumed two ways: as a real SVG
// arc when there is no transform to apply, and as sampled line segments when
// there is, matching how the centre-arc case handles rotation and skew.
function arcToGeometry( p0, x1, y1, x2, y2, r ){
  const v1 = { x: p0.x - x1, y: p0.y - y1 };
  const v2 = { x: x2 - x1, y: y2 - y1 };
  const l1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
  const l2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
  const cross = v1.x * v2.y - v1.y * v2.x;

  // Zero radius, a zero-length leg, or three collinear points: the Canvas spec
  // degenerates to a straight line to (x1,y1).
  if( !(r > 0) || l1 === 0 || l2 === 0 || cross === 0 ){
    return { degenerate: true, end: { x: x1, y: y1 } };
  }

  const u1 = { x: v1.x / l1, y: v1.y / l1 };
  const u2 = { x: v2.x / l2, y: v2.y / l2 };
  const cosTheta = Math.min(1, Math.max(-1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(cosTheta);
  const tanHalf = Math.tan(theta / 2);
  const sinHalf = Math.sin(theta / 2);

  if( !isFinite(tanHalf) || tanHalf === 0 || sinHalf === 0 ){
    return { degenerate: true, end: { x: x1, y: y1 } };
  }

  // How far back along each leg the arc meets it, and where its centre sits
  // along the bisector of the two legs.
  const dist = r / tanHalf;
  const t1 = { x: x1 + u1.x * dist, y: y1 + u1.y * dist };
  const t2 = { x: x1 + u2.x * dist, y: y1 + u2.y * dist };

  const bx = u1.x + u2.x;
  const by = u1.y + u2.y;
  const bl = Math.sqrt(bx * bx + by * by);
  if( bl === 0 ){
    return { degenerate: true, end: { x: x1, y: y1 } };
  }
  const centre = { x: x1 + (bx / bl) * (r / sinHalf), y: y1 + (by / bl) * (r / sinHalf) };

  // A negative cross product is a clockwise turn in the y-down space these
  // coordinates live in. Corners always take the short way round.
  const clockwise = cross < 0;

  return {
    degenerate: false,
    t1,
    t2,
    centre,
    r,
    a0: Math.atan2(t1.y - centre.y, t1.x - centre.x),
    a1: Math.atan2(t2.y - centre.y, t2.x - centre.x),
    ccw: !clockwise,
    sweep: clockwise ? 1 : 0,
    end: t2,
  };
}

function arcToSvgFromArcTo( p0, x1, y1, x2, y2, r, hasCurrent ){
  // With no current point the spec says arcTo behaves as moveTo(x1,y1).
  if( !hasCurrent || !p0 ){
    return { d: `M ${fmtNum(x1)} ${fmtNum(y1)}`, end: { x: x1, y: y1 } };
  }

  const g = arcToGeometry(p0, x1, y1, x2, y2, r);
  if( g.degenerate ){
    return { d: `L ${fmtNum(x1)} ${fmtNum(y1)}`, end: g.end };
  }

  return {
    d:
      `L ${fmtNum(g.t1.x)} ${fmtNum(g.t1.y)}` +
      ` A ${fmtNum(g.r)} ${fmtNum(g.r)} 0 0 ${g.sweep} ${fmtNum(g.t2.x)} ${fmtNum(g.t2.y)}`,
    end: g.end,
  };
}

class SvgGradient {
  constructor( type, coords, transform ){
    this.type = type; // 'linear' | 'radial'
    this.coords = coords;
    // Snapshot of the matrix at createLinearGradient/createRadialGradient
    // time. Applied as `gradientTransform` so the gradient lines up with
    // baked-into-world-space path geometry that uses it.
    this.transform = transform.slice();
    this.stops = []; // [{offset, color}]
  }
  addColorStop( offset, color ){
    this.stops.push({ offset, color });
  }
}

class SvgPattern {
  constructor( image, repeat ){
    this.image = image;
    this.repeat = repeat || 'repeat';
  }
}

const initialState = () => ({
  transform: identityMatrix(),
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 10,
  lineDash: [],
  lineDashOffset: 0,
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  imageSmoothingEnabled: true,
  // active clip-path id (assigned via clip())
  clipId: null,
});

class SvgContext {
  constructor( width, height, options ){
    this.width = width;
    this.height = height;
    this.options = options || {};

    this._state = initialState();
    this._stack = [];
    this._path = new Path2DShim();

    this._defs = []; // strings appended to <defs>
    this._body = []; // { kind: 'el' | 'group-open' | 'group-close', ... }
    this._idCounter = 0;
    this._imageDataUrlCache = new Map();
  }

  _id( prefix ){ return `${prefix}-${++this._idCounter}`; }

  // ---- state stack ----
  save(){
    // Deep copy mutable parts of state.
    const s = this._state;
    this._stack.push({
      ...s,
      transform: s.transform.slice(),
      lineDash: s.lineDash.slice(),
    });
  }
  restore(){
    if( this._stack.length > 0 ){
      this._state = this._stack.pop();
    }
  }

  // ---- transforms ----
  translate(x, y){
    this._state.transform = multiplyMatrix(this._state.transform, [1, 0, 0, 1, x, y]);
  }
  rotate(angle){
    const c = Math.cos(angle), s = Math.sin(angle);
    this._state.transform = multiplyMatrix(this._state.transform, [c, s, -s, c, 0, 0]);
  }
  scale(sx, sy){
    if( sy === undefined ) sy = sx;
    this._state.transform = multiplyMatrix(this._state.transform, [sx, 0, 0, sy, 0, 0]);
  }
  setTransform(a, b, c, d, e, f){
    this._state.transform = [a, b, c, d, e, f];
  }
  resetTransform(){
    this._state.transform = identityMatrix();
  }
  transform(a, b, c, d, e, f){
    this._state.transform = multiplyMatrix(this._state.transform, [a, b, c, d, e, f]);
  }

  // ---- properties ----
  get fillStyle(){ return this._state.fillStyle; }
  set fillStyle(v){ this._state.fillStyle = v; }
  get strokeStyle(){ return this._state.strokeStyle; }
  set strokeStyle(v){ this._state.strokeStyle = v; }
  get lineWidth(){ return this._state.lineWidth; }
  set lineWidth(v){ this._state.lineWidth = v; }
  get lineCap(){ return this._state.lineCap; }
  set lineCap(v){ this._state.lineCap = v; }
  get lineJoin(){ return this._state.lineJoin; }
  set lineJoin(v){ this._state.lineJoin = v; }
  get miterLimit(){ return this._state.miterLimit; }
  set miterLimit(v){ this._state.miterLimit = v; }
  get lineDashOffset(){ return this._state.lineDashOffset; }
  set lineDashOffset(v){ this._state.lineDashOffset = v; }
  get globalAlpha(){ return this._state.globalAlpha; }
  set globalAlpha(v){ this._state.globalAlpha = v; }
  get globalCompositeOperation(){ return this._state.globalCompositeOperation; }
  set globalCompositeOperation(v){ this._state.globalCompositeOperation = v; }
  get font(){ return this._state.font; }
  set font(v){ this._state.font = v; }
  get textAlign(){ return this._state.textAlign; }
  set textAlign(v){ this._state.textAlign = v; }
  get textBaseline(){ return this._state.textBaseline; }
  set textBaseline(v){ this._state.textBaseline = v; }
  get imageSmoothingEnabled(){ return this._state.imageSmoothingEnabled; }
  set imageSmoothingEnabled(v){ this._state.imageSmoothingEnabled = v; }

  // Vendor-prefixed image smoothing (no-ops for SVG).
  get webkitImageSmoothingEnabled(){ return this._state.imageSmoothingEnabled; }
  set webkitImageSmoothingEnabled(v){ this._state.imageSmoothingEnabled = v; }
  get mozImageSmoothingEnabled(){ return this._state.imageSmoothingEnabled; }
  set mozImageSmoothingEnabled(v){ this._state.imageSmoothingEnabled = v; }
  get msImageSmoothingEnabled(){ return this._state.imageSmoothingEnabled; }
  set msImageSmoothingEnabled(v){ this._state.imageSmoothingEnabled = v; }

  // ---- path building (delegates to _path) ----
  beginPath(){ this._path = new Path2DShim(); }
  closePath(){ this._path.closePath(); }
  moveTo(x, y){ this._path.moveTo(x, y); }
  lineTo(x, y){ this._path.lineTo(x, y); }
  quadraticCurveTo(cpx, cpy, x, y){ this._path.quadraticCurveTo(cpx, cpy, x, y); }
  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y){ this._path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y); }
  arc(cx, cy, r, a0, a1, ccw){ this._path.arc(cx, cy, r, a0, a1, ccw); }
  arcTo(x1, y1, x2, y2, r){ this._path.arcTo(x1, y1, x2, y2, r); }
  rect(x, y, w, h){ this._path.rect(x, y, w, h); }

  // ---- line dash ----
  setLineDash( arr ){
    this._state.lineDash = Array.isArray(arr) ? arr.slice() : [];
  }
  getLineDash(){ return this._state.lineDash.slice(); }

  // ---- gradients ----
  createLinearGradient(x0, y0, x1, y1){
    return new SvgGradient('linear', { x0, y0, x1, y1 }, this._state.transform);
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1){
    return new SvgGradient('radial', { x0, y0, r0, x1, y1, r1 }, this._state.transform);
  }
  createPattern( image, repeat ){
    return new SvgPattern( image, repeat );
  }

  // ---- text ----
  measureText( text ){
    // Stub. Cytoscape's renderer measures text against a separate canvas at
    // layout time, not against the export context. If something does call
    // measureText on us, return a best-effort width estimate.
    const m = /([\d.]+)px/.exec(this._state.font || '');
    const size = m ? parseFloat(m[1]) : 10;
    return { width: (text != null ? String(text).length : 0) * size * 0.5 };
  }

  // ---- drawing primitives ----
  clearRect(x, y, w, h){
    // For SVG export, treat clearRect as a no-op (the buffer starts empty).
    // Cytoscape only calls clearRect on a fresh canvas at the start of the
    // export, so this is fine.
  }

  fillRect(x, y, w, h){
    if( w <= 0 || h <= 0 ) return;
    const path = new Path2DShim();
    path.rect(x, y, w, h);
    this._emitPath( path, true, false );
  }

  strokeRect(x, y, w, h){
    if( w <= 0 || h <= 0 ) return;
    const path = new Path2DShim();
    path.rect(x, y, w, h);
    this._emitPath( path, false, true );
  }

  fill( pathOrRule ){
    let path = this._path;
    if( pathOrRule instanceof Path2DShim ){
      path = pathOrRule;
    }
    this._emitPath( path, true, false );
  }

  stroke( pathOrRule ){
    let path = this._path;
    if( pathOrRule instanceof Path2DShim ){
      path = pathOrRule;
    }
    this._emitPath( path, false, true );
  }

  clip( pathOrRule, fillRule ){
    let path = this._path;
    let rule = fillRule;
    if( pathOrRule instanceof Path2DShim ){
      path = pathOrRule;
      rule = fillRule;
    } else if( typeof pathOrRule === 'string' ){
      rule = pathOrRule;
    }
    this._installClip( path, rule || 'nonzero' );
  }

  // ---- text drawing ----
  fillText( text, x, y, maxWidth ){
    this._emitText( text, x, y, true, false, maxWidth );
  }
  strokeText( text, x, y, maxWidth ){
    this._emitText( text, x, y, false, true, maxWidth );
  }

  // ---- image drawing ----
  drawImage( image, ...args ){
    let sx, sy, sw, sh, dx, dy, dw, dh;
    const iw = image && (image.naturalWidth || image.width || image.cachedW) || 0;
    const ih = image && (image.naturalHeight || image.height || image.cachedH) || 0;
    if( args.length === 2 ){
      [dx, dy] = args; sx = 0; sy = 0; sw = iw; sh = ih; dw = iw; dh = ih;
    } else if( args.length === 4 ){
      [dx, dy, dw, dh] = args; sx = 0; sy = 0; sw = iw; sh = ih;
    } else if( args.length === 8 ){
      [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    } else {
      return;
    }

    if( dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0 ) return;

    const isFullImage = sx === 0 && sy === 0 && sw === iw && sh === ih;
    const href = this._resolveImageHref( image, isFullImage ? null : { sx, sy, sw, sh } );
    if( href == null ) return;

    const m = this._state.transform;
    let outX = dx, outY = dy, outW = dw, outH = dh;
    let transformAttr = '';
    if( !isIdentityMatrix(m) ){
      if( isAxisAligned(m) ){
        // Bake translate+scale into x/y/width/height so we can omit the
        // transform attribute (which interacts poorly with clip-path).
        outX = m[0]*dx + m[4];
        outY = m[3]*dy + m[5];
        outW = m[0]*dw;
        outH = m[3]*dh;
        // Negative scale → flip via transform (rare, but cheap to support).
        if( outW < 0 ){ outX += outW; outW = -outW; }
        if( outH < 0 ){ outY += outH; outH = -outH; }
      } else {
        transformAttr = ` transform="${fmtMatrix(m)}"`;
      }
    }

    const attrs = [
      `href="${xmlEscape(href)}"`,
      `x="${fmtNum(outX)}"`,
      `y="${fmtNum(outY)}"`,
      `width="${fmtNum(outW)}"`,
      `height="${fmtNum(outH)}"`,
      'preserveAspectRatio="none"',
    ];
    if( !this._state.imageSmoothingEnabled ){
      attrs.push('image-rendering="pixelated"');
    }

    this._pushElement(`<image ${attrs.join(' ')}${transformAttr}${this._commonAttrs()} />`);
  }

  // ---- internals ----

  _resolveImageHref( image, sub ){
    if( image == null ) return null;
    const embed = this.options.embedImages !== false;

    // If it's already a Canvas/OffscreenCanvas (texture cache), always embed.
    const isCanvasLike = image && typeof image.toDataURL === 'function';
    const src = image.src || (image.currentSrc) || null;

    if( !embed && !sub && src ){
      return src;
    }

    // Build a cache key.
    const key = sub ? `${src || image}|${sub.sx},${sub.sy},${sub.sw},${sub.sh}` : (src || image);
    const cached = this._imageDataUrlCache.get( key );
    if( cached ) return cached;

    try {
      let url;
      if( isCanvasLike && !sub ){
        url = image.toDataURL();
      } else {
        const doc = (typeof document !== 'undefined') ? document : null;
        if( !doc ) {
          if( src ) return src;
          return null;
        }
        const c = doc.createElement('canvas');
        c.width = sub ? sub.sw : (image.naturalWidth || image.width || image.cachedW || 0);
        c.height = sub ? sub.sh : (image.naturalHeight || image.height || image.cachedH || 0);
        if( c.width === 0 || c.height === 0 ) return src || null;
        const ctx = c.getContext('2d');
        if( sub ){
          ctx.drawImage( image, sub.sx, sub.sy, sub.sw, sub.sh, 0, 0, sub.sw, sub.sh );
        } else {
          ctx.drawImage( image, 0, 0 );
        }
        url = c.toDataURL();
      }
      this._imageDataUrlCache.set( key, url );
      return url;
    } catch {
      // CORS-tainted or other failure — fall back to URL ref.
      if( src ){
        // Warn once per image.
        if( typeof console !== 'undefined' && console.warn && !image.__cysvgWarned ){
          image.__cysvgWarned = true;
          console.warn('cy.svg(): could not embed image (likely CORS-tainted), referencing URL instead:', src);
        }
        return src;
      }
      return null;
    }
  }

  // Common attributes (clip-path + opacity) for elements whose geometry has
  // already been baked into world-space coordinates by the caller — so we
  // never emit a `transform` attribute alongside `clip-path` (the two
  // interact in confusing ways with `userSpaceOnUse` clipPaths).
  _commonAttrs(){
    const s = this._state;
    const parts = [];
    if( s.clipId ){
      parts.push(` clip-path="url(#${s.clipId})"`);
    }
    if( s.globalAlpha !== 1 ){
      parts.push(` opacity="${fmtNum(s.globalAlpha)}"`);
    }
    return parts.join('');
  }

  // Variant for text, where rotation/scale changes glyph orientation, so we
  // emit a transform attribute instead of baking. Text in cytoscape is not
  // clipped, so the clip-path interaction does not apply here.
  _commonAttrsWithTransform(){
    const s = this._state;
    const parts = [];
    if( !isIdentityMatrix(s.transform) ){
      parts.push(` transform="${fmtMatrix(s.transform)}"`);
    }
    if( s.clipId ){
      parts.push(` clip-path="url(#${s.clipId})"`);
    }
    if( s.globalAlpha !== 1 ){
      parts.push(` opacity="${fmtNum(s.globalAlpha)}"`);
    }
    return parts.join('');
  }

  _styleFromColor( color, isStroke ){
    // Returns { value, defs } for fill-style strings/gradients/patterns.
    if( color instanceof SvgGradient ){
      const id = this._id('grad');
      this._defs.push( gradientToDefs(id, color) );
      return { value: `url(#${id})`, opacity: 1 };
    }
    if( color instanceof SvgPattern ){
      const id = this._id('pat');
      const href = this._resolveImageHref( color.image, null );
      if( href != null ){
        this._defs.push( patternToDefs(id, href, color) );
        return { value: `url(#${id})`, opacity: 1 };
      }
      return { value: 'none', opacity: 0 };
    }
    // String color: parse rgba(...) for separate fill-opacity if needed.
    return parseCssColor( color );
  }

  _emitPath( path, doFill, doStroke ){
    if( !path || path.cmds.length === 0 ) return;

    const s = this._state;
    if( s.globalCompositeOperation === 'destination-out' ){
      // We don't support destination-out clearing in SVG output. Skip.
      return;
    }

    // Bake the current matrix into the path data so we can omit the
    // `transform` attribute. This avoids ambiguity when combined with
    // `clip-path` — the clipPath geometry is also baked into world space.
    const d = isIdentityMatrix(s.transform)
      ? path.toPathData()
      : transformPathByMatrix( path, s.transform );
    if( d.length === 0 ) return;

    const attrs = [`d="${d}"`];

    if( doFill ){
      const fs = this._styleFromColor( s.fillStyle, false );
      attrs.push(`fill="${fs.value}"`);
      if( fs.opacity !== undefined && fs.opacity !== 1 ){
        attrs.push(`fill-opacity="${fmtNum(fs.opacity)}"`);
      }
    } else {
      attrs.push('fill="none"');
    }

    if( doStroke ){
      const ss = this._styleFromColor( s.strokeStyle, true );
      attrs.push(`stroke="${ss.value}"`);
      if( ss.opacity !== undefined && ss.opacity !== 1 ){
        attrs.push(`stroke-opacity="${fmtNum(ss.opacity)}"`);
      }
      // Geometry has been baked through the current matrix, so stroke width
      // must be scaled by the matrix's uniform scale to keep visual parity
      // with Canvas (which scales strokes implicitly with the matrix).
      const sw = s.lineWidth * matrixScale( s.transform );
      attrs.push(`stroke-width="${fmtNum(sw)}"`);
      if( s.lineCap !== 'butt' ) attrs.push(`stroke-linecap="${s.lineCap}"`);
      if( s.lineJoin !== 'miter' ) attrs.push(`stroke-linejoin="${s.lineJoin}"`);
      if( s.lineJoin === 'miter' && s.miterLimit !== 10 ) attrs.push(`stroke-miterlimit="${fmtNum(s.miterLimit)}"`);
      if( s.lineDash && s.lineDash.length > 0 ){
        const ms = matrixScale( s.transform );
        attrs.push(`stroke-dasharray="${s.lineDash.map(v => fmtNum(v * ms)).join(' ')}"`);
        if( s.lineDashOffset ) attrs.push(`stroke-dashoffset="${fmtNum(s.lineDashOffset * ms)}"`);
      }
    }

    const el = `<path ${attrs.join(' ')}${this._commonAttrs()} />`;
    this._pushElement( el );
  }

  _emitText( text, x, y, doFill, doStroke ){
    if( text == null || text === '' ) return;
    if( this._state.globalCompositeOperation === 'destination-out' ) return;

    const s = this._state;
    const attrs = [`x="${fmtNum(x)}"`, `y="${fmtNum(y)}"`];

    // Map textAlign → text-anchor.
    let anchor = 'start';
    switch( s.textAlign ){
      case 'left': anchor = 'start'; break;
      case 'right': anchor = 'end'; break;
      case 'center': anchor = 'middle'; break;
      case 'start': anchor = 'start'; break;
      case 'end': anchor = 'end'; break;
    }
    if( anchor !== 'start' ) attrs.push(`text-anchor="${anchor}"`);

    // Map textBaseline → dominant-baseline.
    let baseline = null;
    switch( s.textBaseline ){
      case 'top': baseline = 'text-before-edge'; break;
      case 'middle': baseline = 'central'; break;
      case 'bottom': baseline = 'text-after-edge'; break;
      case 'alphabetic': baseline = null; break;
      case 'hanging': baseline = 'hanging'; break;
      case 'ideographic': baseline = 'ideographic'; break;
    }
    if( baseline ) attrs.push(`dominant-baseline="${baseline}"`);

    // Map ctx.font → CSS font shorthand.
    if( s.font ) attrs.push(`style="font: ${xmlEscape(s.font)}"`);

    if( doFill ){
      const fs = this._styleFromColor( s.fillStyle, false );
      attrs.push(`fill="${fs.value}"`);
      if( fs.opacity !== undefined && fs.opacity !== 1 ){
        attrs.push(`fill-opacity="${fmtNum(fs.opacity)}"`);
      }
    } else {
      attrs.push('fill="none"');
    }

    if( doStroke ){
      const ss = this._styleFromColor( s.strokeStyle, true );
      attrs.push(`stroke="${ss.value}"`);
      if( ss.opacity !== undefined && ss.opacity !== 1 ){
        attrs.push(`stroke-opacity="${fmtNum(ss.opacity)}"`);
      }
      attrs.push(`stroke-width="${fmtNum(s.lineWidth)}"`);
      attrs.push('paint-order="stroke fill"');
      if( s.lineJoin !== 'miter' ) attrs.push(`stroke-linejoin="${s.lineJoin}"`);
    }

    const el = `<text ${attrs.join(' ')}${this._commonAttrsWithTransform()}>${xmlEscape(text)}</text>`;
    this._pushElement( el );
  }

  _installClip( path, rule ){
    const id = this._id('clip');
    // Bake the current transform into the clipPath so it operates in the
    // same user-space the path was defined in.
    const transformed = transformPathByMatrix( path, this._state.transform );
    const ruleAttr = rule === 'evenodd' ? ' clip-rule="evenodd" fill-rule="evenodd"' : '';
    this._defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${transformed}"${ruleAttr}/></clipPath>`);
    this._state.clipId = id;
  }

  _pushElement( str ){
    if( this._state.globalCompositeOperation === 'destination-over' ){
      this._body.unshift( str );
    } else {
      this._body.push( str );
    }
  }

  // Output an SVG document string. `viewBox` and `bg` (background color) are
  // applied here so that the export caller can set the document size/viewport
  // rather than the shim guessing.
  toSVG({ viewBox, bg } = {}){
    const w = fmtNum( this.width );
    const h = fmtNum( this.height );
    const vb = viewBox || `0 0 ${w} ${h}`;
    const defs = this._defs.length ? `<defs>${this._defs.join('')}</defs>` : '';
    const bgRect = bg ? `<rect x="0" y="0" width="${w}" height="${h}" fill="${xmlEscape(bg)}"/>` : '';
    return `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="${vb}">${defs}${bgRect}${this._body.join('')}</svg>`;
  }
}

function gradientToDefs( id, g ){
  // Decompose stop colour to extract alpha → stop-opacity (broader browser
  // support than rgba() in stop-color, which SVG 1.1 doesn't allow).
  const stops = g.stops.map(s => {
    const parsed = parseCssColor(s.color);
    const opacityAttr = parsed.opacity !== undefined && parsed.opacity !== 1
      ? ` stop-opacity="${fmtNum(parsed.opacity)}"` : '';
    return `<stop offset="${fmtNum(s.offset)}" stop-color="${xmlEscape(parsed.value)}"${opacityAttr}/>`;
  }).join('');
  const xform = !isIdentityMatrix(g.transform)
    ? ` gradientTransform="${fmtMatrix(g.transform)}"` : '';
  if( g.type === 'linear' ){
    const { x0, y0, x1, y1 } = g.coords;
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse"${xform} x1="${fmtNum(x0)}" y1="${fmtNum(y0)}" x2="${fmtNum(x1)}" y2="${fmtNum(y1)}">${stops}</linearGradient>`;
  } else {
    const { x1, y1, r1 } = g.coords;
    return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse"${xform} cx="${fmtNum(x1)}" cy="${fmtNum(y1)}" r="${fmtNum(r1)}">${stops}</radialGradient>`;
  }
}

function patternToDefs( id, href, p ){
  const w = p.image.naturalWidth || p.image.width || p.image.cachedW || 1;
  const h = p.image.naturalHeight || p.image.height || p.image.cachedH || 1;
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${fmtNum(w)}" height="${fmtNum(h)}"><image href="${xmlEscape(href)}" x="0" y="0" width="${fmtNum(w)}" height="${fmtNum(h)}"/></pattern>`;
}

// Apply an affine matrix to all coordinate-bearing path commands and emit
// SVG path data. Mirrors Path2DShim.toPathData() but with each coordinate
// transformed by `m`. Also handles the Canvas-spec leniency where lineTo /
// quadraticCurveTo / bezierCurveTo from no current point implicitly act as
// moveTo (SVG path data requires an explicit M).
function transformPathByMatrix( path, m ){
  const parts = [];
  let hasCurrent = false;
  // arcTo needs the pen position in untransformed space to work out its
  // tangents, so track that alongside the emitted (transformed) output.
  let cur = null;
  let sub = null;
  for( const c of path.cmds ){
    switch( c[0] ){
      case 'M': {
        const [x, y] = transformPoint(m, c[1], c[2]);
        parts.push(`M ${fmtNum(x)} ${fmtNum(y)}`);
        hasCurrent = true;
        cur = { x: c[1], y: c[2] };
        sub = cur;
        break;
      }
      case 'L': {
        const [x, y] = transformPoint(m, c[1], c[2]);
        parts.push(`${hasCurrent ? 'L' : 'M'} ${fmtNum(x)} ${fmtNum(y)}`);
        hasCurrent = true;
        cur = { x: c[1], y: c[2] };
        if( !sub ) sub = cur;
        break;
      }
      case 'Q': {
        const [cx, cy] = transformPoint(m, c[1], c[2]);
        const [x, y] = transformPoint(m, c[3], c[4]);
        if( !hasCurrent ) parts.push(`M ${fmtNum(cx)} ${fmtNum(cy)}`);
        parts.push(`Q ${fmtNum(cx)} ${fmtNum(cy)} ${fmtNum(x)} ${fmtNum(y)}`);
        hasCurrent = true;
        cur = { x: c[3], y: c[4] };
        if( !sub ) sub = cur;
        break;
      }
      case 'C': {
        const [c1x, c1y] = transformPoint(m, c[1], c[2]);
        const [c2x, c2y] = transformPoint(m, c[3], c[4]);
        const [x, y] = transformPoint(m, c[5], c[6]);
        if( !hasCurrent ) parts.push(`M ${fmtNum(c1x)} ${fmtNum(c1y)}`);
        parts.push(`C ${fmtNum(c1x)} ${fmtNum(c1y)} ${fmtNum(c2x)} ${fmtNum(c2y)} ${fmtNum(x)} ${fmtNum(y)}`);
        hasCurrent = true;
        cur = { x: c[5], y: c[6] };
        if( !sub ) sub = cur;
        break;
      }
      case 'Z':
        parts.push('Z');
        if( sub ) cur = sub;
        break;
      case 'A': {
        // Sample the arc into line segments so the affine transform is
        // applied per-vertex (preserves rotation/skew correctly).
        const [, cx, cy, r, a0, a1, ccw] = c;
        const seg = sampleArc(cx, cy, r, a0, a1, ccw);
        for( const pt of seg ){
          const [tx, ty] = transformPoint(m, pt.x, pt.y);
          if( pt.first ){
            parts.push(`${hasCurrent ? 'L' : 'M'} ${fmtNum(tx)} ${fmtNum(ty)}`);
          } else {
            parts.push(`L ${fmtNum(tx)} ${fmtNum(ty)}`);
          }
          hasCurrent = true;
        }
        cur = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
        if( !sub ) sub = cur;
        break;
      }
      case 'AT': {
        const [, ax1, ay1, ax2, ay2, ar] = c;
        // Same treatment as the centre-arc case above: work the geometry out
        // untransformed, then sample it so the matrix applies per-vertex.
        // Emitting the two tangent legs as straight lines, which is what this
        // did before, squared off every rounded corner.
        const g = (hasCurrent && cur) ? arcToGeometry(cur, ax1, ay1, ax2, ay2, ar) : null;
        if( !g || g.degenerate ){
          const [tx, ty] = transformPoint(m, ax1, ay1);
          parts.push(`${hasCurrent ? 'L' : 'M'} ${fmtNum(tx)} ${fmtNum(ty)}`);
          cur = { x: ax1, y: ay1 };
        } else {
          const [t1x, t1y] = transformPoint(m, g.t1.x, g.t1.y);
          parts.push(`${hasCurrent ? 'L' : 'M'} ${fmtNum(t1x)} ${fmtNum(t1y)}`);
          for( const pt of sampleArc(g.centre.x, g.centre.y, g.r, g.a0, g.a1, g.ccw) ){
            if( pt.first ) continue; // already emitted as the tangent point
            const [px, py] = transformPoint(m, pt.x, pt.y);
            parts.push(`L ${fmtNum(px)} ${fmtNum(py)}`);
          }
          cur = g.end;
        }
        hasCurrent = true;
        if( !sub ) sub = cur;
        break;
      }
      case 'R': {
        const [, x, y, w, h] = c;
        const [x0, y0] = transformPoint(m, x, y);
        const [x1, y1] = transformPoint(m, x + w, y);
        const [x2, y2] = transformPoint(m, x + w, y + h);
        const [x3, y3] = transformPoint(m, x, y + h);
        parts.push(`M ${fmtNum(x0)} ${fmtNum(y0)} L ${fmtNum(x1)} ${fmtNum(y1)} L ${fmtNum(x2)} ${fmtNum(y2)} L ${fmtNum(x3)} ${fmtNum(y3)} Z`);
        hasCurrent = true;
        cur = { x, y };
        sub = cur;
        break;
      }
    }
  }
  return parts.join(' ');
}

function sampleArc( cx, cy, r, a0, a1, ccw ){
  const out = [];
  let delta = a1 - a0;
  if( !ccw ){
    if( delta < 0 ) delta += Math.PI * 2;
  } else {
    if( delta > 0 ) delta -= Math.PI * 2;
  }
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 16)));
  for( let i = 0; i <= steps; i++ ){
    const a = a0 + delta * (i / steps);
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), first: i === 0 });
  }
  return out;
}

// Parse a CSS color string to extract opacity, leaving the rest as the value.
// Cytoscape always emits rgba(...) so this is the primary path.
function parseCssColor( color ){
  if( typeof color !== 'string' ){
    return { value: '#000000', opacity: 1 };
  }
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(color);
  if( rgba ){
    const r = Math.round(parseFloat(rgba[1]));
    const g = Math.round(parseFloat(rgba[2]));
    const b = Math.round(parseFloat(rgba[3]));
    const a = parseFloat(rgba[4]);
    return { value: `rgb(${r},${g},${b})`, opacity: a };
  }
  return { value: color, opacity: 1 };
}

export { SvgContext, Path2DShim };
