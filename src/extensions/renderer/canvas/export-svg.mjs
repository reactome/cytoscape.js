import * as is from '../../../is.mjs';
import { SvgContext, Path2DShim } from './svg-context.mjs';

const CRp = {};

CRp.bufferSvgImage = function( options ){
  const cy = this.cy;
  const eles = cy.mutableElements();
  const bb = eles.boundingBox();
  const ctrRect = this.findContainerClientCoords();

  let width = options.full ? Math.ceil( bb.w ) : ctrRect[2];
  let height = options.full ? Math.ceil( bb.h ) : ctrRect[3];
  let scale = 1;

  const specdMaxDims = is.number( options.maxWidth ) || is.number( options.maxHeight );
  if( options.scale !== undefined ){
    width *= options.scale;
    height *= options.scale;
    scale = options.scale;
  } else if( specdMaxDims ){
    let maxScaleW = Infinity;
    let maxScaleH = Infinity;
    if( is.number( options.maxWidth ) ) maxScaleW = scale * options.maxWidth / width;
    if( is.number( options.maxHeight ) ) maxScaleH = scale * options.maxHeight / height;
    scale = Math.min( maxScaleW, maxScaleH );
    width *= scale;
    height *= scale;
  }
  // SVG is resolution-independent; do not multiply by pxRatio.

  const svgCtx = new SvgContext( width, height, {
    embedImages: options.embedImages !== false,
  });

  const r = this;

  // Run with usePaths disabled so the renderer takes the non-Path2D code
  // path. Also override globalThis.Path2D with our shim so any unconditional
  // `new Path2D()` (e.g. drawing-nodes.mjs:298) records into our shim.
  const prevEnabled = r.path2dEnabled();
  const prevPath2D = (typeof globalThis !== 'undefined') ? globalThis.Path2D : undefined;
  // Per-element pathCache may hold native Path2D instances from prior renders;
  // drawing-images.mjs:152 reads rs.pathCache outside the usePaths gate. Clear
  // them so the export takes the non-cached drawing path.
  const clearedPathCaches = [];
  eles.forEach(ele => {
    const rs = ele[0]._private.rscratch;
    if( rs && rs.pathCache ){
      clearedPathCaches.push([rs, rs.pathCache, rs.pathCacheKey]);
      rs.pathCache = null;
      rs.pathCacheKey = null;
    }
  });

  try {
    r.path2dEnabled( false );
    if( typeof globalThis !== 'undefined' ){
      globalThis.Path2D = Path2DShim;
    }

    if( width > 0 && height > 0 ){
      const zsortedEles = this.getCachedZSortedEles();

      if( options.full ){
        svgCtx.translate( -bb.x1 * scale, -bb.y1 * scale );
        svgCtx.scale( scale, scale );
        this.drawElements( svgCtx, zsortedEles );
        svgCtx.scale( 1/scale, 1/scale );
        svgCtx.translate( bb.x1 * scale, bb.y1 * scale );
      } else {
        const pan = cy.pan();
        const translation = { x: pan.x * scale, y: pan.y * scale };
        const finalScale = scale * cy.zoom();
        svgCtx.translate( translation.x, translation.y );
        svgCtx.scale( finalScale, finalScale );
        this.drawElements( svgCtx, zsortedEles );
        svgCtx.scale( 1/finalScale, 1/finalScale );
        svgCtx.translate( -translation.x, -translation.y );
      }
    }
  } finally {
    r.path2dEnabled( prevEnabled );
    if( typeof globalThis !== 'undefined' ){
      if( prevPath2D === undefined ){
        delete globalThis.Path2D;
      } else {
        globalThis.Path2D = prevPath2D;
      }
    }
    // Restore previously-cleared pathCache values so future renders aren't
    // forced to rebuild them.
    for( const [rs, pc, pck] of clearedPathCaches ){
      rs.pathCache = pc;
      rs.pathCacheKey = pck;
    }
  }

  return {
    svg: svgCtx,
    width,
    height,
    bg: options.bg,
  };
};

CRp.svg = function( options ){
  options = options || {};
  const buffer = this.bufferSvgImage( options );
  return buffer.svg.toSVG({ bg: buffer.bg });
};

export default CRp;
