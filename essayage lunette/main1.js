// main1.js — Exact outward temple opening to ear landmarks, axis-aware
// Enhanced with: inverted glasses detection/correction + depth-based visibility control
import * as THREE from "three"
import { GLTFLoader } from "jsm/loaders/GLTFLoader.js"
import { RGBELoader } from "jsm/loaders/RGBELoader.js"


function loadHDRI({ url, rotateRad = 0, setAsBackground = false } = {}) {
  // Si le renderer/pmrem n'est pas prêt, on met en file d'attente
  if (!_state.renderer) { _state._queuedHDRI = { url, rotateRad, setAsBackground }; return }
  if (!_state.pmrem) {
    _state.pmrem = new THREE.PMREMGenerator(_state.renderer)
    _state.pmrem.compileEquirectangularShader()
  }

  new RGBELoader()
    .load(
      url,
      (hdrTex) => {
        // optionnel: tourne la softbox
        if (hdrTex.center) hdrTex.center.set(-0.5, 0.5)
        if ('rotation' in hdrTex) hdrTex.rotation = rotateRad

        const envMap = _state.pmrem.fromEquirectangular(hdrTex).texture
        hdrTex.dispose()

        _state.envMap = envMap
        _state.scene.environment = envMap
        if (setAsBackground) _state.scene.background = envMap

        if (_state.lunettes) _applyEnvIntensity(_state.lunettes)
      },
      undefined,
      (err) => console.error("HDRI load error:", err)
    )
}


function _applyEnvIntensity(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      const name = (o.name || o.material?.name || "").toLowerCase()
      const isLens = name.includes("lens") || name.includes("verre")
      o.material.envMapIntensity = isLens ? 1.3 : 1.0
      if (o.material.isMeshPhysicalMaterial && isLens) {
        o.material.transmission ??= 0.95
        o.material.ior ??= 1.52
        o.material.thickness ??= 2.5
        o.material.roughness = Math.min(o.material.roughness ?? 0.05, 0.08)
      }
      o.material.needsUpdate = true
    }
  })
}


/* ===================== Public API ===================== */
export function initTryOn({
  canvas,
  mirrorPreview = () => false,
  models = {
    glasses1: "./glasses.glb",
    glasses2: "./rayban_black.glb",
    glasses3: "./glasses3.glb",
    glasses4: "./glasses4.glb",
    glasses5: "./glasses5.glb",
  },
  currentModel = "glasses2",
} = {}) {
  _state.canvas = canvas
  _state.mirrorPreviewFn = mirrorPreview
  _state.models = models
  _state.currentModel = currentModel
  initThree()
  loadHDRI({ url: "hay_bales_2k.hdr", rotateRad: 0, setAsBackground: false })

  loadModel(currentModel)
}

export function updateTryOn({
  landmarks, rot9, w, h, mirrorPreview, timestampMs,
  tvec,          // {x,y,z} in mm (OpenCV camera coords)
  intrinsics,    // {fx, fy, cx, cy}
}) {
  // MàJ intrinsics / tailles
  _state.srcW = w;
  _state.srcH = h;
  if (intrinsics?.fx) _state.fx = intrinsics.fx;
  if (intrinsics?.fy) _state.fy = intrinsics.fy;

  // Si pas de modèle ou pas de pose: on tente quand même un render (pour effacer frame précédente)
  if (!landmarks || !rot9 || !_state.lunettes) {
    if (_state.renderer && _state.scene && _state.camera) {
      _state.renderer.render(_state.scene, _state.camera);
    }
    return;
  }

  // Pipeline 3D (poses, scale, temples, etc.)
  _frameTo3D({ landmarks, rot9, mirrorPreview, timestampMs, tvec });

  // ⚡️ Rendu unique, ici, à la fin (PAS de boucle RAF ailleurs)
  if (_state.renderer && _state.scene && _state.camera) {
    _state.renderer.render(_state.scene, _state.camera);
  }
}


/* ===================== Landmarks ===================== */
const LM = {
  LEFT_CORNER: 33,
  RIGHT_CORNER: 263,
  TEMPLE_LEFT: 127,
  TEMPLE_RIGHT: 356,
  CENTER_STABLE: 168,
  LEFT_EAR_TOP: 234,
  RIGHT_EAR_TOP: 454,
}

/* ===================== Config ===================== */
const CONFIG = {
  fitting: {
    preferredPair: [LM.TEMPLE_LEFT, LM.TEMPLE_RIGHT],
    fallbackPair: [LM.LEFT_CORNER, LM.RIGHT_CORNER],
    beyondPct: 0.08,
    defaultTemplePaddingPct: 0.2,
  },

  autoPadding: { enabled:true, baseMin:0.05, baseMax:0.16, yawThreshold:0.9 },

  // Depth visibility control: hide glasses if too far (>120cm) or too close (<10cm)
  depth: { 
    enabled: true, 
    zBlend: 0.95, 
    minZmm: 120,    // closest allowed: 12cm
    maxZmm: 2000,   // farthest allowed: 200cm
    hideIfTooFar: 1200,   // hide if > 120cm
    hideIfTooClose: 100,  // hide if < 10cm
    smoothHideMs: 100,    // smooth fade in/out
  },

  yawScaling: { enabled: false, yawMax:0.9, gain:0.0 },

  bridge: { offsetFromWidthPct:-0.06 },

  // EXACT hinge opening solver. Uses per-side axis and auto-picks sign that opens *outward*.
 /* templesDynamic: {
    enabled: true,
    axisLeft:  "localY",   // localX | localY | localZ (use the hinge axis your model uses)
    axisRight: "localY",
    maxAngleDeg: 0,       // clamp for realism
    flipLeft:  false,      // hint only; solver tests both signs and chooses outward
    flipRight: true,
    smoothMs: 50,
    angleOffsetDeg: -10,          // smoothing for angle changes
  },
*/

templesDynamic: {
  enabled: true,
  axisLeft:  "localY",
  axisRight: "localY",
  maxAngleDeg: -10,     // mets une vraie limite (ex. 25°)
  flipLeft:  false,
  flipRight: true,
  smoothMs: 50,
  angleOffsetDeg: -10,
  hardStick: false,    // <— NEW: micro-collage “dur” (voir commentaire dans apply)
},

  filters: {
    enabled: true,
    freq: false,
    pos:   { minCutoff: 2.4, beta: 0.22, dCutoff: 3.0 },
    rot:   { minCutoff: 2.0, beta: 0.22, dCutoff: 3.0 },
    scale: { minCutoff: 1.8, beta: 0.16, dCutoff: 3.0 },
  },
  softness: { rotMs: 0, posMs: 0, scaleMs: 6},
  stability: { posDeadbandWorld: 0, rotDeadbandDeg: 0, scaleDeadbandPct: 0 },
  templesFade: { enabled: true, deadband: 0.02, blendMs: 0, minScaleVisible: 0.01, yawSmoothMs: 4 },

  globalScale: 0.90,
  eyeMinPaddingPct: 0.02,

  offsets: { x:0.0, y:0.0, z:0.0, maxYaw:1.2, sideViewOffset:{ x:-0.7, y:0, z:0 } },
}

