import { expect } from 'chai';
import cytoscape from '../src/test.mjs';

// The Mocha tests run in a headless Node environment with no DOM, so they
// can't actually render — they verify that cy.svg() exists and behaves
// consistently with the existing cy.png()/cy.jpg() error semantics. The
// substantive rendering tests live in playwright-tests/svg-export.spec.js
// and the visual-diff harness at debug/svg-export/index.html.
describe('Core SVG export', function(){

  let cy;

  beforeEach(function(done){
    cytoscape({
      styleEnabled: true,
      elements: {
        nodes: [
          { data: { id: 'n1' } }
        ]
      },
      ready: function(){
        cy = this;
        done();
      }
    });
  });

  afterEach(function(){
    cy.destroy();
  });

  it('exposes cy.svg() on the core API', function(){
    expect( cy.svg ).to.be.a('function');
  });

  it('throws on a headless instance', function(){
    // Mirrors the existing png/jpg tests: a headless cy has no renderer, so
    // cy.svg() must fail rather than return something silently wrong.
    expect(() => cy.svg()).to.throw;
  });

  it('throws on a headless instance even with options', function(){
    expect(() => cy.svg({ full: true, scale: 2, bg: '#fff' })).to.throw;
  });

});
