    import * as THREE from "three";
    import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

    const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /* ============================================================
       MORPHXGEN palette (linear THREE.Colors)
       ============================================================ */
    const MX = {
      void:  new THREE.Color(0x222222),
      bone:  new THREE.Color(0xe4e3df),
      white: new THREE.Color(0xffffff),
      coral: new THREE.Color(0xe48484),
      amber: new THREE.Color(0xdd7d56),
      blue:  new THREE.Color(0x6b95c2),
    };

    const SPHERE_R = 2.4;
    const MAXN = 4000;                 // hard ceiling on glyph cells (buffers sized to this)

    // Live parameters. Units are sphere-local (sphere radius 2.4; camera z 8.2, fov 45).
    const P = {
      count: 900,                        // number of glyph cells on the sphere
      flowScale: 0.5, flowSpeed: 0.006,  // noise field: spatial scale + drift speed
      valueContrast: 1.5,                // maps raw noise (~[-0.7,0.7]) → [0,1] spread
      glyphSize: 0.5, glyphAlpha: 0.5,   // base sprite size (world) + overall opacity
      coralRadius: 0.9,                  // cells within this of the cursor tint coral
      rotSpeed: 0.1, showSphere: false,
      // optics (shared with the swarm engine)
      caStrength: 0.009,                 // radial chromatic aberration (0 = off)
      dofEnabled: true, focalDist: 6.0, focalRange: 2.6, dofGrow: 1.2, // per-cell depth of field
      bloom: { threshold: 0.16, knee: 0.10, strength: 0.95, blurPx: 1.0, iterations: 2 },
    };
    const CONFIG = P; // bloom pipeline reads CONFIG.bloom

    /* ============================================================
       Perlin gradient noise (verbatim from swarm.js), module-scoped
       ============================================================ */
    const Noise = (() => {
      const perm = new Uint8Array(512);
      const grad3 = [
        [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
        [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
        [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
      ];
      function seed(s) {
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        for (let i = 255; i > 0; i--) {
          s = (s * 16807 + 0) % 2147483647;
          const j = s % (i + 1);
          [p[i], p[j]] = [p[j], p[i]];
        }
        for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
      }
      seed(Date.now());
      const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
      const dot3 = (g, x, y, z) => g[0]*x + g[1]*y + g[2]*z;
      const lerp = (a, b, t) => a + t * (b - a);
      function noise3(x, y, z) {
        const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
        x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
        const u = fade(x), v = fade(y), w = fade(z);
        const A = perm[X]+Y, AA = perm[A]+Z, AB = perm[A+1]+Z;
        const B = perm[X+1]+Y, BA = perm[B]+Z, BB = perm[B+1]+Z;
        return lerp(
          lerp(lerp(dot3(grad3[perm[AA]%12],x,y,z), dot3(grad3[perm[BA]%12],x-1,y,z),u),
               lerp(dot3(grad3[perm[AB]%12],x,y-1,z), dot3(grad3[perm[BB]%12],x-1,y-1,z),u),v),
          lerp(lerp(dot3(grad3[perm[AA+1]%12],x,y,z-1), dot3(grad3[perm[BA+1]%12],x-1,y,z-1),u),
               lerp(dot3(grad3[perm[AB+1]%12],x,y-1,z-1), dot3(grad3[perm[BB+1]%12],x-1,y-1,z-1),u),v),w);
      }
      return { noise3, seed };
    })();

    // Scalar field driving the glyphs: the noise potential the swarm's curl
    // flow is derived from (curl = normal × ∇pot). Here we read the raw
    // potential — a single smooth float per point — and animate it by drifting
    // the sample point through the noise volume over time.
    let fdx = 0, fdy = 0, fdz = 0;
    function pot(x, y, z) {
      const s = P.flowScale;
      return Noise.noise3(x * s + fdx, y * s + fdy, z * s + fdz);
    }

    /* ============================================================
       Scene + renderer  (verbatim embedding logic from swarm.js)
       ============================================================ */
    let mount = document.getElementById("swarm-stage") || document.querySelector(".mx-hero") || document.getElementById("stage");
    let createdMount = false;
    if (!mount) {
      mount = document.createElement("div");
      mount.id = "swarm-stage";
      mount.style.cssText = "position:relative;width:100%;height:100vh;background:#222222;overflow:hidden";
      const host = document.querySelector(".mx-page") || document.body;
      host.insertBefore(mount, host.firstChild);
      createdMount = true;
    }
    if (getComputedStyle(mount).position === "static") mount.style.position = "relative";
    mount.style.isolation = "isolate";
    const mountSize = () => ({ w: Math.max(1, mount.clientWidth), h: Math.max(1, mount.clientHeight) });

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(MX.void, 1);
    renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none";
    if (!createdMount) {
      for (const child of Array.from(mount.children)) {
        if (getComputedStyle(child).position === "static") child.style.position = "relative";
      }
    }
    mount.insertBefore(renderer.domElement, mount.firstChild);

    let _ms = mountSize();
    renderer.setSize(_ms.w, _ms.h, false);   // false → keep our 100% CSS sizing

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, _ms.w / _ms.h, 0.1, 100);
    camera.position.set(0, 0, 8.2);

    const sculpture = new THREE.Group();
    scene.add(sculpture);

    /* ============================================================
       Custom tight bloom (verbatim from swarm.js): scene → threshold →
       small fixed-pixel Gaussian → composite (with chromatic aberration).
       ============================================================ */
    const VERT = "attribute vec3 position;\nattribute vec2 uv;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\nvarying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }";
    const thresholdQuad = new FullScreenQuad(new THREE.RawShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0 }, uKnee: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDiffuse; uniform float uThreshold; uniform float uKnee;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float f = smoothstep(uThreshold, uThreshold + uKnee, l);
          gl_FragColor = vec4(c * f, 1.0);
        }`,
    }));
    const blurQuad = new FullScreenQuad(new THREE.RawShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDiffuse; uniform vec2 uDir;
        varying vec2 vUv;
        void main() {
          vec3 s = texture2D(tDiffuse, vUv).rgb * 0.227027;
          s += texture2D(tDiffuse, vUv + uDir * 1.0).rgb * 0.1945946;
          s += texture2D(tDiffuse, vUv - uDir * 1.0).rgb * 0.1945946;
          s += texture2D(tDiffuse, vUv + uDir * 2.0).rgb * 0.1216216;
          s += texture2D(tDiffuse, vUv - uDir * 2.0).rgb * 0.1216216;
          s += texture2D(tDiffuse, vUv + uDir * 3.0).rgb * 0.0540540;
          s += texture2D(tDiffuse, vUv - uDir * 3.0).rgb * 0.0540540;
          s += texture2D(tDiffuse, vUv + uDir * 4.0).rgb * 0.0162162;
          s += texture2D(tDiffuse, vUv - uDir * 4.0).rgb * 0.0162162;
          gl_FragColor = vec4(s, 1.0);
        }`,
    }));
    const compositeQuad = new FullScreenQuad(new THREE.RawShaderMaterial({
      uniforms: { tScene: { value: null }, tGlow: { value: null }, uStrength: { value: 0 }, uCA: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: `
        precision highp float;
        uniform sampler2D tScene; uniform sampler2D tGlow; uniform float uStrength; uniform float uCA;
        varying vec2 vUv;
        vec3 toSRGB(vec3 c) {
          return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
        }
        vec3 sceneAt(vec2 uv) { return texture2D(tScene, uv).rgb + texture2D(tGlow, uv).rgb * uStrength; }
        void main() {
          // radial chromatic aberration: split channels along the vector from
          // screen centre, growing toward the edges (0 at centre)
          vec2 off = (vUv - 0.5) * uCA;
          vec3 cR = sceneAt(vUv + off);
          vec3 cG = sceneAt(vUv);
          vec3 cB = sceneAt(vUv - off);
          gl_FragColor = vec4(toSRGB(vec3(cR.r, cG.g, cB.b)), 1.0);
        }`,
    }));
    const rtScene   = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const rtBrightA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    const rtBrightB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    const _dbs = new THREE.Vector2();
    function sizeTargets() {
      renderer.getDrawingBufferSize(_dbs);
      const fw = Math.max(1, _dbs.x | 0), fh = Math.max(1, _dbs.y | 0);
      rtScene.setSize(fw, fh);
      rtBrightA.setSize(Math.max(1, fw >> 1), Math.max(1, fh >> 1));
      rtBrightB.setSize(Math.max(1, fw >> 1), Math.max(1, fh >> 1));
    }
    sizeTargets();
    function renderBloom() {
      const B = CONFIG.bloom;
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);
      thresholdQuad.material.uniforms.tDiffuse.value = rtScene.texture;
      thresholdQuad.material.uniforms.uThreshold.value = B.threshold;
      thresholdQuad.material.uniforms.uKnee.value = B.knee;
      renderer.setRenderTarget(rtBrightA);
      thresholdQuad.render(renderer);
      const bw = rtBrightA.width, bh = rtBrightA.height;
      for (let i = 0; i < B.iterations; i++) {
        blurQuad.material.uniforms.tDiffuse.value = rtBrightA.texture;
        blurQuad.material.uniforms.uDir.value.set(B.blurPx / bw, 0);
        renderer.setRenderTarget(rtBrightB);
        blurQuad.render(renderer);
        blurQuad.material.uniforms.tDiffuse.value = rtBrightB.texture;
        blurQuad.material.uniforms.uDir.value.set(0, B.blurPx / bh);
        renderer.setRenderTarget(rtBrightA);
        blurQuad.render(renderer);
      }
      compositeQuad.material.uniforms.tScene.value = rtScene.texture;
      compositeQuad.material.uniforms.tGlow.value = rtBrightA.texture;
      compositeQuad.material.uniforms.uStrength.value = B.strength;
      compositeQuad.material.uniforms.uCA.value = P.caStrength;
      renderer.setRenderTarget(null);
      compositeQuad.render(renderer);
    }

    /* ============================================================
       Faint reference sphere (icosahedron wireframe) — hints the form
       ============================================================ */
    const sphereWire = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(SPHERE_R, 4)),
      new THREE.LineBasicMaterial({
        color: MX.bone.clone().multiplyScalar(0.05),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    sphereWire.visible = P.showSphere;
    sculpture.add(sphereWire);

    /* ============================================================
       Glyph atlas — the eight SVGs in glyphs/, rasterized into one
       texture. Ordered low→high visual "density" so the noise value
       reads as an ascii-style gradient (quiet marks → busy marks).
       `currentColor` is forced white; per-cell tint happens in-shader.
       ============================================================ */
    const A_COLS = 4, A_ROWS = 2, CELL = 128;   // 4×2 grid of 128px cells → 512×256 atlas (power-of-two)
    const GLYPH_SVGS = [
      // 0 — crosshair (sparsest)
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><circle cx="32" cy="32" r="2.6" fill="currentColor" stroke="none"></circle><line x1="32" y1="8" x2="32" y2="24"></line><line x1="32" y1="40" x2="32" y2="56"></line><line x1="8" y1="32" x2="24" y2="32"></line><line x1="40" y1="32" x2="56" y2="32"></line><line x1="10" y1="10" x2="18" y2="10"></line><line x1="10" y1="10" x2="10" y2="18"></line><line x1="54" y1="10" x2="46" y2="10"></line><line x1="54" y1="10" x2="54" y2="18"></line><line x1="10" y1="54" x2="18" y2="54"></line><line x1="10" y1="54" x2="10" y2="46"></line><line x1="54" y1="54" x2="46" y2="54"></line><line x1="54" y1="54" x2="54" y2="46"></line></svg>`,
      // 1 — arcs
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><path d="M 18 32 A 14 14 0 0 1 46 32"></path><path d="M 12 32 A 20 20 0 0 1 52 32"></path><path d="M 6 32 A 26 26 0 0 1 58 32"></path><circle cx="32" cy="32" r="2.4" fill="currentColor" stroke="none"></circle></svg>`,
      // 2 — scatter
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><circle cx="52" cy="32" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="49.32" cy="42" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="42" cy="49.32" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="32" cy="52" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="22" cy="49.32" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="14.68" cy="42" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="12" cy="32" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="14.68" cy="22" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="22" cy="14.68" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="32" cy="12" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="42" cy="14.68" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="49.32" cy="22" r="2.4" fill="currentColor" stroke="none"></circle><circle cx="32" cy="32" r="1.8" fill="currentColor" stroke="none"></circle></svg>`,
      // 3 — sphere
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><circle cx="32" cy="32" r="22"></circle><ellipse cx="32" cy="32" rx="8" ry="22"></ellipse><ellipse cx="32" cy="32" rx="16" ry="22"></ellipse><ellipse cx="32" cy="32" rx="22" ry="8"></ellipse></svg>`,
      // 4 — dashring
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><line x1="54" y1="32" x2="53.84" y2="34.68"></line><line x1="53.25" y1="37.69" x2="52.4" y2="40.24"></line><line x1="51.05" y1="43" x2="49.57" y2="45.24"></line><line x1="47.56" y1="47.56" x2="45.54" y2="49.34"></line><line x1="43" y1="51.05" x2="40.6" y2="52.25"></line><line x1="37.69" y1="53.25" x2="35.06" y2="53.79"></line><line x1="32" y1="54" x2="29.32" y2="53.84"></line><line x1="26.31" y1="53.25" x2="23.76" y2="52.4"></line><line x1="21" y1="51.05" x2="18.76" y2="49.57"></line><line x1="16.44" y1="47.56" x2="14.66" y2="45.54"></line><line x1="12.95" y1="43" x2="11.75" y2="40.6"></line><line x1="10.75" y1="37.69" x2="10.21" y2="35.06"></line><line x1="10" y1="32" x2="10.16" y2="29.32"></line><line x1="10.75" y1="26.31" x2="11.6" y2="23.76"></line><line x1="12.95" y1="21" x2="14.43" y2="18.76"></line><line x1="16.44" y1="16.44" x2="18.46" y2="14.66"></line><line x1="21" y1="12.95" x2="23.4" y2="11.75"></line><line x1="26.31" y1="10.75" x2="28.94" y2="10.21"></line><line x1="32" y1="10" x2="34.68" y2="10.16"></line><line x1="37.69" y1="10.75" x2="40.24" y2="11.6"></line><line x1="43" y1="12.95" x2="45.24" y2="14.43"></line><line x1="47.56" y1="16.44" x2="49.34" y2="18.46"></line><line x1="51.05" y1="21" x2="52.25" y2="23.4"></line><line x1="53.25" y1="26.31" x2="53.79" y2="28.94"></line></svg>`,
      // 5 — hexnet
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><line x1="52" y1="32" x2="32" y2="32"></line><line x1="42" y1="49.32" x2="32" y2="32"></line><line x1="22" y1="49.32" x2="32" y2="32"></line><line x1="12" y1="32" x2="32" y2="32"></line><line x1="22" y1="14.68" x2="32" y2="32"></line><line x1="42" y1="14.68" x2="32" y2="32"></line><polygon points="52,32 42,49.32 22,49.32 12,32 22,14.68 42,14.68"></polygon><circle cx="52" cy="32" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="42" cy="49.32" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="22" cy="49.32" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="32" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="22" cy="14.68" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="42" cy="14.68" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="32" cy="32" r="2.6" fill="currentColor" stroke="none"></circle></svg>`,
      // 6 — voronoi
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><polygon points="56,32 44,52.78 20,52.78 8,32 20,11.22 44,11.22"></polygon><line x1="34" y1="28" x2="56" y2="32"></line><line x1="34" y1="28" x2="20" y2="52.78"></line><line x1="34" y1="28" x2="20" y2="11.22"></line><line x1="26" y1="40" x2="8" y2="32"></line><line x1="26" y1="40" x2="44" y2="11.22"></line><line x1="34" y1="28" x2="26" y2="40"></line><circle cx="34" cy="28" r="2.2" fill="currentColor" stroke="none"></circle><circle cx="26" cy="40" r="2.2" fill="currentColor" stroke="none"></circle></svg>`,
      // 7 — lattice (densest)
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"><line x1="14" y1="14" x2="50" y2="14"></line><line x1="14" y1="32" x2="50" y2="32"></line><line x1="14" y1="50" x2="50" y2="50"></line><line x1="14" y1="14" x2="14" y2="50"></line><line x1="32" y1="14" x2="32" y2="50"></line><line x1="50" y1="14" x2="50" y2="50"></line><line x1="14" y1="14" x2="50" y2="50"></line><line x1="50" y1="14" x2="14" y2="50"></line><circle cx="14" cy="14" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="32" cy="14" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="50" cy="14" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="14" cy="32" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="32" cy="32" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="50" cy="32" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="14" cy="50" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="32" cy="50" r="2.6" fill="currentColor" stroke="none"></circle><circle cx="50" cy="50" r="2.6" fill="currentColor" stroke="none"></circle></svg>`,
    ];
    const N_GLYPHS = GLYPH_SVGS.length;

    const atlasCanvas = document.createElement("canvas");
    atlasCanvas.width = A_COLS * CELL;
    atlasCanvas.height = A_ROWS * CELL;
    const actx = atlasCanvas.getContext("2d");
    const atlasTex = new THREE.CanvasTexture(atlasCanvas);
    atlasTex.flipY = false;                       // canvas row 0 = atlas row 0 (matches gl_PointCoord)
    atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
    atlasTex.magFilter = THREE.LinearFilter;
    atlasTex.generateMipmaps = true;
    atlasTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // Rasterize each SVG (browser does the vector work) into its atlas cell.
    GLYPH_SVGS.forEach((svg, i) => {
      const img = new Image();
      img.onload = () => {
        const cx = (i % A_COLS) * CELL, cy = Math.floor(i / A_COLS) * CELL;
        const pad = 12;
        actx.drawImage(img, cx + pad, cy + pad, CELL - 2 * pad, CELL - 2 * pad);
        atlasTex.needsUpdate = true;
      };
      img.src = "data:image/svg+xml;utf8," + encodeURIComponent(svg.replace(/currentColor/g, "#ffffff"));
    });

    /* ============================================================
       Glyph cells — a Fibonacci-sphere point set. Each cell is one
       billboarded sprite (a THREE.Points vertex); the atlas UV, size,
       colour and depth-of-field are all resolved per-vertex in-shader.
       Structure-of-arrays, sized to MAXN.
       ============================================================ */
    const cellPos = new Float32Array(MAXN * 3);   // static surface point
    const glyphIdx = new Float32Array(MAXN);      // which glyph (0..N_GLYPHS-1), attribute
    const cellCol  = new Float32Array(MAXN * 3);  // per-cell tint × brightness, attribute
    const valEased = new Float32Array(MAXN);      // smoothed noise value (drives glyph + brightness)
    const coralAmt = new Float32Array(MAXN);      // per-cell coral tint, eased toward cursor proximity

    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
    function initCells() {
      const N = Math.min(P.count, MAXN);
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / Math.max(1, N - 1)) * 2;   // 1 → -1
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = i * GOLDEN_ANGLE;
        const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
        const o3 = i * 3;
        cellPos[o3] = x * SPHERE_R; cellPos[o3 + 1] = y * SPHERE_R; cellPos[o3 + 2] = z * SPHERE_R;
        glyphIdx[i] = 0; cellCol[o3] = cellCol[o3 + 1] = cellCol[o3 + 2] = 0;
        valEased[i] = 0.5; coralAmt[i] = 0;
      }
    }
    initCells();

    const glyphGeo = new THREE.BufferGeometry();
    glyphGeo.setAttribute("position", new THREE.BufferAttribute(cellPos, 3));
    glyphGeo.setAttribute("color", new THREE.BufferAttribute(cellCol, 3));
    glyphGeo.setAttribute("aGlyph", new THREE.BufferAttribute(glyphIdx, 1));
    glyphGeo.setDrawRange(0, P.count);

    // One sprite per cell: gl_PointSize gives the billboard, gl_PointCoord
    // indexes the atlas cell. Depth of field (shared "Route A" with the
    // swarm): camera-space depth → circle-of-confusion grows the sprite and
    // dims it, so defocused glyphs melt into soft glow that the bloom catches.
    const glyphMat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: atlasTex },
        uCols: { value: A_COLS }, uRows: { value: A_ROWS },
        uFocalDist: { value: P.focalDist }, uFocalRange: { value: P.focalRange },
        uGlyphSize: { value: P.glyphSize }, uDofGrow: { value: P.dofGrow },
        uScale: { value: 400 }, uGain: { value: 0.9 },
      },
      vertexShader: `
        attribute vec3 color;
        attribute float aGlyph;
        uniform float uFocalDist, uFocalRange, uGlyphSize, uDofGrow, uScale;
        varying vec3 vColor; varying float vCoc; varying float vGlyph;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float depth = -mv.z;
          float coc = clamp(abs(depth - uFocalDist) / uFocalRange, 0.0, 1.0);
          // hemisphere fade: cells on the far side of the sphere turn away from
          // the camera and are hidden, so glyphs read as a display on the
          // visible surface and don't pile into a bright silhouette rim
          vec3 nrm = normalize(normalMatrix * normalize(position));
          float facing = smoothstep(-0.05, 0.5, nrm.z);
          vCoc = coc; vColor = color * facing; vGlyph = aGlyph;
          float sz = uGlyphSize * uScale / depth * (1.0 + coc * uDofGrow);
          gl_PointSize = clamp(sz, 2.0, 160.0);   // clamp guards small GPU point-size caps
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uAtlas; uniform float uCols, uRows, uGain;
        varying vec3 vColor; varying float vCoc; varying float vGlyph;
        void main() {
          // index into the atlas cell, then sample within it via gl_PointCoord
          float g = floor(vGlyph + 0.5);
          float col = mod(g, uCols);
          float row = floor(g / uCols);
          vec2 uv = (vec2(col, row) + gl_PointCoord) / vec2(uCols, uRows);
          float a = texture2D(uAtlas, uv).a;             // glyph coverage (white-on-transparent)
          float energy = uGain / (1.0 + vCoc * 3.0);     // bokeh spreads energy → dimmer when bigger
          vec3 c = vColor * a * energy;
          if (max(max(c.r, c.g), c.b) < 0.002) discard;
          gl_FragColor = vec4(c, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    const glyphPoints = new THREE.Points(glyphGeo, glyphMat);
    sculpture.add(glyphPoints);

    // gl_PointSize perspective scale depends on the drawing-buffer height
    function updateOptics() { renderer.getDrawingBufferSize(_dbs); glyphMat.uniforms.uScale.value = _dbs.y * 0.5; }
    updateOptics();

    // value → colour: bone at low density, warming to white as it climbs
    const _c = new THREE.Color();
    function colorForValue(t) {
      _c.copy(MX.bone).lerp(MX.white, Math.min(1, t * 1.1));
      return _c;
    }

    /* ============================================================
       Interaction: cursor → surface point (coral proximity tint)
       ============================================================ */
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2(0, 0);
    let pointerInside = false;
    const hoverSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), SPHERE_R);
    const _hit = new THREE.Vector3();
    const seekLocal = new THREE.Vector3();
    let seekActive = false;

    window.addEventListener("pointermove", (ev) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointerNDC.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      pointerInside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    });
    window.addEventListener("pointerleave", () => { pointerInside = false; });

    function updateSeek() {
      seekActive = false;
      if (!pointerInside) return;
      raycaster.setFromCamera(pointerNDC, camera);
      if (!raycaster.ray.intersectSphere(hoverSphere, _hit)) return;
      seekLocal.copy(_hit);
      sculpture.worldToLocal(seekLocal);
      seekActive = true;
    }

    /* ============================================================
       Field update — sample the drifting noise at each cell, pick the
       glyph from an ascii-style density ramp, and drive brightness.
       ============================================================ */
    function updateField(dtN) {
      const N = P.count;
      const ease = Math.min(1, 0.1 * dtN);
      const cr2 = P.coralRadius * P.coralRadius;
      const contrast = P.valueContrast;
      for (let i = 0; i < N; i++) {
        const o3 = i * 3;
        const x = cellPos[o3], y = cellPos[o3 + 1], z = cellPos[o3 + 2];

        // scalar noise value → [0,1], eased over time so glyph swaps and
        // brightness stay smooth (no per-frame flicker)
        let n01 = pot(x, y, z) * contrast + 0.5;
        n01 = n01 < 0 ? 0 : n01 > 1 ? 1 : n01;
        valEased[i] += (n01 - valEased[i]) * ease;
        const t = valEased[i];

        // glyph selection: density ramp across the atlas
        let gi = Math.floor(t * N_GLYPHS);
        if (gi > N_GLYPHS - 1) gi = N_GLYPHS - 1; else if (gi < 0) gi = 0;
        glyphIdx[i] = gi;

        // coral proximity: target rises smoothly toward the cursor, eased over time
        let target = 0;
        if (seekActive) {
          const dx = x - seekLocal.x, dy = y - seekLocal.y, dz = z - seekLocal.z;
          const d2 = dx*dx + dy*dy + dz*dz;
          if (d2 < cr2) { const s = 1 - Math.sqrt(d2 / cr2); target = s*s*(3 - 2*s); } // smoothstep falloff
        }
        coralAmt[i] += (target - coralAmt[i]) * ease;

        const col = colorForValue(t);
        if (coralAmt[i] > 0.001) col.lerp(MX.coral, coralAmt[i]);
        // brightness/opacity from the value: quiet marks dim, dense marks bright
        const alpha = P.glyphAlpha * (0.18 + 0.95 * t) * (1 + coralAmt[i] * 0.6);
        cellCol[o3] = col.r * alpha; cellCol[o3 + 1] = col.g * alpha; cellCol[o3 + 2] = col.b * alpha;
      }
      glyphGeo.setDrawRange(0, N);
      glyphGeo.getAttribute("color").needsUpdate = true;
      glyphGeo.getAttribute("aGlyph").needsUpdate = true;

      // drift the noise sample point (same cadence as the swarm's flow field)
      fdx += P.flowSpeed * 0.9 * dtN; fdy += P.flowSpeed * 1.1 * dtN; fdz += P.flowSpeed * 0.7 * dtN;
    }

    /* ============================================================
       Main loop
       ============================================================ */
    const clock = new THREE.Clock();
    function animate() {
      const dt = Math.min(clock.getDelta(), 0.05);
      const dtN = Math.min(dt * 60, 3);           // frame-rate-normalized step

      updateSeek();
      updateField(dtN);

      // optics uniforms
      glyphMat.uniforms.uFocalDist.value = P.focalDist;
      glyphMat.uniforms.uFocalRange.value = Math.max(0.05, P.focalRange);
      glyphMat.uniforms.uGlyphSize.value = P.glyphSize;
      glyphMat.uniforms.uDofGrow.value = P.dofEnabled ? P.dofGrow : 0.0;

      // slow idle rotation for depth (view-only; field is sampled in local space)
      if (!REDUCE) sculpture.rotation.y += P.rotSpeed * dtN * 0.01;

      renderBloom();
      requestAnimationFrame(animate);
    }
    animate();

    function onResize() {
      const s = mountSize();
      camera.aspect = s.w / s.h;
      camera.updateProjectionMatrix();
      renderer.setSize(s.w, s.h, false);
      sizeTargets();
      updateOptics();
    }
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(mount);
    window.addEventListener("resize", onResize);