/* ===================== Internal State ===================== */
const _state = {
  canvas:null, mirrorPreviewFn:()=>false, models:null, currentModel:"glasses2",
  scene:null, renderer:null, camera:null, aspect:1, d:10,
  lunettes:null, modelBaseWidth:0,
  pmrem: null, envMap: null,

  _queuedHDRI: null, // si loadHDRI est appelé trop tôt

  branchLeft:null, branchRight:null,
  branchLeftBaseQ:null, branchRightBaseQ:null,

  // Inverted detection flag
  isInverted: false,

  // Cached local-space "tip" points for each temple
  leftTipLocal:null,
  rightTipLocal:null,

  // Current temple angles (deg) and the sign the solver used
  currentLeftAngle: 0,
  currentRightAngle: 0,
  currentLeftSign: 1,
  currentRightSign: 1,

  // Fade state
  applyLeftScale: 1.0,
  applyRightScale: 1.0,
  smoothedYaw: null,

  // Depth-based visibility state
  depthVisibility: 1.0,  // 0=hidden, 1=visible

  // Light anti-jitter for width (median of last 3)
  widthBuf: [],

  // Filters
  fPosX:null, fPosY:null,
  fYaw:null, fPitch:null, fRoll:null,
  fScale:null,

  haveFilteredQ:false, filteredQ:new THREE.Quaternion(),
  posXS:null, posYS:null, lastScale:null, lastTs:0,
  srcW:0, srcH:0, fx:0, fy:0,
  depthCalibrated:false, cz:1.0,
}

/* ===================== Three Setup with Enhanced Lighting ===================== */
function initThree() {
  const cv = _state.canvas;
  _state.scene = new THREE.Scene();
  _state.aspect = cv.clientWidth / cv.clientHeight;

  // Ortho camera
  _state.camera = new THREE.OrthographicCamera(
    -_state.d * _state.aspect,  _state.d * _state.aspect,
     _state.d,                  -_state.d,
     0.1, 1000
  );
  _state.camera.position.z = 10;

  // Renderer (no continuous loop; we'll render in updateTryOn)
  const isAndroid = /Android/i.test(navigator.userAgent);

  _state.renderer = new THREE.WebGLRenderer({
    canvas: cv,
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });

  // Cap DPR pour éviter la surcharge sur Android
  const dprCap = isAndroid ? 1.5 : 2.0;
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, dprCap));
  _state.renderer.setPixelRatio(dpr);

  _state.renderer.setSize(cv.clientWidth, cv.clientHeight);
   // Compat r14x–r15x :
 _state.renderer.outputEncoding = THREE.sRGBEncoding; // (ou outputColorSpace = SRGBColorSpace)

  // Tone mapping + lights allégés sur Android
  if (isAndroid) {
    _state.renderer.toneMapping = THREE.NoToneMapping;
  } else {
    _state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _state.renderer.toneMappingExposure = 1.2;
  }

  // Lighting (plus léger sur Android)
  const ambientLight = new THREE.AmbientLight(0xffffff, isAndroid ? 0.8 : 0.6);


  if (!isAndroid) {
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.4);
    dir2.position.set(5, 0, 5);
    _state.scene.add(dir2);

    const dir3 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir3.position.set(0, -2, -5);
    _state.scene.add(dir3);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
    hemi.position.set(0, 10, 0);
    _state.scene.add(hemi);
  }

  function onResize() {
    _state.aspect = cv.clientWidth / cv.clientHeight;
    _state.camera.left   = -_state.d * _state.aspect;
    _state.camera.right  =  _state.d * _state.aspect;
    _state.camera.top    =  _state.d;
    _state.camera.bottom = -_state.d;
    _state.camera.updateProjectionMatrix();
    _state.renderer.setSize(cv.clientWidth, cv.clientHeight);
  }
  window.addEventListener("resize", onResize);
  onResize();

  // ⛔️ Plus de boucle RAF ici. Le rendu se fera dans updateTryOn().
}

/* ... (other imports and code unchanged, including CONFIG with angleOffsetDeg: -8, templesFade: { deadband: 0.10, blendMs: 10 }) ... */

/* ===================== Model Loading with Inversion Detection ===================== */
const _loader = new GLTFLoader()
const NAME_LEFT  = ["mat_branch_left","branch_left","temple_left","left_temple","L_temple"]
const NAME_RIGHT = ["mat_branch_right","branch_right","temple_right","right_temple","R_temple"]

