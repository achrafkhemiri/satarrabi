/**
 * main.js - Earring Try-On with Three.js
 * Uses OpenCV solvePnP for precise 3D pose estimation
 * 
 * POINT LOBULE INTERPOLÉ:
 * Le point exact du lobule est calculé à partir de plusieurs landmarks
 * et peut être ajusté manuellement via les sliders dans l'interface.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'jsm/loaders/RGBELoader.js';

let scene, camera, renderer;
let earringLeft, earringRight;
let leftEarOccluder = null;
let rightEarOccluder = null;
let config = null;
let baseEarringScale = 1;
// ===============================
// ROTATION PRO (GLOBAL)
// ===============================
let prevQuatLeft = new THREE.Quaternion();
let prevQuatRight = new THREE.Quaternion();
let isFirstFrame = true;
const ROTATION_SMOOTHING = 0.22;
const DEPTH_Z_SCALE = 0.0016;
const LANDMARK_Z_SCALE = 1.2;
const YAW_FOLLOW = 0.65;
const PITCH_FOLLOW = 0.12;
const PNP_CENTER_BLEND_X = 0.75;
const PNP_CENTER_BLEND_Y = 0.45;
const OCCLUDER_Z_BIAS = 0.075;
const EAR_OCCLUDE_Z_THRESHOLD = 0.055;
const EAR_OCCLUDE_MIN_YAW = 0.38;
const LEFT_EAR_OCCLUDER_POINTS = [234, 93, 132, 58, 172, 136, 150, 149];
const RIGHT_EAR_OCCLUDER_POINTS = [454, 323, 361, 288, 397, 365, 379, 378];

// Rotation de base (corrige orientation modèle si nécessaire)
const BASE_ROT_LEFT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, 0, 0) // <-- ajuste ici si boucle mal orientée
);

const BASE_ROT_RIGHT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, 0, 0)
);

// ========================================================
// CONFIGURATION DU POINT LOBULE INTERPOLÉ
// ========================================================

// Offsets ajustables depuis l'interface (modifié en temps réel par les sliders)
// X négatif = vers l'extérieur (oreille), X positif = vers l'intérieur (visage)
// Y négatif = vers le haut, Y positif = vers le bas
// VALEURS CALIBRÉES - Position centre du lobule
let LOBULE_OFFSET = { x: 0.018, y: -0.046 };

// Fonction exportée pour mise à jour depuis l'interface
export function setLobuleOffsets(x, y) {
  LOBULE_OFFSET.x = x;
  LOBULE_OFFSET.y = y;
}

// Landmarks utilisés pour interpoler le point lobule
// Left: #132 (lobe principal), #172 (lobe bas), #147 (mâchoire)
// Right: #361 (lobe principal), #397 (lobe bas), #376 (mâchoire)
const LOBULE_LANDMARKS = {
  LEFT: {
    LOBE_MAIN: 132,    // Point principal du lobe
    LOBE_LOWER: 172,   // Point plus bas
    JAW: 147,          // Mâchoire (référence verticale)
    EAR_TOP: 234       // Haut de l'oreille (pour calculer l'échelle)
  },
  RIGHT: {
    LOBE_MAIN: 361,    // Point principal du lobe
    LOBE_LOWER: 397,   // Point plus bas
    JAW: 376,          // Mâchoire (référence verticale)
    EAR_TOP: 454       // Haut de l'oreille (pour calculer l'échelle)
  }
};

/**
 * Calcule le point lobule interpolé pour un côté donné
 * @param {Array} landmarks - Tous les landmarks du visage
 * @param {string} side - 'LEFT' ou 'RIGHT'
 * @returns {Object} - Position interpolée {x, y, z}
 */
