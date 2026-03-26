/**
 * earring.js - Earring Asset Manager
 * Handles loading and management of earring assets (2D and 3D)
 */

export class EarringManager {
  constructor() {
    this.earrings = new Map();
    this.currentEarring = null;
    this.gltfLoader = null;
    this.textureLoader = null;
  }

  /**
   * Initialize loaders for Three.js (if available)
   * @param {Object} THREE - Three.js namespace
   */
  initThreeLoaders(THREE) {
    if (THREE) {
      this.textureLoader = new THREE.TextureLoader();
      // GLTFLoader should be imported separately
    }
  }

  /**
   * Register a 2D sprite earring
   * @param {Object} config - Earring configuration
   */
  register2D(config) {
    const { id, name, src, offsetX = 0, offsetY = 0.02, scale = 1 } = config;
    
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    
    const earring = {
      id,
      name,
      type: '2d',
      image: img,
      loaded: false,
      offsetX,
      offsetY,
      scale,
      thumbnail: src
    };

    img.onload = () => {
      earring.loaded = true;
      earring.aspectRatio = img.width / img.height;
      console.log(`💎 Loaded earring: ${name}`);
    };

    img.onerror = () => {
      console.error(`Failed to load earring: ${name}`);
    };

    this.earrings.set(id, earring);
    return earring;
  }

  /**
   * Register a 3D glTF earring
   * @param {Object} config - Earring configuration
   */
  async register3D(config) {
    const { id, name, src, thumbnail, scale = 1, rotation = { x: 0, y: 0, z: 0 } } = config;

    const earring = {
      id,
      name,
      type: '3d',
      src,
      model: null,
      loaded: false,
      scale,
      rotation,
      thumbnail
    };

    this.earrings.set(id, earring);
    return earring;
  }

