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
    const MAXN = 5000;                 // hard ceiling on agents (buffers sized to this)

    // Live parameters (bound to the slider panel). Units are sphere-local.
    const P = {
      count: 1500,
      maxSpeed: 0.009, maxForce: 0.0004, smoothing: 0.56,
      flowStrength: 2.0, flowScale: 0.45, flowSpeed: 0.005,
      sepStrength: 2.0, sepRadius: 0.2, sepEnabled: true,
      cohStrength: 1.75, cohRadius: 0.34, cohEnabled: true,
      aliStrength: 1.5, aliRadius: 0.26, aliEnabled: true,
      seekStrength: 2.0, seekRadius: 1.0, seekEnabled: true,
      lineLen: 0.035, agentAlpha: 0.55,
      coralRadius: 0.9,                  // agents within this of the cursor tint coral
      rotSpeed: 0.1, showSphere: false,
      // optics
      caStrength: 0.009,                 // radial chromatic aberration (0 = off)
      dofEnabled: true, focalDist: 6.0, focalRange: 2.6, dofBlur: 0.3, // per-agent depth of field
      bloom: { threshold: 0.16, knee: 0.10, strength: 0.95, blurPx: 1.0, iterations: 2 },
    };
    const CONFIG = P; // bloom pipeline reads CONFIG.bloom

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

    // Flow field on the sphere surface: curl of a noise potential, i.e.
    // tangent swirl = normal × ∇noise. Divergence-free, so agents follow
    // the field's contours and stay on the surface. Animated by drifting
    // the sample point through the noise volume over time.
    let fdx = 0, fdy = 0, fdz = 0;
    const EPS = 0.08;
    function pot(x, y, z) {
      const s = P.flowScale;
      return Noise.noise3(x * s + fdx, y * s + fdy, z * s + fdz);
    }
    // writes normalized tangent flow direction into out[0..2]
    function flowDir(x, y, z, out) {
      const gx = pot(x + EPS, y, z) - pot(x - EPS, y, z);
      const gy = pot(x, y + EPS, z) - pot(x, y - EPS, z);
      const gz = pot(x, y, z + EPS) - pot(x, y, z - EPS);
      const nx = x / SPHERE_R, ny = y / SPHERE_R, nz = z / SPHERE_R;
      // flow = n × g  (tangent to the sphere)
      let fx = ny * gz - nz * gy;
      let fy = nz * gx - nx * gz;
      let fz = nx * gy - ny * gx;
      const m = Math.hypot(fx, fy, fz);
      if (m > 1e-9) { fx /= m; fy /= m; fz /= m; }
      out[0] = fx; out[1] = fy; out[2] = fz;
    }

    /* ============================================================
       Scene + renderer
       ============================================================ */
    const stage = document.getElementById("stage");
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(MX.void, 1);
    stage.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 8.2);

    const sculpture = new THREE.Group();
    scene.add(sculpture);

    /* ============================================================
       Custom tight bloom (verbatim from the base prototype): scene →
       threshold → small fixed-pixel Gaussian → composite. Only the
       bright agents glow; the flat void stays clean.
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
       Agent state (structure-of-arrays for speed). Agents live on the
       sphere surface: position = surface point, velocity = tangent.
       ============================================================ */
    const px = new Float32Array(MAXN), py = new Float32Array(MAXN), pz = new Float32Array(MAXN);
    const vx = new Float32Array(MAXN), vy = new Float32Array(MAXN), vz = new Float32Array(MAXN);
    const ax = new Float32Array(MAXN), ay = new Float32Array(MAXN), az = new Float32Array(MAXN);
    const sx = new Float32Array(MAXN), sy = new Float32Array(MAXN), sz = new Float32Array(MAXN); // smoothed accel
    const coralAmt = new Float32Array(MAXN); // per-agent coral tint (eased toward cursor proximity)
    let initialized = 0;

    function initAgent(i) {
      // random point on the sphere
      let nx, ny, nz, m;
      do { nx = Math.random()*2-1; ny = Math.random()*2-1; nz = Math.random()*2-1; m = Math.hypot(nx,ny,nz); } while (m < 1e-3);
      nx /= m; ny /= m; nz /= m;
      px[i] = nx*SPHERE_R; py[i] = ny*SPHERE_R; pz[i] = nz*SPHERE_R;
      // random tangent velocity
      let rx = Math.random()*2-1, ry = Math.random()*2-1, rz = Math.random()*2-1;
      let tx = ny*rz - nz*ry, ty = nz*rx - nx*rz, tz = nx*ry - ny*rx;
      const tm = Math.hypot(tx,ty,tz) || 1;
      const sp = (0.3 + Math.random()*0.7) * P.maxSpeed;
      vx[i] = tx/tm*sp; vy[i] = ty/tm*sp; vz[i] = tz/tm*sp;
      ax[i]=ay[i]=az[i]=sx[i]=sy[i]=sz[i]=0;
    }
    function ensureAgents(n) { for (; initialized < n; initialized++) initAgent(initialized); }
    function reseed() { Noise.seed(Date.now()); for (let i = 0; i < MAXN; i++) initAgent(i); initialized = MAXN; }
    ensureAgents(P.count);

    /* ============================================================
       Agents rendered as a streak + soft-glow hybrid, with per-agent
       depth of field (Route A). Camera-space depth is computed in the
       vertex shaders (so it's correct through the group rotation) and a
       circle-of-confusion (coc) drives both layers:
         · streaks fade as they go out of focus (uStreakFade)
         · soft point sprites grow larger + dimmer with coc → bokeh
       In-focus agents read as crisp directional darts; out-of-focus ones
       melt into soft glowing points.
       ============================================================ */
    const STREAK_FADE = 0.85;
    const dofU = { uFocalDist: { value: P.focalDist }, uFocalRange: { value: P.focalRange } };

    // --- streak layer (velocity-aligned line, depth-faded) ---
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

    // --- soft-glow layer (point sprite, size/dimness driven by coc) ---
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
          float a = exp(-d * d * 3.0);                 // soft radial falloff
          float energy = uGain / (1.0 + vCoc * 3.0);   // bokeh spreads energy → dimmer when bigger
          gl_FragColor = vec4(vColor * a * energy, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    const agentPoints = new THREE.Points(pointGeo, pointMat);
    sculpture.add(agentPoints);

    // gl_PointSize perspective scale depends on the drawing-buffer height
    function updateOptics() { renderer.getDrawingBufferSize(_dbs); pointMat.uniforms.uScale.value = _dbs.y * 0.5; }
    updateOptics();

    // speed → colour: cool bone at rest, white at cruise, a coral tip when fast
    const _c = new THREE.Color();
    function colorForSpeed(t) {
      _c.copy(MX.bone).lerp(MX.white, Math.min(1, t * 1.2));
      if (t > 0.75) _c.lerp(MX.coral, (t - 0.75) * 1.6);
      return _c;
    }

    /* ============================================================
       Interaction: cursor → seek target on the sphere surface
       ============================================================ */
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2(0, 0);
    let pointerInside = false;
    const hoverSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), SPHERE_R);
    const _hit = new THREE.Vector3();
    const seekLocal = new THREE.Vector3();
    let seekActive = false;

    window.addEventListener("pointermove", (ev) => {
      pointerNDC.set((ev.clientX / window.innerWidth) * 2 - 1, -(ev.clientY / window.innerHeight) * 2 + 1);
      pointerInside = true;
    });
    window.addEventListener("pointerleave", () => { pointerInside = false; });

    // Resolve the cursor's surface point whenever the pointer is over the
    // sphere. Independent of the seek FORCE (P.seekEnabled) so the coral
    // proximity effect works even when steering is disabled.
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
       Simulation — flocking + flow field on the sphere
       ============================================================ */
    const _flow = [0, 0, 0];
    const neigh = new Int32Array(MAXN);
    let grid = new Map();

    function buildGrid(cell) {
      grid.clear();
      const inv = 1 / cell;
      for (let i = 0; i < P.count; i++) {
        const k = ((Math.floor(px[i]*inv)) * 73856093 ^ (Math.floor(py[i]*inv)) * 19349663 ^ (Math.floor(pz[i]*inv)) * 83492791) >>> 0;
        let arr = grid.get(k);
        if (!arr) { arr = []; grid.set(k, arr); }
        arr.push(i);
      }
    }
    function gatherNeighbors(i, cell) {
      const inv = 1 / cell;
      const cx = Math.floor(px[i]*inv), cy = Math.floor(py[i]*inv), cz = Math.floor(pz[i]*inv);
      let n = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const k = (((cx+dx)) * 73856093 ^ ((cy+dy)) * 19349663 ^ ((cz+dz)) * 83492791) >>> 0;
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
        let axi = 0, ayi = 0, azi = 0;

        // --- flow field (curl noise on the sphere) ---
        flowDir(px[i], py[i], pz[i], _flow);
        {
          const dx = _flow[0]*ms - vx[i], dy = _flow[1]*ms - vy[i], dz = _flow[2]*ms - vz[i];
          let m = Math.hypot(dx, dy, dz); if (m > mf) { const k = mf/m; axi += dx*k*P.flowStrength; ayi += dy*k*P.flowStrength; azi += dz*k*P.flowStrength; }
          else { axi += dx*P.flowStrength; ayi += dy*P.flowStrength; azi += dz*P.flowStrength; }
        }

        // --- seek toward the cursor's surface point ---
        if (seekActive && P.seekEnabled) {
          const dx0 = seekLocal.x - px[i], dy0 = seekLocal.y - py[i], dz0 = seekLocal.z - pz[i];
          const dist = Math.hypot(dx0, dy0, dz0);
          if (dist > 1e-4 && dist < P.seekRadius) {
            const dvx = dx0/dist*ms - vx[i], dvy = dy0/dist*ms - vy[i], dvz = dz0/dist*ms - vz[i];
            let m = Math.hypot(dvx, dvy, dvz); const k = m > mf ? mf/m : 1;
            axi += dvx*k*P.seekStrength; ayi += dvy*k*P.seekStrength; azi += dvz*k*P.seekStrength;
          }
        }

        // --- flocking (separation / cohesion / alignment) ---
        if (flockOn) {
          const cnt = gatherNeighbors(i, cell);
          let spx=0,spy=0,spz=0,sc=0, cpx=0,cpy=0,cpz=0,cc=0, apx=0,apy=0,apz=0,acn=0;
          for (let q = 0; q < cnt; q++) {
            const b = neigh[q]; if (b === i) continue;
            const ddx = px[i]-px[b], ddy = py[i]-py[b], ddz = pz[i]-pz[b];
            const d2 = ddx*ddx + ddy*ddy + ddz*ddz;
            if (P.sepEnabled && d2 < sepR2 && d2 > 1e-9) { const inv = 1/d2; spx += ddx*inv; spy += ddy*inv; spz += ddz*inv; sc++; }
            if (P.cohEnabled && d2 < cohR2) { cpx += px[b]; cpy += py[b]; cpz += pz[b]; cc++; }
            if (P.aliEnabled && d2 < aliR2) { apx += vx[b]; apy += vy[b]; apz += vz[b]; acn++; }
          }
          if (sc > 0) { let m = Math.hypot(spx,spy,spz); if (m>1e-9){ const dvx = spx/m*ms - vx[i], dvy = spy/m*ms - vy[i], dvz = spz/m*ms - vz[i]; let mm = Math.hypot(dvx,dvy,dvz); const k = mm>mf?mf/mm:1; axi += dvx*k*P.sepStrength; ayi += dvy*k*P.sepStrength; azi += dvz*k*P.sepStrength; } }
          if (cc > 0) { const tx = cpx/cc-px[i], ty = cpy/cc-py[i], tz = cpz/cc-pz[i]; let m = Math.hypot(tx,ty,tz); if (m>1e-9){ const dvx = tx/m*ms - vx[i], dvy = ty/m*ms - vy[i], dvz = tz/m*ms - vz[i]; let mm = Math.hypot(dvx,dvy,dvz); const k = mm>mf?mf/mm:1; axi += dvx*k*P.cohStrength; ayi += dvy*k*P.cohStrength; azi += dvz*k*P.cohStrength; } }
          if (acn > 0) { let m = Math.hypot(apx,apy,apz); if (m>1e-9){ const dvx = apx/m*ms - vx[i], dvy = apy/m*ms - vy[i], dvz = apz/m*ms - vz[i]; let mm = Math.hypot(dvx,dvy,dvz); const k = mm>mf?mf/mm:1; axi += dvx*k*P.aliStrength; ayi += dvy*k*P.aliStrength; azi += dvz*k*P.aliStrength; } }
        }

        ax[i] = axi; ay[i] = ayi; az[i] = azi;
      }

      // integrate
      for (let i = 0; i < N; i++) {
        sx[i] = sx[i]*sm + ax[i]*(1-sm); sy[i] = sy[i]*sm + ay[i]*(1-sm); sz[i] = sz[i]*sm + az[i]*(1-sm);
        vx[i] += sx[i]; vy[i] += sy[i]; vz[i] += sz[i];
        // keep velocity tangent to the sphere
        const nx = px[i]/SPHERE_R, ny = py[i]/SPHERE_R, nz = pz[i]/SPHERE_R;
        const vr = vx[i]*nx + vy[i]*ny + vz[i]*nz;
        vx[i] -= nx*vr; vy[i] -= ny*vr; vz[i] -= nz*vr;
        // limit speed
        const sp = Math.hypot(vx[i], vy[i], vz[i]);
        if (sp > ms) { const k = ms/sp; vx[i]*=k; vy[i]*=k; vz[i]*=k; }
        // move + re-project to the surface
        px[i] += vx[i]*dtN; py[i] += vy[i]*dtN; pz[i] += vz[i]*dtN;
        const L = Math.hypot(px[i], py[i], pz[i]) || 1; const k = SPHERE_R/L;
        px[i]*=k; py[i]*=k; pz[i]*=k;
      }
      fdx += P.flowSpeed*0.9*dtN; fdy += P.flowSpeed*1.1*dtN; fdz += P.flowSpeed*0.7*dtN;
    }

    function writeAgentGeometry(dtN) {
      const N = P.count, ll = P.lineLen, ms = P.maxSpeed;
      const cr2 = P.coralRadius * P.coralRadius;
      const ease = Math.min(1, 0.12 * dtN);          // gradual reveal/fade
      for (let i = 0; i < N; i++) {
        const sp = Math.hypot(vx[i], vy[i], vz[i]);
        const inv = sp > 1e-6 ? 1/sp : 0;
        const hx = vx[i]*inv, hy = vy[i]*inv, hz = vz[i]*inv;
        const o6 = i*6;
        segPos[o6] = px[i]; segPos[o6+1] = py[i]; segPos[o6+2] = pz[i];
        segPos[o6+3] = px[i]+hx*ll; segPos[o6+4] = py[i]+hy*ll; segPos[o6+5] = pz[i]+hz*ll;

        // coral proximity: target rises smoothly toward the cursor, eased over time
        let target = 0;
        if (seekActive) {
          const dx = px[i]-seekLocal.x, dy = py[i]-seekLocal.y, dz = pz[i]-seekLocal.z;
          const d2 = dx*dx + dy*dy + dz*dz;
          if (d2 < cr2) { const t = 1 - Math.sqrt(d2/cr2); target = t*t*(3-2*t); } // smoothstep falloff
        }
        coralAmt[i] += (target - coralAmt[i]) * ease;

        const col = colorForSpeed(sp/ms);
        if (coralAmt[i] > 0.001) col.lerp(MX.coral, coralAmt[i]);
        const alpha = P.agentAlpha * (1 + coralAmt[i] * 0.6);   // coral agents pop a little
        const r = col.r*alpha, g = col.g*alpha, b = col.b*alpha;
        segCol[o6] = r; segCol[o6+1] = g; segCol[o6+2] = b;
        segCol[o6+3] = r; segCol[o6+4] = g; segCol[o6+5] = b;
        const o3 = i*3;
        pointPos[o3] = px[i]; pointPos[o3+1] = py[i]; pointPos[o3+2] = pz[i];
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
      const dtN = Math.min(dt * 60, 3);           // frame-rate-normalized step

      updateSeek();
      simulate(dtN);
      writeAgentGeometry(dtN);

      // optics uniforms (live from sliders)
      dofU.uFocalDist.value = P.focalDist;
      dofU.uFocalRange.value = Math.max(0.05, P.focalRange);
      streakMat.uniforms.uStreakFade.value = P.dofEnabled ? STREAK_FADE : 0.0;
      pointMat.uniforms.uBlurSize.value = P.dofBlur;
      agentPoints.visible = P.dofEnabled;

      // slow idle rotation for depth (view-only; sim runs in local space)
      if (!REDUCE) sculpture.rotation.y += P.rotSpeed * dtN * 0.01;

      renderBloom();

      requestAnimationFrame(animate);
    }
    animate();

    window.addEventListener("resize", () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      sizeTargets();
      updateOptics();
    });
  