function loadModel(name) {
  if (_state.lunettes) {
    _state.scene.remove(_state.lunettes)
    _state.lunettes = null
    _state.modelBaseWidth = 0
  }
  _state.branchLeft = _state.branchRight = null
  _state.branchLeftBaseQ = _state.branchRightBaseQ = null
  _state.depthCalibrated = false
  _state.cz = 1.0
  _state.applyLeftScale = 1.0
  _state.applyRightScale = 1.0
  _state.smoothedYaw = null
  _state.widthBuf = []
  _state.currentLeftAngle = 0
  _state.currentRightAngle = 0
  _state.currentLeftSign = 1
  _state.currentRightSign = 1
  _state.leftTipLocal = null
  _state.rightTipLocal = null
  _state.isInverted = false
  _state.depthVisibility = 1.0
  _resetFilters()

  _loader.load(
    _state.models[name],
    (gltf) => {
      const root = gltf.scene
      root.scale.set(1,1,1)
      root.rotation.set(0,0,0)
      root.visible = false // Hide model until orientation is verified

      // Prefer OBJECT names (Blender outliner)
      root.traverse((node) => {
        if (!node || !node.name) return
        if (!_state.branchLeft  && NAME_LEFT.includes(node.name))  _state.branchLeft  = node
        if (!_state.branchRight && NAME_RIGHT.includes(node.name)) _state.branchRight = node
      })
      // Fallback via MATERIAL names
      root.traverse((child) => {
        if (child.isMesh && child.material) {
          const m = child.material.name || ""
          if (!_state.branchLeft  && m === "mat_branch_left")  _state.branchLeft  = child
          if (!_state.branchRight && m === "mat_branch_right") _state.branchRight = child
          if (child.material) child.material.needsUpdate = true
        }
      })

      _state.scene.add(root)
      _state.lunettes = root

      // Ensure transforms updated before computing bounds
      _state.scene.updateMatrixWorld(true)

      // Force initial orientation and verify
      root.rotation.x = Math.PI // Start with a flip to test correction
      _state.scene.updateMatrixWorld(true)

      // ===== INVERSION DETECTION & CORRECTION =====
      if (_state.branchLeft && _state.branchRight) {
        detectAndCorrectInversion()
      } else {
        // Fallback: Use bounding box to check orientation
        correctOrientationByBoundingBox()
      }
      // ===== /INVERSION DETECTION =====

      // Save base orientations AFTER potential correction
      _state.branchLeftBaseQ  = _state.branchLeft  ? _state.branchLeft.quaternion.clone()  : null
      _state.branchRightBaseQ = _state.branchRight ? _state.branchRight.quaternion.clone() : null

      // Cache tip points (local space) for each temple
      _state.leftTipLocal  = _state.branchLeft  ? _estimateTempleTipLocal(_state.branchLeft)  : null
      _state.rightTipLocal = _state.branchRight ? _estimateTempleTipLocal(_state.branchRight) : null

      // Width for on-face scaling (exclude temples if possible)
      _state.modelBaseWidth = _computeFrontFrameWidth(root)
      if (_state.modelBaseWidth <= 0) _state.modelBaseWidth = _computeFullWidth(root)

      // Make model visible after orientation correction
      root.visible = true
    },
    undefined,
    (err) => console.error("GLTF load error:", err),
  )
}

/**
 * INVERSION DETECTION & CORRECTION
 * Rule 1: Left branch should be on RIGHT side of screen (positive X), right branch on LEFT (negative X)
 * Rule 2: Top of model (e.g., frame) should have higher Y than bottom in world space
 */
function detectAndCorrectInversion() {
  if (!_state.branchLeft || !_state.branchRight || !_state.lunettes) return

  // Get world positions of temples
  _state.lunettes.updateMatrixWorld(true)
  
  const leftPos = new THREE.Vector3()
  const rightPos = new THREE.Vector3()
  _state.branchLeft.getWorldPosition(leftPos)
  _state.branchRight.getWorldPosition(rightPos)

  // Check left/right inversion: left branch should have positive X, right should have negative X
  const isLRInverted = leftPos.x < rightPos.x
  let corrected = false

  if (isLRInverted) {
    console.log("⚠️ Left/Right inversion detected! Correcting orientation...")
    _state.isInverted = true
    _state.lunettes.rotation.y = Math.PI // Rotate 180° around Y axis
    _state.lunettes.updateMatrixWorld(true)
    corrected = true
  }

  // Check up/down inversion: use bounding box Y-extent
  const box = new THREE.Box3().setFromObject(_state.lunettes)
  console.log("Bounding Box:", box.min, box.max); // Debug bounding box
  const isUpsideDown = box.max.y < box.min.y

  if (isUpsideDown) {
    console.log("⚠️ Upside-down orientation detected! Correcting orientation...")
    _state.lunettes.rotation.x = Math.PI // Rotate 180° around X-axis to flip vertically
    _state.lunettes.updateMatrixWorld(true)
    corrected = true
  }

  // Verify final orientation (optional landmark-based check if available)
  if (!corrected && _state.lunettes) {
    const centerPos = new THREE.Vector3()
    _state.lunettes.getWorldPosition(centerPos)
    console.log("Model Center Y:", centerPos.y, "Expected Y Range:", [0, 20]); // Adjust range based on face position
    if (centerPos.y < -10) { // Arbitrary threshold, adjust based on your setup
      console.log("⚠️ Final orientation check failed! Forcing correction...")
      _state.lunettes.rotation.x += Math.PI
      _state.lunettes.updateMatrixWorld(true)
      corrected = true
    }
  }

  if (corrected) {
    console.log("✓ Glasses orientation corrected")
  } else {
    console.log("✓ Glasses orientation is correct")
    _state.isInverted = false
  }
}

/**
 * Fallback orientation correction using bounding box if temples are not detected
 */
