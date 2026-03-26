/**
 * cam.js - WebRTC Camera Capture Module
 * Handles camera stream initialization and management
 */

export class CameraManager {
  constructor() {
    this.video = null;
    this.stream = null;
    this.isActive = false;
    this.constraints = {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
        frameRate: { ideal: 30 }
      },
      audio: false
    };
  }

  /**
   * Initialize camera with video element
   * @param {HTMLVideoElement} videoElement - The video element to attach stream
   * @returns {Promise<MediaStream>}
   */
  async init(videoElement) {
    this.video = videoElement;
    
    try {
      // Check for camera support
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API not supported in this browser');
      }

      // Request camera access
      this.stream = await navigator.mediaDevices.getUserMedia(this.constraints);
      
      // Attach stream to video element
      this.video.srcObject = this.stream;
      
      // Wait for video to be ready
      await new Promise((resolve, reject) => {
        this.video.onloadedmetadata = () => {
          this.video.play()
            .then(() => {
              this.isActive = true;
              resolve();
            })
            .catch(reject);
        };
        this.video.onerror = reject;
      });

      console.log('📷 Camera initialized:', this.getVideoInfo());
      return this.stream;

    } catch (error) {
      console.error('Camera initialization failed:', error);
      throw this.handleCameraError(error);
    }
  }

  /**
   * Get video dimensions and info
   * @returns {Object}
   */
  getVideoInfo() {
    if (!this.video) return null;
    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      aspectRatio: this.video.videoWidth / this.video.videoHeight
    };
  }

  /**
   * Switch between front and back camera (mobile)
   * @returns {Promise<void>}
   */
  async switchCamera() {
    const currentFacing = this.constraints.video.facingMode;
    this.constraints.video.facingMode = currentFacing === 'user' ? 'environment' : 'user';
    
    // Stop current stream
    this.stop();
    
    // Reinitialize with new facing mode
    await this.init(this.video);
  }

  /**
   * Stop camera stream
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
    this.isActive = false;
    console.log('📷 Camera stopped');
  }

  /**
   * Pause video stream
   */
  pause() {
    if (this.video && this.isActive) {
      this.video.pause();
    }
  }

  /**
   * Resume video stream
   */
  resume() {
    if (this.video && this.stream) {
      this.video.play();
    }
  }

  /**
   * Handle camera errors with user-friendly messages
   * @param {Error} error
   * @returns {Error}
   */
  handleCameraError(error) {
    const errorMessages = {
      'NotAllowedError': 'Camera access denied. Please allow camera permissions.',
      'NotFoundError': 'No camera found on this device.',
      'NotReadableError': 'Camera is already in use by another application.',
      'OverconstrainedError': 'Camera does not support the requested resolution.',
      'SecurityError': 'Camera access blocked due to security restrictions.'
    };

    const message = errorMessages[error.name] || `Camera error: ${error.message}`;
    return new Error(message);
  }

  /**
   * Check if camera is available
   * @returns {Promise<boolean>}
   */
  static async isAvailable() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some(device => device.kind === 'videoinput');
    } catch {
      return false;
    }
  }
}