function calculateInterpolatedLobule(landmarks, side) {
  const cfg = LOBULE_LANDMARKS[side];
  
  const lobeMain = landmarks[cfg.LOBE_MAIN];
  const lobeLower = landmarks[cfg.LOBE_LOWER];
  const jaw = landmarks[cfg.JAW];
  const earTop = landmarks[cfg.EAR_TOP];
  
  if (!lobeMain || !lobeLower) {
    return lobeMain || { x: 0.5, y: 0.5, z: 0 };
  }
  
  // Interpolation: moyenne pondérée entre lobe principal (70%) et lobe bas (30%)
  // Cela place le point plus au centre du lobule
  const baseX = lobeMain.x * 0.7 + lobeLower.x * 0.3;
  const baseY = lobeMain.y * 0.7 + lobeLower.y * 0.3;
  const baseZ = (lobeMain.z || 0) * 0.7 + (lobeLower.z || 0) * 0.3;
  
  // Appliquer les offsets manuels
  // Note: pour le côté gauche, X négatif va vers l'extérieur (valeur X plus petite)
  // Pour le côté droit, X négatif va vers l'extérieur (valeur X plus grande car image miroir)
  const xDirection = side === 'LEFT' ? -1 : 1;
  
  return {
    x: baseX + (LOBULE_OFFSET.x * xDirection),
    y: baseY + LOBULE_OFFSET.y,
    z: baseZ
  };
}

// Base local orientation so earrings hang down instead of lying horizontal.
const BASE_ROT = {
  LEFT: { x: 0, y: 0, z: 0 },
  RIGHT: { x: 0, y: 0, z: 0 }
};

// Kalman 1D filter for stable tracking with limited lag.
class Kalman1D {
  constructor({ q = 0.0008, r = 0.003, p = 1 } = {}) {
    this.q = q; // process noise
    this.r = r; // measurement noise
    this.p = p; // estimation error covariance
    this.x = 0;
    this.initialized = false;
  }

  filter(measurement) {
    if (!this.initialized) {
      this.x = measurement;
      this.initialized = true;
      return this.x;
    }

    // Predict
    this.p += this.q;

    // Update
    const k = this.p / (this.p + this.r);
    this.x += k * (measurement - this.x);
    this.p *= (1 - k);

    return this.x;
  }
}

class Kalman3D {
  constructor(cfg = {}) {
    this.kx = new Kalman1D(cfg.x);
    this.ky = new Kalman1D(cfg.y);
    this.kz = new Kalman1D(cfg.z);
  }

  filter(v) {
    return {
      x: this.kx.filter(v.x),
      y: this.ky.filter(v.y),
      z: this.kz.filter(v.z || 0)
    };
  }
}

const kalmanLeft = new Kalman3D({
  x: { q: 0.0032, r: 0.0018 },
  y: { q: 0.0024, r: 0.002 },
  z: { q: 0.0015, r: 0.01 }
});

const kalmanRight = new Kalman3D({
  x: { q: 0.0032, r: 0.0018 },
  y: { q: 0.0024, r: 0.002 },
  z: { q: 0.0015, r: 0.01 }
});

function getPnPCenterNormalized(data) {
  const tvec = data?.tvec;
  const intr = data?.intrinsics;
  if (!tvec || !intr) return null;

  const z = tvec.z;
  if (!Number.isFinite(z) || Math.abs(z) < 1e-6) return null;

  const px = (intr.fx * (tvec.x / z)) + intr.cx;
  const py = (intr.fy * (tvec.y / z)) + intr.cy;

  return {
    x: px / data.w,
    y: py / data.h
  };
}

function mapPoseDepthToSceneZ(tvecZ) {
  const distance = Math.abs(tvecZ || 500);
  return THREE.MathUtils.clamp((500 - distance) * DEPTH_Z_SCALE, -0.8, 0.8);
}

function createEarOccluder(pointsCount) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array((pointsCount + 1) * 3);

  const indices = [];
  for (let i = 1; i <= pointsCount; i++) {
    const next = i === pointsCount ? 1 : i + 1;
    indices.push(0, i, next);
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);

  const material = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;
  return mesh;
}

