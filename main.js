/**
 * main.js - Earring Try-On with Three.js
 * Uses OpenCV solvePnP for precise 3D pose estimation
 *
 * POINT LOBULE INTERPOLE:
 * Le point exact du lobule est calcule a partir de plusieurs landmarks
 * et peut etre ajuste manuellement via les sliders dans l'interface.
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
let userScaleMultiplier = 1;
let smoothedDist = 500;

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
const EAR_OCCLUDE_Z_THRESHOLD = 0.04;
const EAR_OCCLUDE_MIN_YAW = 0.24;
const EAR_HIDE_HYST_ON = 0.62;
const EAR_HIDE_HYST_OFF = 0.34;
const EAR_HIDE_SMOOTH = 0.28;

const LEFT_EAR_OCCLUDER_POINTS = [234, 93, 132, 58, 172, 136, 150, 149];
const RIGHT_EAR_OCCLUDER_POINTS = [454, 323, 361, 288, 397, 365, 379, 378];
const ENABLE_EAR_OCCLUDERS = true;
const USE_DEPTH_VISIBILITY = true;

let leftHiddenScore = 0;
let rightHiddenScore = 0;
let leftVisibleState = true;
let rightVisibleState = true;

// Rotation de base (corrige orientation modele si necessaire)
const BASE_ROT_LEFT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, 0, 0)
);

const BASE_ROT_RIGHT = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(0, 0, 0)
);

// ========================================================
// CONFIGURATION DU POINT LOBULE INTERPOLE
// ========================================================
let LOBULE_OFFSET = { x: 0.022, y: -0.046 };

export function setLobuleOffsets(x, y) {
  LOBULE_OFFSET.x = THREE.MathUtils.clamp(Number(x) || 0, -0.08, 0.08);
  LOBULE_OFFSET.y = THREE.MathUtils.clamp(Number(y) || 0, -0.12, 0.12);
}

export function setEarringScaleMultiplier(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  userScaleMultiplier = THREE.MathUtils.clamp(n, 0.02, 2.0);
}

const LOBULE_LANDMARKS = {
  LEFT: {
    LOBE_MAIN: 132,
    LOBE_LOWER: 172,
    JAW: 147,
    EAR_TOP: 234
  },
  RIGHT: {
    LOBE_MAIN: 361,
    LOBE_LOWER: 397,
    JAW: 376,
    EAR_TOP: 454
  }
};

function calculateInterpolatedLobule(landmarks, side) {
  const cfg = LOBULE_LANDMARKS[side];

  const lobeMain = landmarks[cfg.LOBE_MAIN];
  const lobeLower = landmarks[cfg.LOBE_LOWER];

  if (!lobeMain || !lobeLower) {
    return lobeMain || { x: 0.5, y: 0.5, z: 0 };
  }

  const baseX = lobeMain.x * 0.7 + lobeLower.x * 0.3;
  const baseY = lobeMain.y * 0.7 + lobeLower.y * 0.3;
  const baseZ = (lobeMain.z || 0) * 0.7 + (lobeLower.z || 0) * 0.3;

  const xDirection = side === 'LEFT' ? -1 : 1;

  return {
    x: baseX + (LOBULE_OFFSET.x * xDirection),
    y: baseY + LOBULE_OFFSET.y,
    z: baseZ
  };
}

class Kalman1D {
  constructor({ q = 0.0008, r = 0.003, p = 1 } = {}) {
    this.q = q;
    this.r = r;
    this.p = p;
    this.x = 0;
    this.initialized = false;
  }

  filter(measurement) {
    if (!this.initialized) {
      this.x = measurement;
      this.initialized = true;
      return this.x;
    }

    this.p += this.q;

    const k = this.p / (this.p + this.r);
    this.x += k * (measurement - this.x);
    this.p *= (1 - k);

    return this.x;
  }

  reset() {
    this.p = 1;
    this.x = 0;
    this.initialized = false;
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

  reset() {
    this.kx.reset();
    this.ky.reset();
    this.kz.reset();
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

function resetTrackingState() {
  isFirstFrame = true;
  prevQuatLeft.identity();
  prevQuatRight.identity();
  smoothedDist = 500;
  leftHiddenScore = 0;
  rightHiddenScore = 0;
  leftVisibleState = true;
  rightVisibleState = true;
  kalmanLeft.reset();
  kalmanRight.reset();
}

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

function getSceneAspect() {
  const el = renderer?.domElement;
  if (!el) return 1;
  return (el.width || 1) / (el.height || 1);
}

function mapLandmarkToScene(landmark, mirrorPreview, cover, sceneAspect) {
  if (!landmark) return { x: 0, y: 0 };

  let nx = landmark.x;
  let ny = landmark.y;

  if (cover && Number.isFinite(cover.drawW) && Number.isFinite(cover.drawH) && Number.isFinite(cover.dstW) && Number.isFinite(cover.dstH)) {
    const px = cover.dx + nx * cover.drawW;
    const py = cover.dy + ny * cover.drawH;
    nx = px / cover.dstW;
    ny = py / cover.dstH;
  }

  if (mirrorPreview) nx = 1 - nx;

  return {
    x: (nx - 0.5) * 2 * sceneAspect,
    y: -(ny - 0.5) * 2
  };
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

function updateEarOccluder(mesh, landmarkIds, landmarks, mirrorPreview, poseDepthZ, cover, sceneAspect) {
  if (!mesh || !landmarks || landmarks.length < 468) return;

  const positions = mesh.geometry.attributes.position.array;
  let cx = 0;
  let cy = 0;
  let cz = 0;

  for (let i = 0; i < landmarkIds.length; i++) {
    const lm = landmarks[landmarkIds[i]];
    const p = mapLandmarkToScene(lm, mirrorPreview, cover, sceneAspect);
    const z = poseDepthZ + THREE.MathUtils.clamp((lm.z || 0) * LANDMARK_Z_SCALE, -0.35, 0.35) + OCCLUDER_Z_BIAS;

    positions[(i + 1) * 3 + 0] = p.x;
    positions[(i + 1) * 3 + 1] = p.y;
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

function updateEarOccluders(landmarks, mirrorPreview, poseDepthZ) {
  const sceneAspect = getSceneAspect();
  const cover = window.__LAST_VIDEO_COVER__ || null;
  updateEarOccluder(leftEarOccluder, LEFT_EAR_OCCLUDER_POINTS, landmarks, mirrorPreview, poseDepthZ, cover, sceneAspect);
  updateEarOccluder(rightEarOccluder, RIGHT_EAR_OCCLUDER_POINTS, landmarks, mirrorPreview, poseDepthZ, cover, sceneAspect);
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

  if (!USE_DEPTH_VISIBILITY) {
    return { left: true, right: true };
  }

  const yawAbs = Math.abs(yaw || 0);
  if (yawAbs < EAR_OCCLUDE_MIN_YAW) {
    leftHiddenScore = THREE.MathUtils.lerp(leftHiddenScore, 0, EAR_HIDE_SMOOTH);
    rightHiddenScore = THREE.MathUtils.lerp(rightHiddenScore, 0, EAR_HIDE_SMOOTH);
  }

  const left = landmarks[LOBULE_LANDMARKS.LEFT.LOBE_MAIN];
  const right = landmarks[LOBULE_LANDMARKS.RIGHT.LOBE_MAIN];
  if (!left || !right) {
    return { left: true, right: true };
  }

  const leftZ = left.z || 0;
  const rightZ = right.z || 0;
  const dz = leftZ - rightZ;

  let leftTarget = 0;
  let rightTarget = 0;

  // Use relative depth directly (farther ear gets hidden) to avoid mirrored/yaw-sign mismatches.
  const yawFactor = THREE.MathUtils.clamp((yawAbs - EAR_OCCLUDE_MIN_YAW) / 0.45, 0, 1);
  const depthThreshold = THREE.MathUtils.lerp(EAR_OCCLUDE_Z_THRESHOLD, EAR_OCCLUDE_Z_THRESHOLD * 0.55, yawFactor);
  if (yawAbs >= EAR_OCCLUDE_MIN_YAW && Math.abs(dz) >= depthThreshold) {
    if (dz > 0) leftTarget = 1;
    else rightTarget = 1;
  }

  leftHiddenScore = THREE.MathUtils.lerp(leftHiddenScore, leftTarget, EAR_HIDE_SMOOTH);
  rightHiddenScore = THREE.MathUtils.lerp(rightHiddenScore, rightTarget, EAR_HIDE_SMOOTH);

  if (leftVisibleState && leftHiddenScore > EAR_HIDE_HYST_ON) leftVisibleState = false;
  else if (!leftVisibleState && leftHiddenScore < EAR_HIDE_HYST_OFF) leftVisibleState = true;

  if (rightVisibleState && rightHiddenScore > EAR_HIDE_HYST_ON) rightVisibleState = false;
  else if (!rightVisibleState && rightHiddenScore < EAR_HIDE_HYST_OFF) rightVisibleState = true;

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
  resetTrackingState();

  scene = new THREE.Scene();

  const aspect = canvas.width / canvas.height;
  camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 1000);
  camera.position.z = 5;

  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.sortObjects = true;

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.2);
  directionalLight.position.set(0, 1, 2);
  scene.add(directionalLight);

  const backLight = new THREE.DirectionalLight(0xffffff, 0.5);
  backLight.position.set(0, -1, -2);
  scene.add(backLight);

  new RGBELoader().setPath('https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/equirectangular/')
    .load('venice_sunset_1k.hdr',
      (hdrTexture) => {
        hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
        scene.environment = hdrTexture;
      },
      undefined,
      () => console.log('HDR not loaded, using basic lighting')
    );

  const loader = new GLTFLoader();
  loader.load('./boucle2.glb',
    (gltf) => {
      const modelTemplate = gltf.scene;

      const box = new THREE.Box3().setFromObject(modelTemplate);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 0.42 / maxDim;
      baseEarringScale = scale;
      const topAnchor = computeTopAnchorPoint(modelTemplate);

      const leftModel = modelTemplate.clone(true);
      leftModel.position.set(-topAnchor.x, -topAnchor.y, -topAnchor.z);
      leftModel.quaternion.copy(BASE_ROT_LEFT);

      earringLeft = new THREE.Group();
      earringLeft.add(leftModel);
      earringLeft.visible = false;
      earringLeft.renderOrder = 1;
      scene.add(earringLeft);

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

  if (ENABLE_EAR_OCCLUDERS) {
    leftEarOccluder = createEarOccluder(LEFT_EAR_OCCLUDER_POINTS.length);
    rightEarOccluder = createEarOccluder(RIGHT_EAR_OCCLUDER_POINTS.length);
    scene.add(leftEarOccluder);
    scene.add(rightEarOccluder);
  }

  window.addEventListener('resize', () => {
    renderer.setSize(canvas.width, canvas.height, false);

    const nextAspect = (canvas.width || 1) / (canvas.height || 1);
    camera.left = -nextAspect;
    camera.right = nextAspect;
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

  const { landmarks, earLobes, rot9, mirrorPreview, cover } = data;
  const sceneAspect = getSceneAspect();

  let leftPos;
  let rightPos;

  if (landmarks && landmarks.length >= 468) {
    leftPos = calculateInterpolatedLobule(landmarks, 'LEFT');
    rightPos = calculateInterpolatedLobule(landmarks, 'RIGHT');
  } else {
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

  const smoothedLeft = kalmanLeft.filter(leftPos);
  const smoothedRight = kalmanRight.filter(rightPos);

  const poseDepthZ = mapPoseDepthToSceneZ(data.tvec?.z);
  if (ENABLE_EAR_OCCLUDERS) {
    updateEarOccluders(landmarks, mirrorPreview, poseDepthZ);
  }
  const yaw = estimateYawFromRot9(rot9);
  const earVisibility = getEarVisibilityFromDepth(landmarks, yaw);

  const leftDepthZ = poseDepthZ + THREE.MathUtils.clamp((smoothedLeft.z || 0) * LANDMARK_Z_SCALE, -0.2, 0.2);
  const rightDepthZ = poseDepthZ + THREE.MathUtils.clamp((smoothedRight.z || 0) * LANDMARK_Z_SCALE, -0.2, 0.2);

  const left2d = mapLandmarkToScene(smoothedLeft, mirrorPreview, cover, sceneAspect);
  const lx = left2d.x;
  const ly = left2d.y;
  earringLeft.position.set(lx, ly, leftDepthZ);

  const right2d = mapLandmarkToScene(smoothedRight, mirrorPreview, cover, sceneAspect);
  const rx = right2d.x;
  const ry = right2d.y;
  earringRight.position.set(rx, ry, rightDepthZ);

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

  const rawDist = Math.abs(data.tvec?.z || 500);
  smoothedDist = THREE.MathUtils.lerp(smoothedDist, rawDist, 0.25);
  const scaleFactor = Math.max(0.9, Math.min(2.6, 460 / Math.max(120, smoothedDist)));
  const baseScale = baseEarringScale || Math.abs(earringLeft.scale.x) || 0.01;
  const currentScale = baseScale * scaleFactor * userScaleMultiplier;

  earringLeft.scale.setScalar(currentScale);
  earringRight.scale.setScalar(currentScale);

  earringLeft.visible = earVisibility.left;
  earringRight.visible = earVisibility.right;

  renderer.render(scene, camera);
}