function correctOrientationByBoundingBox() {
  if (!_state.lunettes) return

  _state.lunettes.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(_state.lunettes)
  console.log("Bounding Box (Fallback):", box.min, box.max); // Debug bounding box
  const isUpsideDown = box.max.y < box.min.y

  if (isUpsideDown) {
    console.log("⚠️ Upside-down orientation detected (bounding box)! Correcting orientation...")
    _state.lunettes.rotation.x = Math.PI // Rotate 180° around X-axis
    _state.lunettes.updateMatrixWorld(true)
    console.log("✓ Glasses orientation corrected")
  } else {
    console.log("✓ Glasses orientation is correct (bounding box)")
  }
}

/* ... (rest of the code unchanged, including applyExactTempleOpening with angleOffsetDeg and templesFade logic) ... */

function _computeFrontFrameWidth(root) {
  const box = new THREE.Box3()
  let any=false
  root.traverse((child)=>{
    if (child.isMesh) {
      const nm = (child.name||"").toLowerCase()
      if (nm.includes("branch") || nm.includes("temple")) return
      if (child.visible === false) return
      child.geometry.computeBoundingBox()
      const bb = child.geometry.boundingBox.clone()
      child.updateWorldMatrix(true,false)
      bb.applyMatrix4(child.matrixWorld)
      if(!any){box.copy(bb); any=true}else{box.union(bb)}
    }
  })
  return any ? box.max.x - box.min.x : 0
}
function _computeFullWidth(root) {
  return new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).x
}

/* ===================== Helpers ===================== */
const _R = new THREE.Matrix4()
const _C = new THREE.Matrix4().makeScale(1,-1,-1)
const _MirrorX = new THREE.Matrix4().makeScale(-1,1,1)

function _rot9ToQuaternion(rot9, mirrorPreview){
  _R.set(rot9[0],rot9[1],rot9[2],0, rot9[3],rot9[4],rot9[5],0, rot9[6],rot9[7],rot9[8],0, 0,0,0,1)
  const R3_basis = _C.clone().multiply(_R).multiply(_C)
  const R3_final = mirrorPreview ? _MirrorX.clone().multiply(R3_basis).multiply(_MirrorX) : R3_basis
  return new THREE.Quaternion().setFromRotationMatrix(R3_final)
}

function _normToWorld(xNorm, yNorm, mirrorPreview){
  const cssW=_state.canvas.clientWidth||1, cssH=_state.canvas.clientHeight||1
  const srcW=_state.srcW||cssW, srcH=_state.srcH||cssH
  const x = mirrorPreview ? 1 - xNorm : xNorm
  const scale=Math.max(cssW/srcW, cssH/srcH)
  const drawW=srcW*scale, drawH=srcH*scale
  const dx=(cssW-drawW)*0.5, dy=(cssH-drawH)*0.5
  const xScreen=dx+x*drawW, yScreen=dy+yNorm*drawH
  const xNdc=xScreen/cssW,   yNdc=yScreen/cssH
  return { x:(xNdc-0.5)*(_state.aspect*20), y:-(yNdc-0.5)*20 }
}

// Compute temple bounds in the temple's local space
function _computeBoundsInLocal(rootObj) {
  const bb = new THREE.Box3()
  let any = false
  const invRootWorld = rootObj.matrixWorld.clone().invert()
  rootObj.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const geom = child.geometry
      if (!geom.boundingBox) geom.computeBoundingBox()
      const gbb = geom.boundingBox.clone()
      const childLocalToRootLocal = invRootWorld.clone().multiply(child.matrixWorld)
      gbb.applyMatrix4(childLocalToRootLocal)
      if (!any) { bb.copy(gbb); any = true } else { bb.union(gbb) }
    }
  })
  if (!any) {
    return new THREE.Box3(new THREE.Vector3(-0.01, -0.01, -0.01), new THREE.Vector3(0.01, 0.01, 0.01))
  }
  return bb
}

// Estimate the temple tip (farthest bbox corner from hinge/origin) in local space
function _estimateTempleTipLocal(templeObj) {
  const bb = _computeBoundsInLocal(templeObj)
  const corners = [
    new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z),
    new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z),
    new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
    new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z),
    new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z),
    new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
    new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
    new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
  ]
  let best = corners[0], bestD2 = best.lengthSq()
  for (let i = 1; i < corners.length; i++) {
    const d2 = corners[i].lengthSq()
    if (d2 > bestD2) { best = corners[i]; bestD2 = d2 }
  }
  return best.clone()
}

function _axisVec(which) {
  return which==="localX" ? new THREE.Vector3(1,0,0)
       : which==="localY" ? new THREE.Vector3(0,1,0)
       :                    new THREE.Vector3(0,0,1) // localZ
}

/**
 * Solve theta so temple tip x aligns with ear x (world), rotating around *local AXIS*.
 * We try BOTH rotation directions and choose the one that:
 *   1) matches the ear x distance, and
 *   2) keeps the tip on the SAME side of the face center as the ear (forces outward opening).
 * Returns { theta, sideSign } where 'sideSign' is the sign that produced the best (outward) match.
 */