function updateEarOccluder(mesh, landmarkIds, landmarks, aspect, mirrorPreview, poseDepthZ) {
  if (!mesh || !landmarks || landmarks.length < 468) return;

  const positions = mesh.geometry.attributes.position.array;
  let cx = 0;
  let cy = 0;
  let cz = 0;

  for (let i = 0; i < landmarkIds.length; i++) {
    const lm = landmarks[landmarkIds[i]];
    const x = mirrorPreview ? (1 - lm.x) : lm.x;
    const y = lm.y;
    const z = poseDepthZ + THREE.MathUtils.clamp((lm.z || 0) * LANDMARK_Z_SCALE, -0.35, 0.35) + OCCLUDER_Z_BIAS;

    positions[(i + 1) * 3 + 0] = (x - 0.5) * 2 * aspect;
    positions[(i + 1) * 3 + 1] = -(y - 0.5) * 2;
    positions[(i + 1) * 3 + 2] = z;

    cx += positions[(i + 1) * 3 + 0];
    cy += positions[(i + 1) * 3 + 1];
    cz += z;
  }

  const inv = 1 / landmarkIds.length;
  positions[0] = cx * inv;
  positions[1] = cy * inv;
  positions[2] = (cz * inv) + 0.015;

  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

function updateEarOccluders(landmarks, aspect, mirrorPreview, poseDepthZ) {
  updateEarOccluder(leftEarOccluder, LEFT_EAR_OCCLUDER_POINTS, landmarks, aspect, mirrorPreview, poseDepthZ);
  updateEarOccluder(rightEarOccluder, RIGHT_EAR_OCCLUDER_POINTS, landmarks, aspect, mirrorPreview, poseDepthZ);
}

function estimateYawFromRot9(rot9) {
  if (!rot9 || rot9.length !== 9) return 0;
  const rotMat = new THREE.Matrix4().set(
    rot9[0], rot9[1], rot9[2], 0,
    rot9[3], rot9[4], rot9[5], 0,
    rot9[6], rot9[7], rot9[8], 0,
    0, 0, 0, 1
  );
  const e = new THREE.Euler().setFromRotationMatrix(rotMat, 'YXZ');
  return e.y;
}

function getEarVisibilityFromDepth(landmarks, yaw) {
  if (!landmarks || landmarks.length < 468) {
    return { left: true, right: true };
  }

  // Keep both earrings visible when face is close to frontal.
  const yawAbs = Math.abs(yaw || 0);
  if (yawAbs < EAR_OCCLUDE_MIN_YAW) {
    return { left: true, right: true };
  }

  const left = landmarks[LOBULE_LANDMARKS.LEFT.LOBE_MAIN];
  const right = landmarks[LOBULE_LANDMARKS.RIGHT.LOBE_MAIN];
  if (!left || !right) {
    return { left: true, right: true };
  }

  const leftZ = left.z || 0;
  const rightZ = right.z || 0;
  const dz = leftZ - rightZ;

  if (Math.abs(dz) < EAR_OCCLUDE_Z_THRESHOLD) {
    return { left: true, right: true };
  }

  // In MediaPipe coordinates, larger z is usually farther from camera.
  // Use yaw sign to avoid wrong-side hiding when depth is noisy.
  if (yaw > 0) {
    // Face turned right on screen -> left ear tends to be farther.
    return {
      left: leftZ + EAR_OCCLUDE_Z_THRESHOLD <= rightZ,
      right: true
    };
  }

  if (yaw < 0) {
    // Face turned left on screen -> right ear tends to be farther.
    return {
      left: true,
      right: rightZ + EAR_OCCLUDE_Z_THRESHOLD <= leftZ
    };
  }

  return {
    left: true,
    right: true
  };
}

function computeTopAnchorPoint(root) {
  root.updateMatrixWorld(true);

  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  let maxY = -Infinity;
  let best = null;

  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const pos = node.geometry.attributes.position;
    const toRoot = new THREE.Matrix4().multiplyMatrices(invRoot, node.matrixWorld);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      if (v.y > maxY) maxY = v.y;
    }
  });

  const yBand = 0.01;
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const pos = node.geometry.attributes.position;
    const toRoot = new THREE.Matrix4().multiplyMatrices(invRoot, node.matrixWorld);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toRoot);
      if (maxY - v.y > yBand) continue;
      const score = Math.abs(v.x) + Math.abs(v.z) * 0.35;
      if (!best || score < best.score) best = { point: v.clone(), score };
    }
  });

  if (best?.point) return best.point;

  const box = new THREE.Box3().setFromObject(root);
  return new THREE.Vector3((box.min.x + box.max.x) * 0.5, box.max.y, (box.min.z + box.max.z) * 0.5);
}