  /**
   * Load a 3D model using GLTFLoader
   * @param {string} id - Earring ID
   * @param {Object} GLTFLoader - GLTFLoader instance
   * @returns {Promise<Object>}
   */
  async load3DModel(id, GLTFLoader) {
    const earring = this.earrings.get(id);
    if (!earring || earring.type !== '3d') return null;

    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(
        earring.src,
        (gltf) => {
          earring.model = gltf.scene;
          earring.loaded = true;
          console.log(`💎 Loaded 3D earring: ${earring.name}`);
          resolve(earring);
        },
        undefined,
        reject
      );
    });
  }

  /**
   * Select an earring as current
   * @param {string} id
   * @returns {Object|null}
   */
  select(id) {
    if (!this.earrings.has(id)) {
      console.warn(`Earring not found: ${id}`);
      return null;
    }
    this.currentEarring = this.earrings.get(id);
    return this.currentEarring;
  }

  /**
   * Get current earring
   * @returns {Object|null}
   */
  getCurrent() {
    return this.currentEarring;
  }

  /**
   * Get all registered earrings
   * @returns {Array}
   */
  getAll() {
    return Array.from(this.earrings.values());
  }

  /**
   * Get earring by ID
   * @param {string} id
   * @returns {Object|null}
   */
  get(id) {
    return this.earrings.get(id) || null;
  }

  /**
   * Create default earring catalog
   */
  loadDefaultCatalog() {
    // Simple geometric earrings as SVG data URLs
    const earringDesigns = [
      {
        id: 'gold-drop',
        name: 'Gold Drop',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 80">
          <defs>
            <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#FFD700"/>
              <stop offset="50%" style="stop-color:#FFA500"/>
              <stop offset="100%" style="stop-color:#FFD700"/>
            </linearGradient>
          </defs>
          <circle cx="20" cy="8" r="6" fill="url(#gold)" stroke="#DAA520" stroke-width="1"/>
          <line x1="20" y1="14" x2="20" y2="35" stroke="url(#gold)" stroke-width="2"/>
          <ellipse cx="20" cy="55" rx="15" ry="20" fill="url(#gold)" stroke="#DAA520" stroke-width="1"/>
        </svg>`
      },
      {
        id: 'silver-hoop',
        name: 'Silver Hoop',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 70">
          <defs>
            <linearGradient id="silver" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#E8E8E8"/>
              <stop offset="50%" style="stop-color:#C0C0C0"/>
              <stop offset="100%" style="stop-color:#E8E8E8"/>
            </linearGradient>
          </defs>
          <circle cx="30" cy="8" r="5" fill="url(#silver)" stroke="#A0A0A0" stroke-width="1"/>
          <circle cx="30" cy="40" r="25" fill="none" stroke="url(#silver)" stroke-width="4"/>
        </svg>`
      },
      {
        id: 'ruby-stud',
        name: 'Ruby Stud',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 50">
          <defs>
            <radialGradient id="ruby" cx="50%" cy="30%" r="50%">
              <stop offset="0%" style="stop-color:#FF6B6B"/>
              <stop offset="100%" style="stop-color:#C0392B"/>
            </radialGradient>
            <linearGradient id="goldBase" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#FFD700"/>
              <stop offset="100%" style="stop-color:#B8860B"/>
            </linearGradient>
          </defs>
          <circle cx="20" cy="25" r="18" fill="url(#goldBase)"/>
          <circle cx="20" cy="25" r="12" fill="url(#ruby)"/>
          <ellipse cx="15" cy="20" rx="3" ry="2" fill="rgba(255,255,255,0.4)"/>
        </svg>`
      },
      {
        id: 'pearl-drop',
        name: 'Pearl Drop',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 90">
          <defs>
            <radialGradient id="pearl" cx="30%" cy="30%" r="70%">
              <stop offset="0%" style="stop-color:#FFFFFF"/>
              <stop offset="100%" style="stop-color:#E8E8E8"/>
            </radialGradient>
            <linearGradient id="chain" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:#FFD700"/>
              <stop offset="100%" style="stop-color:#DAA520"/>
            </linearGradient>
          </defs>
          <circle cx="20" cy="8" r="5" fill="url(#chain)"/>
          <line x1="20" y1="13" x2="20" y2="45" stroke="url(#chain)" stroke-width="2"/>
          <circle cx="20" cy="65" r="20" fill="url(#pearl)" stroke="#D0D0D0" stroke-width="1"/>
          <ellipse cx="12" cy="58" rx="4" ry="3" fill="rgba(255,255,255,0.6)"/>
        </svg>`
      },
      {
        id: 'diamond-stud',
        name: 'Diamond Stud',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
          <defs>
            <linearGradient id="diamond" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#FFFFFF"/>
              <stop offset="25%" style="stop-color:#E0FFFF"/>
              <stop offset="50%" style="stop-color:#B0E0E6"/>
              <stop offset="75%" style="stop-color:#E0FFFF"/>
              <stop offset="100%" style="stop-color:#FFFFFF"/>
            </linearGradient>
            <linearGradient id="platinum" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#E5E4E2"/>
              <stop offset="100%" style="stop-color:#A9A9A9"/>
            </linearGradient>
          </defs>
          <circle cx="25" cy="25" r="20" fill="url(#platinum)"/>
          <polygon points="25,8 35,20 32,35 18,35 15,20" fill="url(#diamond)" stroke="#C0C0C0" stroke-width="0.5"/>
          <polygon points="25,8 15,20 18,35 25,40 32,35 35,20" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="0.5"/>
        </svg>`
      },
      {
        id: 'emerald-drop',
        name: 'Emerald Drop',
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 100">
          <defs>
            <linearGradient id="emerald" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#50C878"/>
              <stop offset="50%" style="stop-color:#2E8B57"/>
              <stop offset="100%" style="stop-color:#50C878"/>
            </linearGradient>
            <linearGradient id="goldSetting" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#FFD700"/>
              <stop offset="100%" style="stop-color:#B8860B"/>
            </linearGradient>
          </defs>
          <circle cx="20" cy="8" r="6" fill="url(#goldSetting)"/>
          <rect x="18" y="14" width="4" height="25" fill="url(#goldSetting)"/>
          <rect x="10" cy="45" width="20" height="45" rx="3" fill="url(#emerald)" stroke="#1E6B3A" stroke-width="1"/>
          <line x1="15" y1="50" x2="15" y2="85" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
        </svg>`
      }
    ];

    // Convert SVGs to data URLs and register
    earringDesigns.forEach(design => {
      const svgBlob = new Blob([design.svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);
      
      this.register2D({
        id: design.id,
        name: design.name,
        src: url,
        scale: 1.2,
        offsetY: 0.02
      });
    });

    // Set default selection
    if (earringDesigns.length > 0) {
      this.select(earringDesigns[0].id);
    }

    console.log(`💎 Loaded ${earringDesigns.length} default earrings`);
  }

  /**
   * Dispose all resources
   */
  dispose() {
    this.earrings.forEach(earring => {
      if (earring.type === '2d' && earring.image.src.startsWith('blob:')) {
        URL.revokeObjectURL(earring.image.src);
      }
    });
    this.earrings.clear();
    this.currentEarring = null;
  }
}
