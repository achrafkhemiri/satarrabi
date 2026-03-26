/**
 * main.js - Earring Try-On with Three.js
 * Uses OpenCV solvePnP for precise 3D pose estimation
 */

import * as THREE from 'three';
import { GLTFLoader } from 'jsm/loaders/GLTFLoader.js';

let scene, camera, renderer;
let earringLeft, earringRight;
let config = null;
let baseScale = 0.08; // Base scale for earrings

// Position offsets for ear lobes (tweak these for perfect placement)
const OFFSETS = {
  LEFT: { x: -0.008, y: 0.01 },   // Towards ear, slightly down
  RIGHT: { x: 0.008, y: 0.01 }    // Towards ear, slightly down
};

// Smoothing for positions
class Smoother {
  constructor(alpha = 0.5) {
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

const smoothLeft = new Smoother(0.5);
const smoothRight = new Smoother(0.5);

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
  
  // Lighting - bright and clear
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambientLight);
  
  const frontLight = new THREE.DirectionalLight(0xffffff, 1.5);
  frontLight.position.set(0, 0, 5);
  scene.add(frontLight);
  
  const topLight = new THREE.DirectionalLight(0xffffff, 0.8);
  topLight.position.set(0, 5, 2);
  scene.add(topLight);
  
  const backLight = new THREE.DirectionalLight(0xffffff, 0.4);
  backLight.position.set(0, -1, -3);
  scene.add(backLight);
  
  // Load 3D earring model
  const loader = new GLTFLoader();
  loader.load('./boucle2.glb',
    (gltf) => {
      const model = gltf.scene;
      
      // Normalize scale
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const normScale = 1.0 / maxDim;
      model.scale.set(normScale, normScale, normScale);
      
      // Center
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center.multiplyScalar(normScale));
      
      // Create left earring
      earringLeft = model.clone();
      earringLeft.visible = false;
      scene.add(earringLeft);
      
      // Create right earring (mirrored)
      earringRight = model.clone();
      earringRight.visible = false;
      scene.add(earringRight);
      
      console.log('✓ 3D earring model loaded');
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
    
    const newAspect = w / h;
    camera.left = -newAspect;
    camera.right = newAspect;
    camera.updateProjectionMatrix();
  });
}

export function updateEarringTryOn(data) {
  if (!renderer) return;
  
  // Always render even if no earrings
  if (!earringLeft || !earringRight || !data.earLobes) {
    renderer.render(scene, camera);
    return;
  }
  
  const showEarrings = config?.showEarrings?.() ?? true;
  if (!showEarrings) {
    earringLeft.visible = false;
    earringRight.visible = false;
    renderer.render(scene, camera);
    return;
  }
  
  const { earLobes, rot9, w, h, mirrorPreview } = data;
  const aspect = w / h;
  
  // Apply offsets to ear lobe positions
  const leftPos = {
    x: earLobes.left.x + OFFSETS.LEFT.x,
    y: earLobes.left.y + OFFSETS.LEFT.y,
    z: earLobes.left.z || 0
  };
  
  const rightPos = {
    x: earLobes.right.x + OFFSETS.RIGHT.x,
    y: earLobes.right.y + OFFSETS.RIGHT.y,
    z: earLobes.right.z || 0
  };
  
  // Smooth positions
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
  
  // Position earrings
  const lx = toThreeX(smoothedLeft.x, mirrorPreview);
  const ly = toThreeY(smoothedLeft.y);
  earringLeft.position.set(lx, ly, 0);
  
  const rx = toThreeX(smoothedRight.x, mirrorPreview);
  const ry = toThreeY(smoothedRight.y);
  earringRight.position.set(rx, ry, 0);
  
  // Apply rotation from OpenCV pose
  if (rot9 && rot9.length === 9) {
    const rotMat = new THREE.Matrix4().set(
      rot9[0], rot9[1], rot9[2], 0,
      rot9[3], rot9[4], rot9[5], 0,
      rot9[6], rot9[7], rot9[8], 0,
      0, 0, 0, 1
    );
    
    const euler = new THREE.Euler().setFromRotationMatrix(rotMat, 'XYZ');
    
    // Apply rotation with dampening
    earringLeft.rotation.x = euler.x * 0.3;
    earringLeft.rotation.y = euler.y * 0.4;
    earringLeft.rotation.z = euler.z * 0.4;
    
    earringRight.rotation.x = euler.x * 0.3;
    earringRight.rotation.y = -euler.y * 0.4;
    earringRight.rotation.z = -euler.z * 0.4;
  }
  
  // Scale based on distance (bigger when closer)
  const dist = data.tvec?.z || 500;
  const distScale = Math.max(0.6, Math.min(1.5, 450 / Math.abs(dist)));
  const finalScale = baseScale * distScale;
  
  earringLeft.scale.set(finalScale, finalScale, finalScale);
  earringRight.scale.set(-finalScale, finalScale, finalScale); // Mirror X
  
  // Make visible
  earringLeft.visible = true;
  earringRight.visible = true;
  
  // Render
  renderer.render(scene, camera);
}