export function initEarringTryOn(options) {
  config = options;
  const canvas = options.canvas;
  
  // Scene
  scene = new THREE.Scene();
  
  // Camera (orthographic for 2D overlay)
  const aspect = canvas.width / canvas.height;
  camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 1000);
  camera.position.z = 5;
  
  // Renderer
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.sortObjects = true;
  
  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  
  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
  directionalLight.position.set(0, 1, 2);
  scene.add(directionalLight);
  
  const backLight = new THREE.DirectionalLight(0xffffff, 0.5);
  backLight.position.set(0, -1, -2);
  scene.add(backLight);
  
  // Load HDR environment (optional, fallback to simple lighting)
  new RGBELoader().setPath('https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/equirectangular/')
    .load('venice_sunset_1k.hdr', 
      (hdrTexture) => {
        hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
        scene.environment = hdrTexture;
      },
      undefined,
      () => console.log('HDR not loaded, using basic lighting')
    );
  
  // Load 3D earring model
  const loader = new GLTFLoader();
  loader.load('./boucle2.glb',
    (gltf) => {
      const modelTemplate = gltf.scene;
      
      // Normalize scale (kept on parent groups for stable summit anchoring)
      const box = new THREE.Box3().setFromObject(modelTemplate);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 0.42 / maxDim;
      baseEarringScale = scale;
      const topAnchor = computeTopAnchorPoint(modelTemplate);

      // Left earring: parent tracks landmark, child shifted so summit sits at parent origin.
      const leftModel = modelTemplate.clone(true);
      leftModel.position.set(-topAnchor.x, -topAnchor.y, -topAnchor.z);
      leftModel.quaternion.copy(BASE_ROT_LEFT);

      earringLeft = new THREE.Group();
      earringLeft.add(leftModel);
      earringLeft.visible = false;
      earringLeft.renderOrder = 1;
      scene.add(earringLeft);
      
      // Right earring: avoid negative scale mirroring to keep stable rotation handedness.
      const rightModel = modelTemplate.clone(true);
      rightModel.position.set(-topAnchor.x, -topAnchor.y, -topAnchor.z);
      rightModel.quaternion.copy(BASE_ROT_RIGHT);
      rightModel.rotateY(Math.PI);

      earringRight = new THREE.Group();
      earringRight.add(rightModel);
      earringRight.visible = false;
      earringRight.renderOrder = 1;
      scene.add(earringRight);
      
      console.log('3D earring model loaded');
    },
    undefined,
    (err) => console.error('Failed to load 3D model:', err)
  );

  leftEarOccluder = createEarOccluder(LEFT_EAR_OCCLUDER_POINTS.length);
  rightEarOccluder = createEarOccluder(RIGHT_EAR_OCCLUDER_POINTS.length);
  scene.add(leftEarOccluder);
  scene.add(rightEarOccluder);
  
  // Handle resize
  window.addEventListener('resize', () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    
    renderer.setSize(w * dpr, h * dpr, false);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    
    const aspect = w / h;
    camera.left = -aspect;
    camera.right = aspect;
    camera.updateProjectionMatrix();
  });
}