function _solveTempleAngleForX_Axis(
  templeObj, baseQ, tipLocal,
  earWorldX, centerWorldX,
  localAxisVec, initialSideSign, maxAngleDeg = 45
){
  const parentMW = templeObj.parent ? templeObj.parent.matrixWorld.clone() : new THREE.Matrix4()
  const T = new THREE.Matrix4().makeTranslation(templeObj.position.x, templeObj.position.y, templeObj.position.z)
  const Rbase = new THREE.Matrix4().makeRotationFromQuaternion(baseQ)
  const S = new THREE.Matrix4().makeScale(templeObj.scale.x, templeObj.scale.y, templeObj.scale.z)

  // Hinge world position
  const hingeMW = parentMW.clone().multiply(T)
  const hingeWorld = new THREE.Vector3().setFromMatrixPosition(hingeMW)
  const targetDx = earWorldX - hingeWorld.x

  const tipWorld = new THREE.Vector3()
  const mat = new THREE.Matrix4()
  const axis = localAxisVec.clone().normalize()

  function f(thetaRad, sideSign) {
    const qRot = new THREE.Quaternion().setFromAxisAngle(axis, sideSign * thetaRad)
    const Rrot = new THREE.Matrix4().makeRotationFromQuaternion(qRot)
    mat.copy(parentMW).multiply(T).multiply(Rbase).multiply(Rrot).multiply(S)
    tipWorld.copy(tipLocal).applyMatrix4(mat)
    return (tipWorld.x - hingeWorld.x) - targetDx
  }

  function solveForSign(sideSign) {
    const maxRad = THREE.MathUtils.degToRad(Math.max(1, maxAngleDeg))
    const a = -maxRad, b = maxRad, N = 24
    // Coarse scan
    let bestTheta = a, bestErr = Math.abs(f(a, sideSign))
    for (let i = 1; i <= N; i++) {
      const t = a + (i / N) * (b - a)
      const ft = f(t, sideSign)
      const err = Math.abs(ft)
      if (err < bestErr) { bestErr = err; bestTheta = t }
    }
    // Narrow bracket around best
    let left = Math.max(-maxRad, bestTheta - (b - a) / N)
    let right = Math.min(maxRad, bestTheta + (b - a) / N)
    let fl = f(left, sideSign), fr = f(right, sideSign)
    if (fl * fr <= 0) {
      // Bisection
      for (let i = 0; i < 10; i++) {
        const mid = 0.5 * (left + right)
        const fm = f(mid, sideSign)
        if (fl * fm <= 0) { right = mid; fr = fm } else { left = mid; fl = fm }
      }
      bestTheta = 0.5 * (left + right)
      bestErr = Math.abs(f(bestTheta, sideSign))
    }
    // Enforce OUTWARD opening: tip and ear must be on same side of face center
    f(bestTheta, sideSign) // updates tipWorld
    const outwardOk = (tipWorld.x - centerWorldX) * (earWorldX - centerWorldX) >= 0
    const outwardPenalty = outwardOk ? 0 : 1e6 // huge penalty if inward
    const score = bestErr + outwardPenalty
    return { theta: bestTheta, score, sideSign }
  }

  // Try both directions: configured hint and its opposite
  const cand1 = solveForSign(initialSideSign)
  const cand2 = solveForSign(-initialSideSign)
  return (cand1.score <= cand2.score) ? cand1 : cand2
}



function _solveTempleAngleForPoint({
  branch,           // THREE.Object3D branche (pivot = charnière)
  baseQ,            // THREE.Quaternion pose de base (fermée)
  tipLocal,         // THREE.Vector3 position locale du tip (en pose base)
  axisLocal,        // THREE.Vector3 axe local unitaire (charnière)
  targetWorld,      // THREE.Vector3 cible monde (x,y du point jaune; z = z du pivot)
  maxAngleDeg = 25, // clamp mécanique
}) {
  // Quaternion monde de la pose base = parent ⊗ baseQ
  const qParent = new THREE.Quaternion()
  branch.parent?.getWorldQuaternion(qParent)
  const qBaseWorld = qParent.clone().multiply(baseQ)

  // Monde -> localBase
  const invQ = qBaseWorld.clone().invert()
  const pivotWorld = new THREE.Vector3()
  branch.getWorldPosition(pivotWorld)

  // vecteur pivot->cible en monde
  const toTargetWorld = targetWorld.clone().sub(pivotWorld)
  // on le ramène en localBase
  const toTargetLocal = toTargetWorld.clone().applyQuaternion(invQ)

  // Décompose sur axe / plan
  const a = axisLocal.clone().normalize()
  const proj = (v) => a.clone().multiplyScalar(v.dot(a))
  const perp = (v) => v.clone().sub(proj(v))

  const p0       = tipLocal.clone()
  const p0_perp  = perp(p0)
  const t_perp   = perp(toTargetLocal)

  const r0 = p0_perp.length()
  const rT = t_perp.length()
  if (r0 < 1e-6 || rT < 1e-6) return { theta: 0, sideSign: 1 } // dégénéré

  const u = p0_perp.clone().normalize() // direction actuelle dans le plan
  const v = t_perp.clone().normalize()  // direction cible dans le plan

  const dot = THREE.MathUtils.clamp(u.dot(v), -1, 1)
  const cross = new THREE.Vector3().crossVectors(u, v)
  const sign = Math.sign(cross.dot(a)) || 1
  const theta = sign * Math.acos(dot)

  const thetaClamped = THREE.MathUtils.clamp(
    theta,
    -THREE.MathUtils.degToRad(maxAngleDeg),
    +THREE.MathUtils.degToRad(maxAngleDeg)
  )
  return { theta: thetaClamped, sideSign: sign }
}

// Median of up to 3 numbers (tiny anti-jitter)
function median3Push(buf, v) {
  buf.push(v); if (buf.length > 3) buf.shift()
  const a = buf.slice().sort((x,y)=>x-y)
  const n = a.length
  return n===0 ? v : a[Math.floor(n/2)]
}

// Angle between quaternions, radians
function quatAngleRad(a, b) {
  const d = Math.min(1, Math.max(-1, Math.abs(a.dot(b))))
  return 2 * Math.acos(d)
}

