/**
 * detector.js - MediaPipe Face Mesh Detector
 * Handles face landmark detection using MediaPipe
 */

export class FaceDetector {
  constructor() {
    this.faceMesh = null;
    this.isReady = false;
    this.lastResults = null;
    this.onResultsCallback = null;
    
    // CORRECT landmark indices for ear lobes (VERIFIED positioning)
    this.landmarks = {
      // Left side - #132 is the best for ear lobe ✅
      leftEarLobe: 132,      // Best point for left ear lobe ✅
      leftEarLower: 172,     // Lower point (backup)
      leftEarTop: 234,       // Top of left ear area
      leftCheek: 93,         // Near ear on cheek
      
      // Right side - #361 is the best for ear lobe ✅
      rightEarLobe: 361,     // Best point for right ear lobe ✅
      rightEarLower: 397,    // Lower point (backup)
      rightEarTop: 454,      // Top of right ear area
      rightCheek: 323,       // Near ear on cheek
      
      // Face reference points
      nose: 1,
      chin: 152,
      forehead: 10,
      leftEye: 33,
      rightEye: 263
    };
  }

  /**
   * Initialize MediaPipe Face Mesh
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve, reject) => {
      try {
        // Load FaceMesh from CDN
        this.faceMesh = new window.FaceMesh({
          locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
          }
        });

        // Configure options
        this.faceMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.5
        });

        // Set up results handler
        this.faceMesh.onResults((results) => {
          this.lastResults = results;
          if (this.onResultsCallback) {
            this.onResultsCallback(this.processResults(results));
          }
        });

        // Initialize and wait for ready
        this.faceMesh.initialize().then(() => {
          this.isReady = true;
          console.log('🎭 Face Mesh initialized');
          resolve();
        });

      } catch (error) {
        console.error('Face Mesh initialization failed:', error);
        reject(error);
      }
    });
  }

  /**
   * Process a video frame
   * @param {HTMLVideoElement} video
   * @returns {Promise<void>}
   */
  async detect(video) {
    if (!this.isReady || !video) return null;
    
    try {
      await this.faceMesh.send({ image: video });
    } catch (error) {
      console.error('Detection error:', error);
    }
  }

  /**
   * Process raw MediaPipe results - PRO VERSION
   * Uses points #132 (left) and #361 (right) with fine-tuned offsets
   * @param {Object} results
   * @returns {Object|null}
   */
  processResults(results) {
    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      return null;
    }

    const lm = results.multiFaceLandmarks[0];
    
    // Use the VERIFIED ear lobe points: #132 (left) and #361 (right)
    const leftLobeRaw = lm[this.landmarks.leftEarLobe];   // #132
    const rightLobeRaw = lm[this.landmarks.rightEarLobe]; // #361

    // FINE-TUNED OFFSETS for perfect positioning
    // #132 (right side on screen): move UP and to the LEFT (towards ear)
    const leftLobe = {
      x: leftLobeRaw.x - 0.012,  // Move left (towards ear)
      y: leftLobeRaw.y - 0.015,  // Move up
      z: leftLobeRaw.z
    };

    // #361 (left side on screen): move UP and to the RIGHT (towards ear)
    const rightLobe = {
      x: rightLobeRaw.x + 0.012,  // Move right (towards ear)
      y: rightLobeRaw.y - 0.015,  // Move up
      z: rightLobeRaw.z
    };

    return {
      landmarks: lm,
      earLobes: {
        left: leftLobe,
        right: rightLobe
      },
      faceCenter: lm[this.landmarks.nose],
      chin: lm[this.landmarks.chin],
      forehead: lm[this.landmarks.forehead],
      eyes: {
        left: lm[this.landmarks.leftEye],
        right: lm[this.landmarks.rightEye]
      },
      raw: results
    };
  }

  /**
   * Set callback for results
   * @param {Function} callback
   */
  onResults(callback) {
    this.onResultsCallback = callback;
  }

  /**
   * Get specific landmark by index
   * @param {number} index
   * @returns {Object|null}
   */
  getLandmark(index) {
    if (!this.lastResults || !this.lastResults.multiFaceLandmarks) {
      return null;
    }
    return this.lastResults.multiFaceLandmarks[0]?.[index] || null;
  }

  /**
   * Calculate face bounding box
   * @param {Array} landmarks
   * @returns {Object}
   */
  getFaceBoundingBox(landmarks) {
    if (!landmarks || landmarks.length === 0) return null;

    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    
    landmarks.forEach(lm => {
      minX = Math.min(minX, lm.x);
      maxX = Math.max(maxX, lm.x);
      minY = Math.min(minY, lm.y);
      maxY = Math.max(maxY, lm.y);
    });

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2
    };
  }

  /**
   * Check if face is detected
   * @returns {boolean}
   */
  hasFace() {
    return this.lastResults?.multiFaceLandmarks?.length > 0;
  }

  /**
   * Dispose detector resources
   */
  dispose() {
    if (this.faceMesh) {
      this.faceMesh.close();
      this.faceMesh = null;
    }
    this.isReady = false;
    console.log('🎭 Face Mesh disposed');
  }
}
