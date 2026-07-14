    import * as THREE from "three";
    import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

    // 2D-plane variant of the swarm hero (see swarm.js). Identical agent
    // behaviours, settings, and visual pipeline (bloom, depth of field,
    // chromatic aberration, coral cursor) — but the agents flow across a flat
    // viewport-filling plane instead of a sphere surface. Intended as a page
    // backdrop. This file is standalone and does not touch swarm.js.

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

    const MAXN = 5000;                 // hard ceiling on agents (buffers sized to this)

    // Live parameters — same set/values as the sphere hero. Units are world-space.
    const P = {
      count: 1000,
      maxSpeed: 0.009, maxForce: 0.0004, smoothing: 0.56,
      flowStrength: 2.0, flowScale: 0.45, flowSpeed: 0.005,
      sepStrength: 2.0, sepRadius: 0.2, sepEnabled: true,
      cohStrength: 1.75, cohRadius: 0.34, cohEnabled: true,
      aliStrength: 1.5, aliRadius: 0.26, aliEnabled: true,
      seekStrength: 2.0, seekRadius: 1.0, seekEnabled: true,
      lineLen: 0.035, agentAlpha: 0.55,
      coralRadius: 0.9,                  // agents within this of the cursor tint coral
      rotSpeed: 0.1, showSphere: false,  // rotSpeed unused on a plane (kept for parity)
      // optics
      caStrength: 0.009,                 // radial chromatic aberration (0 = off)
      dofEnabled: true, focalDist: 6.0, focalRange: 2.6, dofBlur: 0.3, // per-agent depth of field
      bloom: { threshold: 0.16, knee: 0.10, strength: 0.95, blurPx: 1.0, iterations: 2 },
    };
    const CONFIG = P; // bloom pipeline reads CONFIG.bloom

    // Plane geometry: agents live in a flat field centred at the focal plane,
    // with a shallow depth slab so per-agent depth of field still varies.
    const CAM_Z = 8.2;
    const PLANE_DEPTH = P.focalDist;         // agents' mean view-depth = focal distance
    const PLANE_Z = CAM_Z - PLANE_DEPTH;     // world z of the field's centre
    const DEPTH_SLAB = 1.3;                  // ± world-z spread → drives the DoF gradient
    const WRAP_MARGIN = 1.2;                 // wrap bounds extend past the viewport edges

    /* ============================================================
       Perlin gradient noise (from the reference), module-scoped
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

    // Flow field on the plane: 2D curl noise (divergence-free), so agents
    // follow the field's contours. The third noise axis (fdz) evolves the
    // field over time; fdx/fdy translate it.
    let fdx = 0, fdy = 0, fdz = 0;
    const EPS = 0.08;
    // writes normalized 2D flow direction into out[0..1]
    function flowDir(x, y, out) {
      const s = P.flowScale;
      const sx = x * s + fdx, sy = y * s + fdy;
      const dNdx = Noise.noise3(sx + EPS, sy, fdz) - Noise.noise3(sx - EPS, sy, fdz);
      const dNdy = Noise.noise3(sx, sy + EPS, fdz) - Noise.noise3(sx, sy - EPS, fdz);
      let fx = dNdy, fy = -dNdx;   // curl
      const m = Math.hypot(fx, fy);
      if (m > 1e-9) { fx /= m; fy /= m; }
      out[0] = fx; out[1] = fy;
    }

    /* ============================================================
       Scene + renderer
       ============================================================ */
    // Mount: prefer an explicit slot (#swarm-stage), then a hero section
    // (.mx-hero), then the standalone stage; only create a container as a last
    // resort. The canvas renders as a background layer filling the mount, so
    // page content sits on top (and mix-blend-mode overlays blend against it).
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
    renderer.setSize(_ms.w, _ms.h, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, _ms.w / _ms.h, 0.1, 100);
    camera.position.set(0, 0, CAM_Z);

    const sculpture = new THREE.Group();   // no rotation on the plane; kept for structure
    scene.add(sculpture);

    // Wrap bounds: the frustum half-extents at the field depth (+ margin).
    const EXT = { halfW: 3, halfH: 3 };
    function updateExtents() {
      const halfH = PLANE_DEPTH * Math.tan((camera.fov * Math.PI / 180) / 2) * WRAP_MARGIN;
      EXT.halfH = halfH;
      EXT.halfW = halfH * camera.aspect;
    }
    updateExtents();

    /* ============================================================
       Custom tight bloom (verbatim): scene → threshold → small fixed-pixel
       Gaussian → composite. Only bright agents glow; the void stays clean.
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
       Agent state (structure-of-arrays). Agents move in the plane (x, y);
       pz is a static per-agent depth within the slab (drives DoF only).
       ============================================================ */
    const px = new Float32Array(MAXN), py = new Float32Array(MAXN), pz = new Float32Array(MAXN);
    const vx = new Float32Array(MAXN), vy = new Float32Array(MAXN);
    const ax = new Float32Array(MAXN), ay = new Float32Array(MAXN);
    const sx = new Float32Array(MAXN), sy = new Float32Array(MAXN);  // smoothed accel
    const coralAmt = new Float32Array(MAXN);
    let initialized = 0;

    function initAgent(i) {
      px[i] = (Math.random() * 2 - 1) * EXT.halfW;
      py[i] = (Math.random() * 2 - 1) * EXT.halfH;
      pz[i] = PLANE_Z + (Math.random() * 2 - 1) * DEPTH_SLAB;   // static depth for DoF
      const a = Math.random() * Math.PI * 2, sp = (0.3 + Math.random() * 0.7) * P.maxSpeed;
      vx[i] = Math.cos(a) * sp; vy[i] = Math.sin(a) * sp;
      ax[i] = ay[i] = sx[i] = sy[i] = 0;
    }
    function ensureAgents(n) { for (; initialized < n; initialized++) initAgent(initialized); }
    function reseed() { Noise.seed(Date.now()); for (let i = 0; i < MAXN; i++) initAgent(i); initialized = MAXN; }
    ensureAgents(P.count);

    /* ============================================================
       Agents rendered as a streak + soft-glow hybrid with per-agent depth
       of field (identical shaders to the sphere hero). coc from camera depth.
       ============================================================ */
    const STREAK_FADE = 0.85;
    const dofU = { uFocalDist: { value: P.focalDist }, uFocalRange: { value: P.focalRange } };

    const segPos = new Float32Array(MAXN * 2 * 3);
    const segCol = new Float32Array(MAXN * 2 * 3);
    const agentGeo = new THREE.BufferGeometry();
    agentGeo.setAttribute("position", new THREE.BufferAttribute(segPos, 3));
    agentGeo.setAttribute("color", new THREE.BufferAttribute(segCol, 3));
    agentGeo.setDrawRange(0, P.count * 2);
    const streakMat = new THREE.ShaderMaterial({
      uniforms: { uFocalDist: dofU.uFocalDist, uFocalRange: dofU.uFocalRange, uStreakFade: { value: STREAK_FADE } },
      vertexShader: `
        attribute vec3 color;
        uniform float uFocalDist, uFocalRange, uStreakFade;
        varying vec3 vColor;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float coc = clamp(abs(-mv.z - uFocalDist) / uFocalRange, 0.0, 1.0);
          vColor = color * (1.0 - coc * uStreakFade);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    const agentLines = new THREE.LineSegments(agentGeo, streakMat);
    sculpture.add(agentLines);

    const pointPos = new Float32Array(MAXN * 3);
    const pointCol = new Float32Array(MAXN * 3);
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute("position", new THREE.BufferAttribute(pointPos, 3));
    pointGeo.setAttribute("color", new THREE.BufferAttribute(pointCol, 3));
    pointGeo.setDrawRange(0, P.count);
    const pointMat = new THREE.ShaderMaterial({
      uniforms: {
        uFocalDist: dofU.uFocalDist, uFocalRange: dofU.uFocalRange,
        uBaseSize: { value: 0.016 }, uBlurSize: { value: P.dofBlur },
        uScale: { value: 400 }, uGain: { value: 0.5 },
      },
      vertexShader: `
        attribute vec3 color;
        uniform float uFocalDist, uFocalRange, uBaseSize, uBlurSize, uScale;
        varying vec3 vColor; varying float vCoc;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float depth = -mv.z;
          float coc = clamp(abs(depth - uFocalDist) / uFocalRange, 0.0, 1.0);
          vCoc = coc;
          gl_PointSize = (uBaseSize + coc * uBlurSize) * uScale / depth;
          vColor = color;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uGain;
        varying vec3 vColor; varying float vCoc;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
          if (d > 1.0) discard;
          float a = exp(-d * d * 3.0);
          float energy = uGain / (1.0 + vCoc * 3.0);
          gl_FragColor = vec4(vColor * a * energy, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    const agentPoints = new THREE.Points(pointGeo, pointMat);
    sculpture.add(agentPoints);

    function updateOptics() { renderer.getDrawingBufferSize(_dbs); pointMat.uniforms.uScale.value = _dbs.y * 0.5; }
    updateOptics();

    const _c = new THREE.Color();
    function colorForSpeed(t) {
      _c.copy(MX.bone).lerp(MX.white, Math.min(1, t * 1.2));
      if (t > 0.75) _c.lerp(MX.coral, (t - 0.75) * 1.6);
      return _c;
    }

    /* ============================================================
       Interaction: cursor → seek target on the plane
       ============================================================ */
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2(0, 0);
    let pointerInside = false;
    const seekPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -PLANE_Z); // z = PLANE_Z
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
      if (!raycaster.ray.intersectPlane(seekPlane, _hit)) return;
      seekLocal.copy(_hit);   // group is identity → world == local
      seekActive = true;
    }

    /* ============================================================
       Simulation — flocking + 2D flow field on the plane
       ============================================================ */
    const _flow = [0, 0];
    const neigh = new Int32Array(MAXN);
    let grid = new Map();

    function buildGrid(cell) {
      grid.clear();
      const inv = 1 / cell;
      for (let i = 0; i < P.count; i++) {
        const k = ((Math.floor(px[i]*inv)) * 73856093 ^ (Math.floor(py[i]*inv)) * 19349663) >>> 0;
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(i);
      }
    }
    function gatherNeighbors(i, cell) {
      const inv = 1 / cell;
      const cx = Math.floor(px[i]*inv), cy = Math.floor(py[i]*inv);
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = (((cx+dx)) * 73856093 ^ ((cy+dy)) * 19349663) >>> 0;
        const arr = grid.get(k);
        if (!arr) continue;
        for (let a = 0; a < arr.length; a++) neigh[n++] = arr[a];
      }
      return n;
    }

    function simulate(dtN) {
      const N = P.count;
      const ms = P.maxSpeed, mf = P.maxForce, sm = P.smoothing;
      const flockOn = P.sepEnabled || P.cohEnabled || P.aliEnabled;
      const maxR = Math.max(P.sepEnabled ? P.sepRadius : 0, P.cohEnabled ? P.cohRadius : 0, P.aliEnabled ? P.aliRadius : 0, 0.06);
      const cell = maxR;
      const sepR2 = P.sepRadius*P.sepRadius, cohR2 = P.cohRadius*P.cohRadius, aliR2 = P.aliRadius*P.aliRadius;
      if (flockOn) buildGrid(cell);

      for (let i = 0; i < N; i++) {
        let axi = 0, ayi = 0;

        // --- flow field (2D curl noise) ---
        flowDir(px[i], py[i], _flow);
        {
          const dx = _flow[0]*ms - vx[i], dy = _flow[1]*ms - vy[i];
          let m = Math.hypot(dx, dy); if (m > mf) { const k = mf/m; axi += dx*k*P.flowStrength; ayi += dy*k*P.flowStrength; }
          else { axi += dx*P.flowStrength; ayi += dy*P.flowStrength; }
        }

        // --- seek toward the cursor point on the plane ---
        if (seekActive && P.seekEnabled) {
          const dx0 = seekLocal.x - px[i], dy0 = seekLocal.y - py[i];
          const dist = Math.hypot(dx0, dy0);
          if (dist > 1e-4 && dist < P.seekRadius) {
            const dvx = dx0/dist*ms - vx[i], dvy = dy0/dist*ms - vy[i];
            let m = Math.hypot(dvx, dvy); const k = m > mf ? mf/m : 1;
            axi += dvx*k*P.seekStrength; ayi += dvy*k*P.seekStrength;
          }
        }

        // --- flocking (separation / cohesion / alignment) ---
        if (flockOn) {
          const cnt = gatherNeighbors(i, cell);
          let spx=0,spy=0,sc=0, cpx=0,cpy=0,cc=0, apx=0,apy=0,acn=0;
          for (let q = 0; q < cnt; q++) {
            const b = neigh[q]; if (b === i) continue;
            const ddx = px[i]-px[b], ddy = py[i]-py[b];
            const d2 = ddx*ddx + ddy*ddy;
            if (P.sepEnabled && d2 < sepR2 && d2 > 1e-9) { const inv = 1/d2; spx += ddx*inv; spy += ddy*inv; sc++; }
            if (P.cohEnabled && d2 < cohR2) { cpx += px[b]; cpy += py[b]; cc++; }
            if (P.aliEnabled && d2 < aliR2) { apx += vx[b]; apy += vy[b]; acn++; }
          }
          if (sc > 0) { let m = Math.hypot(spx,spy); if (m>1e-9){ const dvx = spx/m*ms - vx[i], dvy = spy/m*ms - vy[i]; let mm = Math.hypot(dvx,dvy); const k = mm>mf?mf/mm:1; axi += dvx*k*P.sepStrength; ayi += dvy*k*P.sepStrength; } }
          if (cc > 0) { const tx = cpx/cc-px[i], ty = cpy/cc-py[i]; let m = Math.hypot(tx,ty); if (m>1e-9){ const dvx = tx/m*ms - vx[i], dvy = ty/m*ms - vy[i]; let mm = Math.hypot(dvx,dvy); const k = mm>mf?mf/mm:1; axi += dvx*k*P.cohStrength; ayi += dvy*k*P.cohStrength; } }
          if (acn > 0) { let m = Math.hypot(apx,apy); if (m>1e-9){ const dvx = apx/m*ms - vx[i], dvy = apy/m*ms - vy[i]; let mm = Math.hypot(dvx,dvy); const k = mm>mf?mf/mm:1; axi += dvx*k*P.aliStrength; ayi += dvy*k*P.aliStrength; } }
        }

        ax[i] = axi; ay[i] = ayi;
      }

      // integrate + wrap
      const hw = EXT.halfW, hh = EXT.halfH;
      for (let i = 0; i < N; i++) {
        sx[i] = sx[i]*sm + ax[i]*(1-sm); sy[i] = sy[i]*sm + ay[i]*(1-sm);
        vx[i] += sx[i]; vy[i] += sy[i];
        const sp = Math.hypot(vx[i], vy[i]);
        if (sp > ms) { const k = ms/sp; vx[i]*=k; vy[i]*=k; }
        px[i] += vx[i]*dtN; py[i] += vy[i]*dtN;
        if (px[i] < -hw) px[i] += 2*hw; else if (px[i] > hw) px[i] -= 2*hw;
        if (py[i] < -hh) py[i] += 2*hh; else if (py[i] > hh) py[i] -= 2*hh;
      }
      fdx += P.flowSpeed*0.9*dtN; fdy += P.flowSpeed*1.1*dtN; fdz += P.flowSpeed*0.7*dtN;
    }

    function writeAgentGeometry(dtN) {
      const N = P.count, ll = P.lineLen, ms = P.maxSpeed;
      const cr2 = P.coralRadius * P.coralRadius;
      const ease = Math.min(1, 0.12 * dtN);
      for (let i = 0; i < N; i++) {
        const sp = Math.hypot(vx[i], vy[i]);
        const inv = sp > 1e-6 ? 1/sp : 0;
        const hx = vx[i]*inv, hy = vy[i]*inv;
        const z = pz[i], o6 = i*6;
        segPos[o6] = px[i]; segPos[o6+1] = py[i]; segPos[o6+2] = z;
        segPos[o6+3] = px[i]+hx*ll; segPos[o6+4] = py[i]+hy*ll; segPos[o6+5] = z;

        // coral proximity in the plane (x, y)
        let target = 0;
        if (seekActive) {
          const dx = px[i]-seekLocal.x, dy = py[i]-seekLocal.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < cr2) { const t = 1 - Math.sqrt(d2/cr2); target = t*t*(3-2*t); }
        }
        coralAmt[i] += (target - coralAmt[i]) * ease;

        const col = colorForSpeed(sp/ms);
        if (coralAmt[i] > 0.001) col.lerp(MX.coral, coralAmt[i]);
        const alpha = P.agentAlpha * (1 + coralAmt[i] * 0.6);
        const r = col.r*alpha, g = col.g*alpha, b = col.b*alpha;
        segCol[o6] = r; segCol[o6+1] = g; segCol[o6+2] = b;
        segCol[o6+3] = r; segCol[o6+4] = g; segCol[o6+5] = b;
        const o3 = i*3;
        pointPos[o3] = px[i]; pointPos[o3+1] = py[i]; pointPos[o3+2] = z;
        pointCol[o3] = r; pointCol[o3+1] = g; pointCol[o3+2] = b;
      }
      agentGeo.setDrawRange(0, N*2);
      agentGeo.getAttribute("position").needsUpdate = true;
      agentGeo.getAttribute("color").needsUpdate = true;
      pointGeo.setDrawRange(0, N);
      pointGeo.getAttribute("position").needsUpdate = true;
      pointGeo.getAttribute("color").needsUpdate = true;
    }

    /* ============================================================
       Main loop
       ============================================================ */
    const clock = new THREE.Clock();

    function animate() {
      const dt = Math.min(clock.getDelta(), 0.05);
      const dtN = Math.min(dt * 60, 3);

      updateSeek();
      simulate(dtN);
      writeAgentGeometry(dtN);

      dofU.uFocalDist.value = P.focalDist;
      dofU.uFocalRange.value = Math.max(0.05, P.focalRange);
      streakMat.uniforms.uStreakFade.value = P.dofEnabled ? STREAK_FADE : 0.0;
      pointMat.uniforms.uBlurSize.value = P.dofBlur;
      agentPoints.visible = P.dofEnabled;

      renderBloom();

      requestAnimationFrame(animate);
    }
    animate();

    function onResize() {
      const s = mountSize();
      camera.aspect = s.w / s.h;
      camera.updateProjectionMatrix();
      updateExtents();
      renderer.setSize(s.w, s.h, false);
      sizeTargets();
      updateOptics();
    }
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(mount);
    window.addEventListener("resize", onResize);