/* ===================== One Euro Filter ===================== */
class OneEuroFilter {
  constructor({ freq=60, minCutoff=1.0, beta=0.0, dCutoff=1.0 } = {}) {
    this.freq = freq
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
    this._xPrev = null
    this._dxPrev = 0
    this._tPrev = null
  }
  setFrequency(freq) { this.freq = Math.max(1e-3, freq) }
  _alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff)
    return 1.0 / (1.0 + tau / Math.max(1e-6, dt))
  }
  filter(x, t) {
    if (this._tPrev == null) {
      this._tPrev = t
      this._xPrev = x
      this._dxPrev = 0
      return x
    }
    const dt = Math.max(1e-6, (t - this._tPrev) / 1000.0)
    this.setFrequency(1.0 / dt)

    const dx = (x - this._xPrev) / dt
    const aD = this._alpha(this.dCutoff, dt)
    const dxHat = aD * dx + (1 - aD) * this._dxPrev

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat)
    const a = this._alpha(cutoff, dt)
    const xHat = a * x + (1 - a) * this._xPrev

    this._xPrev = xHat
    this._dxPrev = dxHat
    this._tPrev = t
    return xHat
  }
}






function _ensureFilters() {
  if (!CONFIG.filters.enabled) return
  const F = CONFIG.filters
  if (!_state.fPosX)   _state.fPosX   = new OneEuroFilter({ freq:F.freq, ...F.pos })
  if (!_state.fPosY)   _state.fPosY   = new OneEuroFilter({ freq:F.freq, ...F.pos })
  if (!_state.fYaw)    _state.fYaw    = new OneEuroFilter({ freq:F.freq, ...F.rot })
  if (!_state.fPitch)  _state.fPitch  = new OneEuroFilter({ freq:F.freq, ...F.rot })
  if (!_state.fRoll)   _state.fRoll   = new OneEuroFilter({ freq:F.freq, ...F.rot })
  if (!_state.fScale)  _state.fScale  = new OneEuroFilter({ freq:F.freq, ...F.scale })
}
function _resetFilters() {
  _state.fPosX=_state.fPosY=_state.fYaw=_state.fPitch=_state.fRoll=_state.fScale=null
}

