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
let config = null;
let baseEarringScale = 1;
let userScaleMultiplier = 1;
// ===============================
// ROTATION PRO (GLOBAL)
// ===============================
let prevQuatLeft = new THREE.Quaternion();
let prevQuatRight = new THREE.Quaternion();
let isFirstFrame = true;
let smoothedDist = 500;
const ROTATION_SMOOTHING = 0.38;
const YAW_FOLLOW = 0.65;
const PITCH_FOLLOW = 0.12;
const YAW_HIDE_SOFT = 0.24;
const YAW_HIDE_HARD = 0.62;
const EAR_HIDE_Z_MARGIN = 0.010;

let leftHiddenScore = 0;
let rightHiddenScore = 0;
let leftVisibleState = true;
let rightVisibleState = true;

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
let LOBULE_OFFSET = { x: 0.022, y: -0.046 };

// Fonction exportée pour mise à jour depuis l'interface
export function setLobuleOffsets(x, y) {
  LOBULE_OFFSET.x = x;
  LOBULE_OFFSET.y = y;
}

export function setEarringScaleMultiplier(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  userScaleMultiplier = THREE.MathUtils.clamp(n, 0.02, 2.0);
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

class Smoother {
  constructor(alpha = 0.85) {
    this.alpha = alpha;
    this.prev = null;
  }

  smooth(v) {
    if (!this.prev) {
      this.prev = { x: v.x, y: v.y, z: v.z || 0 };
      return this.prev;
    }
    this.prev = {
      x: this.alpha * v.x + (1 - this.alpha) * this.prev.x,
      y: this.alpha * v.y + (1 - this.alpha) * this.prev.y,
      z: this.alpha * (v.z || 0) + (1 - this.alpha) * this.prev.z
    };
    return this.prev;
  }
}

const smoothLeft = new Smoother(0.85);
const smoothRight = new Smoother(0.85);

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

function getEarVisibility(landmarks, yaw) {
  const y = yaw || 0;

  // Hard fallback only by yaw when landmarks are missing.
  if (!landmarks || landmarks.length < 468) {
    if (Math.abs(y) < YAW_HIDE_HARD) return { left: true, right: true };
    return y > 0 ? { left: false, right: true } : { left: true, right: false };
  }

  const leftEar = landmarks[LOBULE_LANDMARKS.LEFT.LOBE_MAIN];
  const rightEar = landmarks[LOBULE_LANDMARKS.RIGHT.LOBE_MAIN];
  if (!leftEar || !rightEar) {
    if (Math.abs(y) < YAW_HIDE_HARD) return { left: true, right: true };
    return y > 0 ? { left: false, right: true } : { left: true, right: false };
  }

  // MediaPipe z: larger usually means farther from camera.
  const dz = (leftEar.z || 0) - (rightEar.z || 0);
  const leftHiddenHard = y > YAW_HIDE_HARD;
  const rightHiddenHard = y < -YAW_HIDE_HARD;
  const leftHiddenSoft = y > YAW_HIDE_SOFT && dz > EAR_HIDE_Z_MARGIN;
  const rightHiddenSoft = y < -YAW_HIDE_SOFT && -dz > EAR_HIDE_Z_MARGIN;

  const leftTarget = (leftHiddenHard || leftHiddenSoft) ? 1 : 0;
  const rightTarget = (rightHiddenHard || rightHiddenSoft) ? 1 : 0;

  leftHiddenScore = THREE.MathUtils.lerp(leftHiddenScore, leftTarget, 0.35);
  rightHiddenScore = THREE.MathUtils.lerp(rightHiddenScore, rightTarget, 0.35);

  // Hysteresis to avoid flicker around threshold.
  if (leftVisibleState && leftHiddenScore > 0.58) leftVisibleState = false;
  else if (!leftVisibleState && leftHiddenScore < 0.32) leftVisibleState = true;

  if (rightVisibleState && rightHiddenScore > 0.58) rightVisibleState = false;
  else if (!rightVisibleState && rightHiddenScore < 0.32) rightVisibleState = true;

  return { left: leftVisibleState, right: rightVisibleState };
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
    antialias: false,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(1);
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

  const smoothedLeft = smoothLeft.smooth(leftPos);
  const smoothedRight = smoothRight.smooth(rightPos);
  
  // Convert normalized coords to Three.js coords
  // In Three.js orthographic: x=[-aspect, aspect], y=[-1, 1]
  const toThreeX = (nx, mirror) => {
    const x = mirror ? (1 - nx) : nx;
    return (x - 0.5) * 2 * aspect;
  };
  
  const toThreeY = (ny) => {
    return -(ny - 0.5) * 2;
  };
  
  const yaw = estimateYawFromRot9(rot9);
  const earVisibility = getEarVisibility(landmarks, yaw);

  // Position earrings (pivot = lobule point)
  // Left ear (user's left = screen right when mirrored)
  const lx = toThreeX(smoothedLeft.x, mirrorPreview);
  const ly = toThreeY(smoothedLeft.y);
  earringLeft.position.set(lx, ly, 0);
  
  // Right ear (user's right = screen left when mirrored)
  const rx = toThreeX(smoothedRight.x, mirrorPreview);
  const ry = toThreeY(smoothedRight.y);
  earringRight.position.set(rx, ry, 0);
  
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

    const angularDelta = isFirstFrame ? 0 : prevQuatLeft.angleTo(targetLeftQuat);
    const adaptiveSmoothing = THREE.MathUtils.clamp(
      ROTATION_SMOOTHING + angularDelta * 1.1,
      0.30,
      0.75
    );

    if (isFirstFrame) {
      prevQuatLeft.copy(targetLeftQuat);
      prevQuatRight.copy(targetRightQuat);
      isFirstFrame = false;
    } else {
      prevQuatLeft.slerp(targetLeftQuat, adaptiveSmoothing);
      prevQuatRight.slerp(targetRightQuat, adaptiveSmoothing);
    }

    earringLeft.quaternion.copy(prevQuatLeft);
    earringRight.quaternion.copy(prevQuatRight);
  }
  
  // Smooth distance to prevent sudden size jumps when solvePnP jitters during motion.
  const rawDist = Math.abs(data.tvec?.z || 500);
  smoothedDist = THREE.MathUtils.lerp(smoothedDist, rawDist, 0.25);
  const scaleFactor = Math.max(0.9, Math.min(2.0, 460 / Math.max(120, smoothedDist)));
  const baseScale = baseEarringScale || Math.abs(earringLeft.scale.x) || 0.01;
  const currentScale = baseScale * scaleFactor * userScaleMultiplier;
  
  earringLeft.scale.setScalar(currentScale);
  earringRight.scale.setScalar(currentScale);
  
  // Make visible (hide far ear when head rotation makes it go behind face)
  earringLeft.visible = earVisibility.left;
  earringRight.visible = earVisibility.right;
  
  // Render
  renderer.render(scene, camera);
}