export function updateEarringTryOn(data) {
  if (!earringLeft || !earringRight || !data.earLobes) return;
  if (!data.earLobes.left || !data.earLobes.right) return;
  
  const showEarrings = config?.showEarrings?.() ?? true;
  if (!showEarrings) {
    earringLeft.visible = false;
    earringRight.visible = false;
    renderer.render(scene, camera);
    return;
  }
  
  const { landmarks, earLobes, rot9, w, h, mirrorPreview } = data;
  const aspect = w / h;

  // ========================================================
  // POINT LOBULE INTERPOLÉ
  // Utilise plusieurs landmarks pour un positionnement précis
  // + offsets ajustables depuis l'interface
  // ========================================================
  
  let leftPos, rightPos;
  
  if (landmarks && landmarks.length >= 468) {
    // Utiliser le point lobule interpolé
    leftPos = calculateInterpolatedLobule(landmarks, 'LEFT');
    rightPos = calculateInterpolatedLobule(landmarks, 'RIGHT');
  } else {
    // Fallback sur les positions brutes
    const anchorLeft = landmarks?.[132] || earLobes.left;
    const anchorRight = landmarks?.[361] || earLobes.right;
    
    leftPos = {
      x: anchorLeft.x + LOBULE_OFFSET.x * -1,
      y: anchorLeft.y + LOBULE_OFFSET.y,
      z: anchorLeft.z || 0
    };
    
    rightPos = {
      x: anchorRight.x + LOBULE_OFFSET.x * 1,
      y: anchorRight.y + LOBULE_OFFSET.y,
      z: anchorRight.z || 0
    };
  }

  // PnP-based global translation compensation (especially useful for fast horizontal motion).
  const pnpCenter = getPnPCenterNormalized(data);
  const nose = landmarks?.[1];
  if (pnpCenter && nose) {
    const dx = THREE.MathUtils.clamp(pnpCenter.x - nose.x, -0.08, 0.08);
    const dy = THREE.MathUtils.clamp(pnpCenter.y - nose.y, -0.08, 0.08);

    leftPos.x += dx * PNP_CENTER_BLEND_X;
    rightPos.x += dx * PNP_CENTER_BLEND_X;
    leftPos.y += dy * PNP_CENTER_BLEND_Y;
    rightPos.y += dy * PNP_CENTER_BLEND_Y;
  }
  
  // Kalman-filtered anchor positions
  const smoothedLeft = kalmanLeft.filter(leftPos);
  const smoothedRight = kalmanRight.filter(rightPos);
  
  // Convert normalized coords to Three.js coords
  // In Three.js orthographic: x=[-aspect, aspect], y=[-1, 1]
  const toThreeX = (nx, mirror) => {
    const x = mirror ? (1 - nx) : nx;
    return (x - 0.5) * 2 * aspect;
  };
  
  const toThreeY = (ny) => {
    return -(ny - 0.5) * 2;
  };
  
  const poseDepthZ = mapPoseDepthToSceneZ(data.tvec?.z);
  updateEarOccluders(landmarks, aspect, mirrorPreview, poseDepthZ);
  const yaw = estimateYawFromRot9(rot9);
  const earVisibility = getEarVisibilityFromDepth(landmarks, yaw);

  const leftDepthZ = poseDepthZ + THREE.MathUtils.clamp((smoothedLeft.z || 0) * LANDMARK_Z_SCALE, -0.2, 0.2);
  const rightDepthZ = poseDepthZ + THREE.MathUtils.clamp((smoothedRight.z || 0) * LANDMARK_Z_SCALE, -0.2, 0.2);

  // Position earrings (pivot = lobule point)
  // Left ear (user's left = screen right when mirrored)
  const lx = toThreeX(smoothedLeft.x, mirrorPreview);
  const ly = toThreeY(smoothedLeft.y);
  earringLeft.position.set(lx, ly, leftDepthZ);
  
  // Right ear (user's right = screen left when mirrored)
  const rx = toThreeX(smoothedRight.x, mirrorPreview);
  const ry = toThreeY(smoothedRight.y);
  earringRight.position.set(rx, ry, rightDepthZ);
  
  // Apply head rotation while cancelling roll so earrings stay vertically hanging.
  if (rot9 && rot9.length === 9) {
    const rotMat = new THREE.Matrix4().set(
      rot9[0], rot9[1], rot9[2], 0,
      rot9[3], rot9[4], rot9[5], 0,
      rot9[6], rot9[7], rot9[8], 0,
      0, 0, 0, 1
    );

    const headEuler = new THREE.Euler().setFromRotationMatrix(rotMat, 'YXZ');
    const targetEuler = new THREE.Euler(
      headEuler.x * PITCH_FOLLOW,
      headEuler.y * YAW_FOLLOW,
      0,
      'YXZ'
    );
    const targetLeftQuat = new THREE.Quaternion().setFromEuler(targetEuler);
    const targetRightQuat = new THREE.Quaternion().setFromEuler(targetEuler);

    if (isFirstFrame) {
      prevQuatLeft.copy(targetLeftQuat);
      prevQuatRight.copy(targetRightQuat);
      isFirstFrame = false;
    } else {
      prevQuatLeft.slerp(targetLeftQuat, ROTATION_SMOOTHING);
      prevQuatRight.slerp(targetRightQuat, ROTATION_SMOOTHING);
    }

    earringLeft.quaternion.copy(prevQuatLeft);
    earringRight.quaternion.copy(prevQuatRight);
  }
  
  // Scale based on distance
  const dist = data.tvec?.z || 500;
  const scaleFactor = Math.max(0.9, Math.min(2.6, 460 / Math.abs(dist)));
  const baseScale = baseEarringScale || Math.abs(earringLeft.scale.x) || 0.01;
  const currentScale = baseScale * scaleFactor;
  
  earringLeft.scale.setScalar(currentScale);
  earringRight.scale.setScalar(currentScale);
  
  // Make visible (hide far ear when head rotation makes it go behind face)
  earringLeft.visible = earVisibility.left;
  earringRight.visible = earVisibility.right;
  
  // Render
  renderer.render(scene, camera);
}
