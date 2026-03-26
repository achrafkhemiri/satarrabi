/**
 * renderer.js - Canvas 2D and Three.js Rendering
 * Handles drawing earrings on the video feed
 */

/**
 * Canvas 2D Renderer for sprite-based earrings
 */
export class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.videoWidth = 0;
    this.videoHeight = 0;
  }

  /**
   * Set canvas size to match video
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    this.videoWidth = width;
    this.videoHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /**
   * Clear the canvas
   */
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Draw video frame (mirrored)
   * @param {HTMLVideoElement} video
   */
  drawVideo(video) {
    this.ctx.save();
    this.ctx.scale(-1, 1);
    this.ctx.drawImage(video, -this.canvas.width, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
  }

  /**
   * Draw earring at ear lobe position - PRO VERSION
   * @param {Object} earring - Earring object with image
   * @param {Object} position - Normalized position {x, y, z}
   * @param {Object} rotation - Face rotation {roll, pitch, yaw}
   * @param {number} scale - Scale factor
   * @param {boolean} isLeft - Is left earring
   */
  drawEarring(earring, position, rotation, scale = 1, isLeft = true) {
    if (!earring || !earring.loaded || !position) return;

    const { image, offsetX, offsetY, aspectRatio } = earring;
    
    // PRO: Add vertical offset - earring hangs BELOW the lobe
    const lobeOffsetY = 0.015; // Offset below ear lobe point
    
    // Convert normalized coords to canvas coords (mirrored)
    const x = (1 - position.x) * this.canvas.width;
    const y = (position.y + lobeOffsetY + (offsetY || 0)) * this.canvas.height;
    
    // Base size relative to canvas - adjusted for realistic size
    const baseSize = this.canvas.width * 0.055 * (earring.scale || 1) * scale;
    const width = baseSize;
    const height = baseSize / (aspectRatio || 0.5);

    // Apply transformations
    this.ctx.save();
    this.ctx.translate(x, y);
    
    // Apply rotation (roll) - earring tilts with head
    this.ctx.rotate(rotation.roll || 0);
    
    // PRO: Apply perspective based on yaw (head turn)
    // When turning head, earring on far side appears smaller
    const yawScale = isLeft 
      ? 1 - Math.max(0, rotation.yaw) * 0.3 
      : 1 + Math.min(0, rotation.yaw) * 0.3;
    
    // Slight skew based on pitch (head up/down)
    if (rotation.pitch) {
      this.ctx.transform(1, 0, Math.sin(rotation.pitch) * 0.2, 1, 0, 0);
    }

    // Draw shadow first (offset based on lighting)
    this.ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    this.ctx.shadowBlur = 8;
    this.ctx.shadowOffsetX = 2;
    this.ctx.shadowOffsetY = 4;

    // Draw earring centered horizontally, hanging from top
    const finalWidth = width * yawScale;
    const finalHeight = height * yawScale;
    
    this.ctx.drawImage(
      image,
      -finalWidth / 2,
      0,  // Hang from the attachment point (top)
      finalWidth,
      finalHeight
    );

    this.ctx.restore();
  }

  /**
   * Draw debug landmarks - with correct ear lobe points #132 and #361
   * @param {Array} landmarks
   * @param {Array} indices - Specific indices to highlight
   */
  drawDebugLandmarks(landmarks, indices = [132, 361, 1, 152, 10]) {
    if (!landmarks) return;

    this.ctx.save();
    
    // Draw all landmarks as small dots
    this.ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
    landmarks.forEach((lm, i) => {
      const x = (1 - lm.x) * this.canvas.width;
      const y = lm.y * this.canvas.height;
      this.ctx.beginPath();
      this.ctx.arc(x, y, 1, 0, Math.PI * 2);
      this.ctx.fill();
    });

    // Highlight ear lobe points in CYAN - #132 (left) and #361 (right)
    this.ctx.fillStyle = '#00ffff';
    this.ctx.font = 'bold 12px monospace';
    [132, 361].forEach(idx => {
      if (landmarks[idx]) {
        const lm = landmarks[idx];
        const x = (1 - lm.x) * this.canvas.width;
        const y = lm.y * this.canvas.height;
        
        this.ctx.beginPath();
        this.ctx.arc(x, y, 6, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.fillText(`#${idx}`, x + 10, y);
      }
    });

    // Highlight other reference points in RED
    this.ctx.fillStyle = '#ff0000';
    this.ctx.font = '11px monospace';
    indices.filter(i => i !== 132 && i !== 361).forEach(idx => {
      if (landmarks[idx]) {
        const lm = landmarks[idx];
        const x = (1 - lm.x) * this.canvas.width;
        const y = lm.y * this.canvas.height;
        
        this.ctx.beginPath();
        this.ctx.arc(x, y, 4, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.fillText(`#${idx}`, x + 8, y);
      }
    });

    this.ctx.restore();
  }

  /**
   * Draw FPS counter
   * @param {number} fps
   */
  drawFPS(fps) {
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    this.ctx.fillRect(10, 10, 70, 25);
    this.ctx.fillStyle = '#00ff00';
    this.ctx.font = '14px monospace';
    this.ctx.fillText(`${fps.toFixed(1)} FPS`, 15, 28);
    this.ctx.restore();
  }

  /**
   * Draw "No Face Detected" message
   */
  drawNoFace() {
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    this.ctx.fillRect(
      this.canvas.width / 2 - 100,
      this.canvas.height / 2 - 20,
      200,
      40
    );
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = '16px sans-serif';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('No face detected', this.canvas.width / 2, this.canvas.height / 2 + 6);
    this.ctx.restore();
  }

  /**
   * Capture current frame as image
   * @returns {string} - Data URL
   */
  captureFrame() {
    return this.canvas.toDataURL('image/png');
  }
}

/**
 * Three.js Renderer for 3D earrings
 */
export class ThreeJSRenderer {
  constructor(container) {
    this.container = container;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.earringLeft = null;
    this.earringRight = null;
    this.isInitialized = false;
  }

  /**
   * Initialize Three.js scene
   * @param {Object} THREE - Three.js namespace
   * @param {number} width
   * @param {number} height
   */
  init(THREE, width, height) {
    // Scene
    this.scene = new THREE.Scene();

    // Camera - orthographic for 2D overlay
    const aspect = width / height;
    this.camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 100);
    this.camera.position.z = 5;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      premultipliedAlpha: false
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    
    // Add canvas to container
    this.renderer.domElement.id = 'three-canvas';
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.top = '0';
    this.renderer.domElement.style.left = '0';
    this.renderer.domElement.style.pointerEvents = 'none';
    this.container.appendChild(this.renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 2);
    this.scene.add(directionalLight);

    this.isInitialized = true;
    console.log('🎨 Three.js renderer initialized');
  }

  /**
   * Set earring models
   * @param {Object} leftModel
   * @param {Object} rightModel
   */
  setEarringModels(leftModel, rightModel = null) {
    // Remove existing
    if (this.earringLeft) this.scene.remove(this.earringLeft);
    if (this.earringRight) this.scene.remove(this.earringRight);

    // Add new models
    this.earringLeft = leftModel.clone();
    this.earringRight = (rightModel || leftModel).clone();
    this.earringRight.scale.x *= -1; // Mirror

    this.scene.add(this.earringLeft);
    this.scene.add(this.earringRight);
  }

  /**
   * Update earring positions
   * @param {Object} leftPos - Normalized left ear position
   * @param {Object} rightPos - Normalized right ear position
   * @param {Object} rotation - Face rotation
   * @param {number} scale
   */
  update(leftPos, rightPos, rotation, scale = 1) {
    if (!this.isInitialized || !leftPos || !rightPos) return;

    const aspect = this.renderer.domElement.width / this.renderer.domElement.height;

    // Convert normalized coords to Three.js coords
    // Note: Three.js uses center origin, y-up
    if (this.earringLeft) {
      this.earringLeft.position.set(
        (1 - leftPos.x - 0.5) * 2 * aspect,
        -(leftPos.y - 0.5) * 2,
        -leftPos.z * 2
      );
      this.earringLeft.rotation.set(rotation.pitch, rotation.yaw, rotation.roll);
      this.earringLeft.scale.setScalar(scale * 0.1);
    }

    if (this.earringRight) {
      this.earringRight.position.set(
        (1 - rightPos.x - 0.5) * 2 * aspect,
        -(rightPos.y - 0.5) * 2,
        -rightPos.z * 2
      );
      this.earringRight.rotation.set(rotation.pitch, -rotation.yaw, -rotation.roll);
      this.earringRight.scale.setScalar(scale * 0.1);
    }
  }

  /**
   * Render scene
   */
  render() {
    if (!this.isInitialized) return;
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Resize renderer
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    if (!this.isInitialized) return;
    
    const aspect = width / height;
    this.camera.left = -aspect;
    this.camera.right = aspect;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setSize(width, height);
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.renderer) {
      this.renderer.dispose();
      this.container.removeChild(this.renderer.domElement);
    }
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.isInitialized = false;
  }
}
