/**
 * main.js - Earring Try-On with Three.js
 * Uses OpenCV solvePnP for precise 3D pose estimation
 */

import * as THREE from 'three';
import { GLTFLoader } from 'jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'jsm/loaders/RGBELoader.js';

let scene, camera, renderer;
let earringLeft, earringRight;
let config = null;

// Position offsets for ear lobes (tweak these for perfect placement)
const OFFSETS = {
  LEFT: { x: -0.012, y: -0.015 },   // Screen right (user's left)
  RIGHT: { x: 0.012, y: -0.015 }    // Screen left (user's right)
};

// Smoothing for positions
class Smoother {
  constructor(alpha = 0.4) {
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

const smoothLeft = new Smoother(0.6);
const smoothRight = new Smoother(0.6);

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
      const model = gltf.scene;
      
      // Normalize scale
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 0.15 / maxDim;
      model.scale.set(scale, scale, scale);
      
      // Center
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center.multiplyScalar(scale));
      
      // Create left earring
      earringLeft = model.clone();
      earringLeft.visible = false;
      scene.add(earringLeft);
      
      // Create right earring (mirrored)
      earringRight = model.clone();
      earringRight.scale.x *= -1; // Mirror
      earringRight.visible = false;
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
  // Left ear (user's left = screen right when mirrored)
  const lx = toThreeX(smoothedLeft.x, mirrorPreview);
  const ly = toThreeY(smoothedLeft.y);
  earringLeft.position.set(lx, ly, smoothedLeft.z * 2);
  
  // Right ear (user's right = screen left when mirrored)
  const rx = toThreeX(smoothedRight.x, mirrorPreview);
  const ry = toThreeY(smoothedRight.y);
  earringRight.position.set(rx, ry, smoothedRight.z * 2);
  
  // Apply rotation from OpenCV pose
  if (rot9 && rot9.length === 9) {
    const rotMat = new THREE.Matrix4().set(
      rot9[0], rot9[1], rot9[2], 0,
      rot9[3], rot9[4], rot9[5], 0,
      rot9[6], rot9[7], rot9[8], 0,
      0, 0, 0, 1
    );
    
    const euler = new THREE.Euler().setFromRotationMatrix(rotMat, 'XYZ');
    
    // Apply rotation with some dampening
    earringLeft.rotation.x = euler.x * 0.3;
    earringLeft.rotation.y = euler.y * 0.5;
    earringLeft.rotation.z = euler.z * 0.5;
    
    earringRight.rotation.x = euler.x * 0.3;
    earringRight.rotation.y = -euler.y * 0.5; // Mirror Y rotation
    earringRight.rotation.z = -euler.z * 0.5; // Mirror Z rotation
  }
  
  // Scale based on distance
  const dist = data.tvec?.z || 500;
  const scaleFactor = Math.max(0.5, Math.min(2, 500 / Math.abs(dist)));
  const baseScale = earringLeft.scale.x;
  
  earringLeft.scale.setScalar(baseScale * scaleFactor);
  earringRight.scale.setScalar(baseScale * scaleFactor);
  earringRight.scale.x *= -1; // Keep mirror
  
  // Make visible
  earringLeft.visible = true;
  earringRight.visible = true;
  
  // Render
  renderer.render(scene, camera);
}