/* ===================== Per-Frame 3D Update ===================== */
function _frameTo3D({ landmarks, rot9, mirrorPreview, timestampMs, tvec }){
  const t = timestampMs
  const dtMs = _state.lastTs ? t - _state.lastTs : 16.7
  _state.lastTs = t
  _ensureFilters()

  const C = landmarks[LM.CENTER_STABLE]; if (!C) return
  const p3 = _normToWorld(C.x, C.y, mirrorPreview)

  // ===== DEPTH-BASED VISIBILITY CONTROL =====
  if (CONFIG.depth.enabled && tvec && isFinite(tvec.z)) {
    const zmm = Math.abs(tvec.z)
    const tooFar = zmm > CONFIG.depth.hideIfTooFar
    const tooClose = zmm < CONFIG.depth.hideIfTooClose
    
    const targetVis = (tooFar || tooClose) ? 0.0 : 1.0
    const kHide = 1 - Math.exp(-dtMs / Math.max(1, CONFIG.depth.smoothHideMs))
    _state.depthVisibility += (targetVis - _state.depthVisibility) * kHide
    
    if (_state.lunettes) {
      _state.lunettes.visible = _state.depthVisibility > 0.01
      if (_state.lunettes.visible) {
        // Apply opacity to all materials
        _state.lunettes.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material.transparent = true
            child.material.opacity = _state.depthVisibility
          }
        })
      }
    }
    
    // If completely hidden, skip remaining processing
    if (_state.depthVisibility < 0.01) return
  }
  // ===== /DEPTH VISIBILITY =====

  // Micro-deadband for position
  if (_state.posXS !== null) {
    const dx = p3.x - _state.posXS
    const dy = p3.y - _state.posYS
    const eps = CONFIG.stability.posDeadbandWorld
    if (dx*dx + dy*dy < eps*eps) { p3.x = _state.posXS; p3.y = _state.posYS }
  }

  if (_state.posXS === null){
    _state.posXS = p3.x; _state.posYS = p3.y
    _state.filteredQ.copy(_rot9ToQuaternion(rot9, mirrorPreview))
    _state.haveFilteredQ = true
  }

  // One Euro on position
  let posXraw = p3.x, posYraw = p3.y
  if (CONFIG.filters.enabled) {
    posXraw = _state.fPosX.filter(posXraw, t)
    posYraw = _state.fPosY.filter(posYraw, t)
  }

  // Extra smoothing (very light)
  const kPos = CONFIG.softness.posMs > 0 ? 1 - Math.exp(-dtMs/CONFIG.softness.posMs) : 1
  _state.posXS += (posXraw - _state.posXS) * kPos
  _state.posYS += (posYraw - _state.posYS) * kPos
  const posX = _state.posXS + CONFIG.offsets.x
  let   posY = _state.posYS + CONFIG.offsets.y

  // Orientation target
  let qTarget = _rot9ToQuaternion(rot9, mirrorPreview)
  if (_state.haveFilteredQ && _state.filteredQ.dot(qTarget) < 0) {
    qTarget = new THREE.Quaternion(-qTarget.x,-qTarget.y,-qTarget.z,-qTarget.w)
  }
  const eTarget = new THREE.Euler().setFromQuaternion(qTarget, "YXZ")
  let yaw = eTarget.y, pitch = eTarget.x, roll = eTarget.z

  // One Euro on rotation
  if (CONFIG.filters.enabled) {
    yaw   = _state.fYaw.filter(yaw, t)
    pitch = _state.fPitch.filter(pitch, t)
    roll  = _state.fRoll.filter(roll, t)
  }

 
 
  // Calcul des angles à partir des points du visage

  // Tiny deadband for rotation
  const qBefore = _state.filteredQ.clone()
  if (yaw<0){
    yaw=yaw*0.75
  }

  if (yaw>0){
    yaw=yaw*1.1
  }
  const qFromAngles = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"))
  const dAng = quatAngleRad(qBefore, qFromAngles)
  if (dAng >= THREE.MathUtils.degToRad(CONFIG.stability.rotDeadbandDeg)) {
    const kRot = CONFIG.softness.rotMs > 0 ? 1 - Math.exp(-dtMs/CONFIG.softness.rotMs) : 1
    _state.filteredQ.slerp(qFromAngles, kRot)
  }

  const finalQ = _state.filteredQ
  const eRead = new THREE.Euler().setFromQuaternion(finalQ, "YXZ")
  const yawFiltered = eRead.y

  // Light yaw smoothing for fade decisions
  const kYaw = CONFIG.templesFade.yawSmoothMs > 0 ? 1 - Math.exp(-dtMs/CONFIG.templesFade.yawSmoothMs) : 1
  if (_state.smoothedYaw === null) _state.smoothedYaw = yawFiltered
  else _state.smoothedYaw += (yawFiltered - _state.smoothedYaw) * kYaw

  // Width estimates
  const tL=landmarks[LM.TEMPLE_LEFT], tR=landmarks[LM.TEMPLE_RIGHT]
  const eL=landmarks[LM.LEFT_CORNER], eR=landmarks[LM.RIGHT_CORNER]
  let wPref=0, wFall=0
  if (tL && tR){ const a=_normToWorld(tL.x,tL.y,mirrorPreview), b=_normToWorld(tR.x,tR.y,mirrorPreview); wPref=Math.abs(b.x-a.x) }
  if (eL && eR){ const a=_normToWorld(eL.x,eL.y,mirrorPreview), b=_normToWorld(eR.x,eR.y,mirrorPreview); wFall=Math.abs(b.x-a.x) }
  const usedWidthRaw = Math.max(wPref, wFall)
  const usedWidth = median3Push(_state.widthBuf, usedWidthRaw)

  // Scale from width for initial calibration
  let s_fromWidth = 1
  if (_state.lunettes && _state.modelBaseWidth>0 && usedWidth>0){
    const tYaw = Math.min(Math.abs(yawFiltered)/CONFIG.autoPadding.yawThreshold, 1.0)
    const padPct = CONFIG.autoPadding.enabled
      ? (1 - tYaw)*CONFIG.autoPadding.baseMin + tYaw*CONFIG.autoPadding.baseMax
      : CONFIG.fitting.defaultTemplePaddingPct
    s_fromWidth = (usedWidth * (1 + padPct + CONFIG.fitting.beyondPct)) / _state.modelBaseWidth
    s_fromWidth *= CONFIG.globalScale
  }

  // Scale from depth (primary)
  let sRaw = s_fromWidth
  if (CONFIG.depth.enabled && tvec && isFinite(tvec.z)){
    const fx = _state.fx || _state.fy || 0
    const zmm = Math.min(Math.max(Math.abs(tvec.z), CONFIG.depth.minZmm), CONFIG.depth.maxZmm)
    if (!_state.depthCalibrated && fx>0 && s_fromWidth>0){
      _state.cz = (s_fromWidth*zmm)/fx
      _state.depthCalibrated = true
    }
    if (_state.depthCalibrated && fx>0){
      sRaw = (_state.cz * fx) / zmm
    }
  }

  // One Euro on scale + deadband
  if (CONFIG.filters.enabled) sRaw = _state.fScale.filter(sRaw, t)
  if (_state.lastScale != null) {
    const rel = Math.abs(sRaw - _state.lastScale) / Math.max(1e-6, _state.lastScale)
    if (rel < CONFIG.stability.scaleDeadbandPct) sRaw = _state.lastScale
  }
  const kScale = CONFIG.softness.scaleMs > 0 ? 1 - Math.exp(-dtMs/CONFIG.softness.scaleMs) : 1
  if (_state.lastScale == null) _state.lastScale = sRaw
  else _state.lastScale += (sRaw - _state.lastScale) * kScale

  // Eye-span floor
  if (_state.lunettes && _state.modelBaseWidth>0 && eL && eR){
    const wl=_normToWorld(eL.x,eL.y,mirrorPreview), wr=_normToWorld(eR.x,eR.y,mirrorPreview)
    const eyeW = Math.abs(wr.x - wl.x)
    const floor = (eyeW * (1 + (CONFIG.eyeMinPaddingPct||0))) / _state.modelBaseWidth
    if (isFinite(floor) && floor>0 && _state.lastScale < floor) _state.lastScale = floor
  }

  // Bridge vertical nudge
  posY += (_state.modelBaseWidth||1) * (_state.lastScale||1) * (CONFIG.bridge.offsetFromWidthPct||0)

  // Apply to model root
  if (_state.lunettes){
    let nx=0, ny=0
    if (Math.abs(yawFiltered) > CONFIG.offsets.maxYaw){
      nx += CONFIG.offsets.sideViewOffset.x * Math.sign(yawFiltered)
      ny += CONFIG.offsets.sideViewOffset.y
    }
    _state.lunettes.scale.set(_state.lastScale,_state.lastScale,_state.lastScale)
    _state.lunettes.position.set(posX+nx, posY+ny, CONFIG.offsets.z)
    _state.lunettes.quaternion.copy(_state.filteredQ)


  
    // ======= EXACT outward temple opening to ear landmarks (axis-aware) =======
    
    applyExactTempleOpening(landmarks, mirrorPreview, dtMs)
    // ======= /EXACT outward temple opening =======

    // ======= TEMPLE FADE =======
    if (CONFIG.templesFade.enabled) {
      const yawEff = mirrorPreview ? -_state.smoothedYaw : _state.smoothedYaw
      const db = CONFIG.templesFade.deadband
      let targetLeft = 1.0, targetRight = 1.0
      if (yawEff > db)       { targetLeft = 0.0; targetRight = 1.0 }
      else if (yawEff < -db) { targetLeft = 1.0; targetRight = 0.0 }

      const kBlend = 1 - Math.exp(-dtMs / Math.max(1, CONFIG.templesFade.blendMs))
      _state.applyLeftScale  += (targetLeft  - _state.applyLeftScale)  * kBlend
      _state.applyRightScale += (targetRight - _state.applyRightScale) * kBlend

      if (_state.branchLeft) {
        const s = Math.max(0, _state.applyLeftScale)
        _state.branchLeft.visible = s > CONFIG.templesFade.minScaleVisible
      }
      if (_state.branchRight) {
        const s = Math.max(0, _state.applyRightScale)
        
        _state.branchRight.visible = s > CONFIG.templesFade.minScaleVisible
      }
    }
    // ======= /TEMPLE FADE =======
  }
}

