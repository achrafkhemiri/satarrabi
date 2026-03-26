/**
 * pose.js - 3D Pose Estimation & Smoothing
 * Calculates face rotation and applies professional-grade smoothing
 */

/**
 * PRO Exponential Smoother with adaptive alpha
 */
export class Smoother {
  constructor(alpha = 0.7) {
    this.alpha = alpha;
    this.prev = null;
  }

  smooth(point) {
    if (!point) return this.prev;
    
    if (!this.prev) {
      this.prev = { ...point };
      return point;
    }

    const smoothed = {
      x: this.prev.x * this.alpha + point.x * (1 - this.alpha),
      y: this.prev.y * this.alpha + point.y * (1 - this.alpha),
      z: this.prev.z * this.alpha + point.z * (1 - this.alpha)
    };

    this.prev = smoothed;
    return smoothed;
  }

  reset() {
    this.prev = null;
  }

  setAlpha(alpha) {
    this.alpha = Math.max(0, Math.min(1, alpha));
  }
}

/**
 * One Euro Filter - Industry standard for low-latency tracking
 * Used by Snapchat, Instagram filters
 */
export class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = null;
    this.tPrev = null;
  }

  smoothingFactor(tE, cutoff) {
    const r = 2 * Math.PI * cutoff * tE;
    return r / (r + 1);
  }

  exponentialSmoothing(a, x, xPrev) {
    return a * x + (1 - a) * xPrev;
  }

  filter(x, t = null) {
    if (t === null) t = Date.now() / 1000;
    
    if (this.xPrev === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = t;
      return x;
    }

    const tE = t - this.tPrev;
    if (tE <= 0) return this.xPrev;

    const aD = this.smoothingFactor(tE, this.dCutoff);
    const dx = (x - this.xPrev) / tE;
    const dxHat = this.exponentialSmoothing(aD, dx, this.dxPrev);

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.smoothingFactor(tE, cutoff);
    const xHat = this.exponentialSmoothing(a, x, this.xPrev);

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.tPrev = t;

    return xHat;
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = null;
    this.tPrev = null;
  }
}

/**
 * PRO 3D Point Filter - Industry grade
 * Combines OneEuro with dead zone for maximum stability
 */
export class Point3DFilter {
  constructor(config = {}) {
    const { minCutoff = 1.0, beta = 0.007, dCutoff = 1.0, deadZone = 0.001 } = config;
    this.filterX = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.filterY = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.filterZ = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.deadZone = deadZone;
    this.lastOutput = null;
  }

  filter(point, t = null) {
    if (!point) return this.lastOutput;
    
    let filtered = {
      x: this.filterX.filter(point.x, t),
      y: this.filterY.filter(point.y, t),
      z: this.filterZ.filter(point.z, t)
    };

    // Apply dead zone to prevent micro-jitter
    if (this.lastOutput) {
      const dx = Math.abs(filtered.x - this.lastOutput.x);
      const dy = Math.abs(filtered.y - this.lastOutput.y);
      const dz = Math.abs(filtered.z - this.lastOutput.z);
      
      if (dx < this.deadZone) filtered.x = this.lastOutput.x;
      if (dy < this.deadZone) filtered.y = this.lastOutput.y;
      if (dz < this.deadZone) filtered.z = this.lastOutput.z;
    }

    this.lastOutput = filtered;
    return filtered;
  }

  reset() {
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
    this.lastOutput = null;
  }
}

/**
 * Face Pose Calculator - PRO VERSION
 * Estimates face rotation from landmarks with stabilization
 */
export class PoseEstimator {
  constructor() {
    // Use very smooth filters for rotation (less jitter)
    this.rollFilter = new OneEuroFilter(0.5, 0.005, 1.0);
    this.pitchFilter = new OneEuroFilter(0.5, 0.005, 1.0);
    this.yawFilter = new OneEuroFilter(0.5, 0.005, 1.0);
    
    // Dead zone for rotation (ignore tiny movements)
    this.rotationDeadZone = 0.01; // ~0.5 degrees
    this.lastRotation = { roll: 0, pitch: 0, yaw: 0 };
  }

  /**
   * Calculate face rotation from landmarks - PRO VERSION
   * @param {Array} landmarks - Full face landmarks array
   * @returns {Object} - {roll, pitch, yaw} in radians
   */
  calculate(landmarks) {
    if (!landmarks || landmarks.length < 468) {
      return this.lastRotation;
    }

    // Key points for rotation calculation
    const nose = landmarks[1];
    const chin = landmarks[152];
    const forehead = landmarks[10];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    
    // Use ear lobe points for better yaw calculation
    const leftEar = landmarks[172];
    const rightEar = landmarks[397];

    // Roll - head tilt left/right (most important for earrings)
    const eyeDx = rightEye.x - leftEye.x;
    const eyeDy = rightEye.y - leftEye.y;
    let roll = Math.atan2(eyeDy, eyeDx);

    // Pitch - head up/down
    const faceHeight = chin.y - forehead.y;
    const depthDiff = (chin.z - forehead.z);
    let pitch = Math.atan2(depthDiff * 2, faceHeight);

    // Yaw - head left/right rotation (using ears for better accuracy)
    const earWidth = Math.abs(rightEar.x - leftEar.x);
    const noseCenterX = (leftEar.x + rightEar.x) / 2;
    const noseOffset = nose.x - noseCenterX;
    let yaw = Math.asin(Math.max(-0.8, Math.min(0.8, noseOffset / (earWidth * 0.4))));

    // Apply smoothing filters
    const t = Date.now() / 1000;
    roll = this.rollFilter.filter(roll, t);
    pitch = this.pitchFilter.filter(pitch, t);
    yaw = this.yawFilter.filter(yaw, t);

    // Apply dead zone
    if (Math.abs(roll - this.lastRotation.roll) < this.rotationDeadZone) {
      roll = this.lastRotation.roll;
    }
    if (Math.abs(pitch - this.lastRotation.pitch) < this.rotationDeadZone) {
      pitch = this.lastRotation.pitch;
    }
    if (Math.abs(yaw - this.lastRotation.yaw) < this.rotationDeadZone) {
      yaw = this.lastRotation.yaw;
    }

    this.lastRotation = { roll, pitch, yaw };
    return this.lastRotation;
  }

  reset() {
    this.rollFilter.reset();
    this.pitchFilter.reset();
    this.yawFilter.reset();
    this.lastRotation = { roll: 0, pitch: 0, yaw: 0 };
  }

  /**
   * Calculate scale factor based on face size (ear-to-ear distance)
   * @param {Object} leftEar
   * @param {Object} rightEar
   * @returns {number}
   */
  calculateScale(leftEar, rightEar) {
    const dx = rightEar.x - leftEar.x;
    const dy = rightEar.y - leftEar.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    // Normalize: typical face width is ~0.25-0.4 of screen
    return distance / 0.30;
  }
}

/**
 * Dead Zone Filter - Ignore tiny movements
 */
export class DeadZoneFilter {
  constructor(threshold = 0.002) {
    this.threshold = threshold;
    this.lastValue = null;
  }

  filter(value) {
    if (this.lastValue === null) {
      this.lastValue = value;
      return value;
    }

    const diff = Math.abs(value - this.lastValue);
    if (diff < this.threshold) {
      return this.lastValue;
    }

    this.lastValue = value;
    return value;
  }

  reset() {
    this.lastValue = null;
  }
}