/* ===================== Exact Temple Opening (per frame) ===================== */
function applyExactTempleOpening(landmarks, mirrorPreview, dtMs) {
  const cfg = CONFIG.templesDynamic
  if (!cfg.enabled) return
  if (!_state.branchLeft || !_state.branchRight) return
  if (!_state.branchLeftBaseQ || !_state.branchRightBaseQ) return
  if (!_state.leftTipLocal || !_state.rightTipLocal) return

  // Récup landmarks
  const L = landmarks[LM.LEFT_EAR_TOP]
  const R = landmarks[LM.RIGHT_EAR_TOP]
  if (!L && !R) return

  // Axes locaux
  const axisL = _axisVec(cfg.axisLeft)
  const axisR = _axisVec(cfg.axisRight)

  // Hinge monde (pivot) de chaque branche — pour fixer z de la cible
  const hingeL = new THREE.Vector3()
  const hingeR = new THREE.Vector3()
  if (_state.branchLeft)  _state.branchLeft.getWorldPosition(hingeL)
  if (_state.branchRight) _state.branchRight.getWorldPosition(hingeR)

  // Construit les cibles MONDE (x,y depuis _normToWorld; z = z du pivot)
  const leftTargetW  = L ? (() => {
    const p = _normToWorld(L.x, L.y, mirrorPreview)
    return new THREE.Vector3(p.x, p.y, hingeL.z)
  })() : null

  const rightTargetW = R ? (() => {
    const p = _normToWorld(R.x, R.y, mirrorPreview)
    return new THREE.Vector3(p.x, p.y, hingeR.z)
  })() : null

  // Résout l’angle 3D (1-DOF) pour coller le tip au plus près de la cible
  const leftSol = leftTargetW ? _solveTempleAngleForPoint({
    branch: _state.branchLeft,
    baseQ:  _state.branchLeftBaseQ,
    tipLocal: _state.leftTipLocal,
    axisLocal: axisL,
    targetWorld: leftTargetW,
    maxAngleDeg: cfg.maxAngleDeg ?? 25,
  }) : null

  const rightSol = rightTargetW ? _solveTempleAngleForPoint({
    branch: _state.branchRight,
    baseQ:  _state.branchRightBaseQ,
    tipLocal: _state.rightTipLocal,
    axisLocal: axisR,
    targetWorld: rightTargetW,
    maxAngleDeg: cfg.maxAngleDeg ?? 25,
  }) : null

  // Lissage
  const kSmooth = 1 - Math.exp(-dtMs / Math.max(1, cfg.smoothMs))

  if (leftSol) {
    const targetDeg = THREE.MathUtils.radToDeg(leftSol.theta)
    _state.currentLeftAngle += (targetDeg - _state.currentLeftAngle) * kSmooth
    _state.currentLeftSign = leftSol.sideSign
  }
  if (rightSol) {
    const targetDeg = THREE.MathUtils.radToDeg(rightSol.theta)
    _state.currentRightAngle += (targetDeg - _state.currentRightAngle) * kSmooth
    _state.currentRightSign = rightSol.sideSign
  }

  // Appliquer (réinitialiser à la base puis tourner)
  if (_state.branchLeft) {
    _state.branchLeft.quaternion.copy(_state.branchLeftBaseQ)
    const adjusted = _state.currentLeftAngle + (cfg.angleOffsetDeg || 0)
    _state.branchLeft.rotateOnAxis(axisL, -_state.currentLeftSign * THREE.MathUtils.degToRad(adjusted))
  }
  if (_state.branchRight) {
    _state.branchRight.quaternion.copy(_state.branchRightBaseQ)
    const adjusted = _state.currentRightAngle + (cfg.angleOffsetDeg || 0)
    _state.branchRight.rotateOnAxis(axisR, -_state.currentRightSign * THREE.MathUtils.degToRad(adjusted))
  }

  // (Facultatif) Micro “hard stick” : petite translation dans le plan pour coller EXACTEMENT
  if (cfg.hardStick) {
    const glue = (branch, tipLocal, targetW) => {
      if (!branch || !targetW) return
      branch.updateWorldMatrix(true, true)
      const tipW = tipLocal.clone().applyMatrix4(branch.matrixWorld)
      const delta = targetW.clone().sub(tipW)

      // Ne translater que dans le plan ⟂ axe monde
      const aWorld = new THREE.Vector3()
      branch.getWorldQuaternion(new THREE.Quaternion())
      aWorld.copy(_axisVec(branch === _state.branchLeft ? cfg.axisLeft : cfg.axisRight)
                  .applyQuaternion(branch.getWorldQuaternion(new THREE.Quaternion()))
                  .normalize())

      const deltaPlan = delta.sub(aWorld.clone().multiplyScalar(delta.dot(aWorld)))
      branch.position.add(deltaPlan) // “triche” contrôlée du pivot
    }
    glue(_state.branchLeft,  _state.leftTipLocal,  leftTargetW)
    glue(_state.branchRight, _state.rightTipLocal, rightTargetW)
  }
}
