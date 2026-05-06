/**
 * ═══════════════════════════════════════════════════════════
 *  Cat & Dog Co-op Escape — client.js
 *  Three.js third-person RPG game with Cloudflare WS multiplayer
 * ═══════════════════════════════════════════════════════════
 *
 *  ARCHITECTURE OVERVIEW
 *  ─────────────────────
 *  1. ThirdPersonCamera  – smooth RPG camera with mouse orbit
 *  2. PlayerController   – WASD movement relative to camera
 *  3. PhysicsWorld       – simple AABB gravity + collision
 *  4. GameWorld          – level geometry (platforms, boxes, door)
 *  5. NetworkManager     – WebSocket sync @ ~20 FPS
 *  6. Game               – orchestrator / main loop
 */

'use strict';

// ═══════════════════════════════════════════════════════════
// 1. CONSTANTS & CONFIG
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  // Camera
  CAM_DISTANCE:    8,        // default follow distance
  CAM_HEIGHT:      3.5,      // height offset above player
  CAM_LERP:        0.10,     // smoothing (lower = smoother)
  CAM_MIN_POLAR:   0.15,     // min vertical angle (radians)
  CAM_MAX_POLAR:   1.45,     // max vertical angle
  CAM_SENSITIVITY: 0.003,    // mouse sensitivity

  // Physics
  GRAVITY:         -22,
  JUMP_FORCE:       9,
  CAT_JUMP_MULT:    1.5,     // cat jumps higher
  MOVE_SPEED:       6,
  DOG_SPEED_MULT:   0.85,    // dog slightly slower but stronger

  // Network
  TICK_RATE:        50,      // ms between sends (20 FPS)
  INTERP_DELAY:     100,     // ms of interpolation buffer

  // World
  GROUND_Y:         0,
};

// Replace with your Cloudflare Worker WebSocket URL after deploying
// For local dev use wrangler dev URL, e.g. ws://localhost:8787
const WS_URL = (location.hostname === 'localhost')
  ? 'ws://localhost:8787'
  : 'wss://cat-dog-escape.YOUR-SUBDOMAIN.workers.dev';  // ← update after deploy

// ═══════════════════════════════════════════════════════════
// 2. UTILITY HELPERS
// ═══════════════════════════════════════════════════════════

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Build a simple low-poly character mesh */
function buildCharacterMesh(isCAT) {
  const group = new THREE.Group();

  const bodyColor = isCAT ? 0xff6b9d : 0x4ecdc4;
  const headColor = isCAT ? 0xff8fb1 : 0x6eddd8;

  // Body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.9, 0.5),
    new THREE.MeshLambertMaterial({ color: bodyColor })
  );
  body.position.y = 0.45;
  body.castShadow = true;
  group.add(body);

  // Head
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.6, 0.55),
    new THREE.MeshLambertMaterial({ color: headColor })
  );
  head.position.y = 1.2;
  head.castShadow = true;
  group.add(head);

  if (isCAT) {
    // Cat ears (triangular prisms via cones)
    const earGeo = new THREE.ConeGeometry(0.12, 0.25, 4);
    const earMat = new THREE.MeshLambertMaterial({ color: 0xe05585 });
    const earL = new THREE.Mesh(earGeo, earMat);
    earL.position.set(-0.18, 1.58, 0); earL.rotation.z = 0.2;
    const earR = new THREE.Mesh(earGeo, earMat);
    earR.position.set( 0.18, 1.58, 0); earR.rotation.z = -0.2;
    group.add(earL, earR);

    // Tail
    const tail = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.03, 0.8, 6),
      new THREE.MeshLambertMaterial({ color: bodyColor })
    );
    tail.position.set(0, 0.6, -0.45);
    tail.rotation.x = 0.8;
    group.add(tail);
  } else {
    // Dog snout
    const snout = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.18, 0.2),
      new THREE.MeshLambertMaterial({ color: 0x38b2ac })
    );
    snout.position.set(0, 1.12, 0.35);
    group.add(snout);

    // Dog ears (floppy)
    const earMat = new THREE.MeshLambertMaterial({ color: 0x2c9e98 });
    const earGeo = new THREE.BoxGeometry(0.18, 0.35, 0.08);
    const earL = new THREE.Mesh(earGeo, earMat);
    earL.position.set(-0.35, 1.1, 0); earL.rotation.z = 0.3;
    const earR = new THREE.Mesh(earGeo, earMat);
    earR.position.set( 0.35, 1.1, 0); earR.rotation.z = -0.3;
    group.add(earL, earR);
  }

  // Legs
  const legMat = new THREE.MeshLambertMaterial({ color: isCAT ? 0xe05585 : 0x2c9e98 });
  const legGeo = new THREE.BoxGeometry(0.22, 0.5, 0.22);
  const positions = [[-0.2,-0.2,0.1],[0.2,-0.2,0.1],[-0.2,-0.2,-0.1],[0.2,-0.2,-0.1]];
  positions.forEach(([x,y,z]) => {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, y, z);
    leg.castShadow = true;
    group.add(leg);
  });

  // Eyes
  const eyeGeo = new THREE.SphereGeometry(0.07, 6, 6);
  const eyeMat = new THREE.MeshLambertMaterial({ color: 0x1a1a2e });
  [-0.15, 0.15].forEach(x => {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(x, 1.25, 0.27);
    group.add(eye);
  });

  return group;
}

// ═══════════════════════════════════════════════════════════
// 3. THIRD-PERSON RPG CAMERA
// ═══════════════════════════════════════════════════════════
/**
 * ThirdPersonCamera
 * ─────────────────
 * Orbits around a target (the local player) using spherical coordinates.
 *
 * State:
 *   theta  → horizontal angle (yaw), controlled by mouse X
 *   phi    → vertical angle (pitch), controlled by mouse Y
 *
 * Every frame:
 *   1. Desired position = target.position + spherical offset
 *   2. Lerp actual camera position toward desired
 *   3. Look at a point slightly above target
 */
class ThirdPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.theta = 0;          // horizontal orbit angle
    this.phi   = 0.6;        // vertical orbit angle (radians)

    // current smoothed position
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._initialized = false;
  }

  /** Feed mouse delta from pointerlockchange handler */
  onMouseMove(dx, dy) {
    this.theta -= dx * CONFIG.CAM_SENSITIVITY;
    this.phi    = clamp(
      this.phi + dy * CONFIG.CAM_SENSITIVITY,
      CONFIG.CAM_MIN_POLAR,
      CONFIG.CAM_MAX_POLAR
    );
  }

  /**
   * Update camera position/lookat each frame.
   * @param {THREE.Vector3} targetPos - world position of the player
   * @param {number} dt - delta time in seconds
   * @param {THREE.Scene} scene - for collision raycasting
   * @param {THREE.Object3D[]} collidables - meshes to avoid clipping
   */
  update(targetPos, dt, scene, collidables) {
    const dist = CONFIG.CAM_DISTANCE;

    // Spherical → Cartesian offset
    // theta: horizontal, phi: vertical
    const sinPhi   = Math.sin(this.phi);
    const cosPhi   = Math.cos(this.phi);
    const sinTheta = Math.sin(this.theta);
    const cosTheta = Math.cos(this.theta);

    const idealOffset = new THREE.Vector3(
      dist * sinPhi * sinTheta,
      dist * cosPhi,
      dist * sinPhi * cosTheta
    );

    const lookAtPoint = targetPos.clone().add(new THREE.Vector3(0, 1.2, 0));
    const idealPos    = targetPos.clone().add(idealOffset);

    // ── Camera collision prevention ──
    // Cast a ray from player toward ideal camera position.
    // If it hits geometry, pull camera closer.
    let finalPos = idealPos.clone();
    if (collidables && collidables.length > 0) {
      const dir = idealOffset.clone().normalize();
      const raycaster = new THREE.Raycaster(lookAtPoint, dir, 0.2, dist);
      const hits = raycaster.intersectObjects(collidables, false);
      if (hits.length > 0) {
        const safeD = Math.max(0.5, hits[0].distance - 0.3);
        finalPos = lookAtPoint.clone().add(dir.multiplyScalar(safeD));
      }
    }

    // Smooth lerp toward desired position
    const speed = CONFIG.CAM_LERP;
    if (!this._initialized) {
      this._pos.copy(finalPos);
      this._initialized = true;
    }
    this._pos.lerp(finalPos, speed);
    this._target.lerp(lookAtPoint, speed);

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._target);
  }

  /**
   * Returns a unit vector in world space pointing in the
   * direction the camera is facing (projected onto XZ plane).
   * Used to make WASD movement camera-relative.
   */
  getForwardVector() {
    const v = new THREE.Vector3(
      Math.sin(this.theta),
      0,
      Math.cos(this.theta)
    );
    return v.normalize();
  }

  getRightVector() {
    const fwd = this.getForwardVector();
    return new THREE.Vector3(-fwd.z, 0, fwd.x); // perpendicular on XZ
  }
}

// ═══════════════════════════════════════════════════════════
// 4. PHYSICS WORLD (simple AABB)
// ═══════════════════════════════════════════════════════════
/**
 * Very lightweight physics for a browser 3D game.
 * No external library — just axis-aligned bounding boxes.
 */
class PhysicsBody {
  constructor(width = 0.7, height = 1.6, depth = 0.5) {
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.size     = new THREE.Vector3(width, height, depth);
    this.onGround = false;
    this.enabled  = true;
  }

  getAABB() {
    const h = this.size;
    return {
      minX: this.position.x - h.x / 2,
      maxX: this.position.x + h.x / 2,
      minY: this.position.y,
      maxY: this.position.y + h.y,
      minZ: this.position.z - h.z / 2,
      maxZ: this.position.z + h.z / 2,
    };
  }
}

class PhysicsWorld {
  constructor() {
    this.bodies  = [];
    this.statics = []; // { aabb, mesh, isPushable, id }
  }

  addBody(body)  { this.bodies.push(body); return body; }
  addStatic(obj) { this.statics.push(obj); }

  step(dt) {
    for (const body of this.bodies) {
      if (!body.enabled) continue;

      // Gravity
      body.velocity.y += CONFIG.GRAVITY * dt;

      // Integrate velocity
      body.position.x += body.velocity.x * dt;
      body.position.y += body.velocity.y * dt;
      body.position.z += body.velocity.z * dt;

      body.onGround = false;

      // Resolve collisions with static geometry
      for (const stat of this.statics) {
        this._resolveAABB(body, stat);
      }

      // World floor
      if (body.position.y < CONFIG.GROUND_Y) {
        body.position.y = CONFIG.GROUND_Y;
        body.velocity.y = 0;
        body.onGround   = true;
      }
    }
  }

  _resolveAABB(body, stat) {
    const b = body.getAABB();
    const s = stat.aabb;

    // Broad phase check
    if (b.maxX < s.minX || b.minX > s.maxX) return;
    if (b.maxY < s.minY || b.minY > s.maxY) return;
    if (b.maxZ < s.minZ || b.minZ > s.maxZ) return;

    // Overlaps on each axis
    const ox = Math.min(b.maxX - s.minX, s.maxX - b.minX);
    const oy = Math.min(b.maxY - s.minY, s.maxY - b.minY);
    const oz = Math.min(b.maxZ - s.minZ, s.maxZ - b.minZ);

    // Push out on minimum overlap axis
    if (oy < ox && oy < oz) {
      if (b.minY < s.minY) {
        body.position.y -= oy;
        body.velocity.y  = Math.min(0, body.velocity.y);
      } else {
        body.position.y += oy;
        body.velocity.y  = 0;
        body.onGround    = true;
      }
    } else if (ox < oz) {
      body.position.x += (b.minX < s.minX) ? -ox : ox;
      body.velocity.x  = 0;
    } else {
      body.position.z += (b.minZ < s.minZ) ? -oz : oz;
      body.velocity.z  = 0;
    }
  }

  /** Rebuild static AABB list from mesh world matrices */
  rebuildStatics(meshes) {
    this.statics = meshes.map(m => {
      const box = new THREE.Box3().setFromObject(m.mesh);
      return {
        aabb: { minX:box.min.x, maxX:box.max.x, minY:box.min.y, maxY:box.max.y, minZ:box.min.z, maxZ:box.max.z },
        mesh: m.mesh,
        isPushable: m.isPushable || false,
        id: m.id || null,
      };
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 5. GAME WORLD (level geometry)
// ═══════════════════════════════════════════════════════════
class GameWorld {
  constructor(scene, physics) {
    this.scene   = scene;
    this.physics = physics;
    this.meshes  = [];
    this.door    = null;
    this.switch  = null;
    this.box     = null;
    this.doorOpen = false;

    this._build();
  }

  _makePlatform(w, h, d, x, y, z, color = 0x7f8c8d) {
    const geo  = new THREE.BoxGeometry(w, h, d);
    const mat  = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + h/2, z);
    mesh.receiveShadow = true;
    mesh.castShadow    = true;
    this.scene.add(mesh);

    const hw = w/2, hh = h, hd = d/2;
    this.meshes.push({
      mesh,
      isPushable: false,
      aabb: {
        minX: x-hw, maxX: x+hw,
        minY: y,    maxY: y+hh,
        minZ: z-hd, maxZ: z+hd,
      },
    });
    return mesh;
  }

  _build() {
    /* ── GROUND ── */
    this._makePlatform(40, 0.5, 40, 0, -0.5, 0, 0x4a7c59);

    /* ── ROOM WALLS (thin) ── */
    // Back
    this._makePlatform(40, 6, 0.5, 0, 0, -15, 0x5d6d7e);
    // Left
    this._makePlatform(0.5, 6, 30, -15, 0, 0, 0x5d6d7e);
    // Right
    this._makePlatform(0.5, 6, 30,  15, 0, 0, 0x5d6d7e);

    /* ── PLATFORMS for cat to climb ── */
    this._makePlatform(3, 0.4, 3, -8, 1.5, -8,  0x8e44ad);
    this._makePlatform(3, 0.4, 3, -8, 3.2, -10, 0x7d3c98);
    this._makePlatform(3, 0.4, 3, -6, 5.0, -12, 0x6c3483);

    /* ── BARRIER that dog must break ── */
    const barrier = this._makePlatform(0.5, 3, 4, 4, 0, -4, 0xc0392b);
    barrier.userData.isBarrier = true;
    this._barrierMesh = barrier;

    /* ── PUSHABLE BOX (dog pushes this) ── */
    const boxGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    const boxMat = new THREE.MeshLambertMaterial({ color: 0xe67e22 });
    this.box     = new THREE.Mesh(boxGeo, boxMat);
    this.box.position.set(-3, 0.75, -3);
    this.box.castShadow = this.box.receiveShadow = true;
    this.scene.add(this.box);

    // Box physics body
    this.boxBody = new PhysicsBody(1.5, 1.5, 1.5);
    this.boxBody.position.set(-3, 0, -3);
    this.physics.addBody(this.boxBody);

    /* ── SWITCH (high platform, cat activates) ── */
    const swGeo = new THREE.BoxGeometry(0.6, 0.2, 0.6);
    const swMat = new THREE.MeshLambertMaterial({ color: 0xf1c40f });
    this.switch  = new THREE.Mesh(swGeo, swMat);
    this.switch.position.set(-6, 5.4, -12);
    this.switch.userData.isSwitch = true;
    this.scene.add(this.switch);

    /* ── DOOR ── */
    const doorGeo = new THREE.BoxGeometry(3, 4, 0.3);
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x1abc9c });
    this.door     = new THREE.Mesh(doorGeo, doorMat);
    this.door.position.set(0, 2, -14.8);
    this.door.castShadow = true;
    this.scene.add(this.door);

    // Door collision
    this.meshes.push({
      mesh: this.door,
      isPushable: false,
      aabb: {
        minX: -1.5, maxX: 1.5,
        minY: 0,    maxY: 4,
        minZ: -15,  maxZ: -14.5,
      },
    });

    /* ── DECORATIVE PILLARS ── */
    [[-10,0,-5],[-10,0,-10],[10,0,-5],[10,0,-10]].forEach(([x,y,z]) => {
      this._makePlatform(1, 4, 1, x, y, z, 0x85929e);
    });

    /* ── AMBIENT LIGHTS ── */
    const ambient = new THREE.AmbientLight(0x404060, 0.6);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff4e0, 1.2);
    sun.position.set(10, 20, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 0.1;
    sun.shadow.camera.far  = 80;
    sun.shadow.camera.left = sun.shadow.camera.bottom = -25;
    sun.shadow.camera.right = sun.shadow.camera.top  =  25;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x8080ff, 0.3);
    fill.position.set(-10, 5, -10);
    this.scene.add(fill);

    // Rebuild physics statics
    this.physics.rebuildStatics(this.meshes);
  }

  /** Call from main loop to sync box mesh with physics body */
  update(dt) {
    // Sync box mesh
    if (this.box && this.boxBody) {
      this.box.position.copy(this.boxBody.position);
      this.box.position.y += 0.75; // half height
    }

    // Animate door open
    if (this.doorOpen && this.door.position.y < 8) {
      this.door.position.y = Math.min(8, this.door.position.y + 3 * dt);
    }

    // Switch glow animation
    if (this.switch) {
      const t = Date.now() / 500;
      this.switch.material.emissive = new THREE.Color(
        this.doorOpen ? 0x00ff88 : 0x443300
      );
      this.switch.material.emissiveIntensity = 0.5 + 0.3 * Math.sin(t);
    }
  }

  /** Called when cat activates the switch */
  activateSwitch() {
    if (this.doorOpen) return false;
    this.doorOpen = true;
    // Remove door from collision
    this.meshes = this.meshes.filter(m => m.mesh !== this.door);
    this.physics.rebuildStatics(this.meshes);
    return true;
  }

  /** Check if a position is near the switch */
  nearSwitch(pos) {
    if (!this.switch) return false;
    return this.switch.position.distanceTo(pos) < 1.5;
  }

  /** Push box in direction */
  pushBox(dir) {
    const force = 8;
    this.boxBody.velocity.x += dir.x * force;
    this.boxBody.velocity.z += dir.z * force;
    // Friction
    this.boxBody.velocity.x *= 0.7;
    this.boxBody.velocity.z *= 0.7;
  }

  getCollidableMeshes() {
    return this.meshes.map(m => m.mesh);
  }
}

// ═══════════════════════════════════════════════════════════
// 6. PLAYER CONTROLLER
// ═══════════════════════════════════════════════════════════
/**
 * PlayerController
 * ─────────────────
 * Handles local player input & physics.
 *
 * Movement is ALWAYS relative to the camera's facing direction:
 *   forward = camera.getForwardVector()
 *   right   = camera.getRightVector()
 *
 * This gives the classic RPG feel where pressing W always
 * moves you toward the screen center, not a world direction.
 */
class PlayerController {
  constructor(role, physics, camera3P) {
    this.role    = role;   // 'cat' | 'dog'
    this.isCat   = role === 'cat';
    this.physics = physics;
    this.cam3P   = camera3P;

    // Input state
    this.keys    = {};
    this.mesh    = null;

    // Physics body
    this.body    = new PhysicsBody(0.7, 1.6, 0.5);
    this.body.position.set(this.isCat ? -2 : 2, 0, 5);
    physics.addBody(this.body);

    // Abilities
    this.jumpForce = CONFIG.JUMP_FORCE * (this.isCat ? CONFIG.CAT_JUMP_MULT : 1);
    this.speed     = CONFIG.MOVE_SPEED  * (this.isCat ? 1 : CONFIG.DOG_SPEED_MULT);

    // Interaction cooldown
    this._interactCooldown = 0;

    this._setupInput();
  }

  _setupInput() {
    document.addEventListener('keydown', e => { this.keys[e.code] = true;  });
    document.addEventListener('keyup',   e => { this.keys[e.code] = false; });
  }

  setMesh(mesh) { this.mesh = mesh; }

  /**
   * Main update — called every frame.
   * Returns { interacted, pushed } flags for game logic.
   */
  update(dt, world) {
    const body = this.body;
    const fwd  = this.cam3P.getForwardVector();
    const rgt  = this.cam3P.getRightVector();

    // ── Movement ──
    const moveDir = new THREE.Vector3();
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    moveDir.add(fwd);
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  moveDir.sub(fwd);
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  moveDir.sub(rgt);
    if (this.keys['KeyD'] || this.keys['ArrowRight']) moveDir.add(rgt);

    if (moveDir.length() > 0) moveDir.normalize();

    body.velocity.x = moveDir.x * this.speed;
    body.velocity.z = moveDir.z * this.speed;

    // ── Jump ──
    if ((this.keys['Space']) && body.onGround) {
      body.velocity.y = this.jumpForce;
      body.onGround   = false;
    }

    // ── Rotate mesh toward movement direction ──
    if (moveDir.length() > 0.01 && this.mesh) {
      const targetAngle = Math.atan2(moveDir.x, moveDir.z);
      const current     = this.mesh.rotation.y;
      const diff        = ((targetAngle - current + Math.PI) % (Math.PI * 2)) - Math.PI;
      this.mesh.rotation.y += diff * 0.2;
    }

    // ── Update mesh position from physics body ──
    if (this.mesh) {
      this.mesh.position.copy(body.position);
    }

    // ── Interaction cooldown ──
    this._interactCooldown = Math.max(0, this._interactCooldown - dt);

    // ── Abilities ──
    let interacted = false;
    let pushed     = false;

    if (this.keys['KeyE'] && this._interactCooldown === 0) {
      this._interactCooldown = 0.5;

      if (this.isCat && world.nearSwitch(body.position)) {
        interacted = world.activateSwitch();
      }

      if (!this.isCat) {
        // Dog pushes box if nearby
        const boxPos  = world.boxBody.position;
        const dist    = body.position.distanceTo(boxPos);
        if (dist < 2.5) {
          const pushDir = boxPos.clone().sub(body.position).normalize();
          pushDir.y = 0;
          world.pushBox(pushDir);
          pushed = true;
        }
      }
    }

    return { interacted, pushed };
  }

  getState() {
    return {
      x:  this.body.position.x,
      y:  this.body.position.y,
      z:  this.body.position.z,
      ry: this.mesh ? this.mesh.rotation.y : 0,
      vx: this.body.velocity.x,
      vy: this.body.velocity.y,
      vz: this.body.velocity.z,
    };
  }
}

// ═══════════════════════════════════════════════════════════
// 7. REMOTE PLAYER (interpolated)
// ═══════════════════════════════════════════════════════════
/**
 * RemotePlayer
 * ─────────────
 * Receives network state snapshots and smoothly interpolates
 * between them to hide latency and jitter.
 *
 * Uses a state buffer + delay approach:
 *   - Buffer incoming states with timestamps
 *   - Render at (now - INTERP_DELAY)
 *   - Lerp between the two bracketing states
 */
class RemotePlayer {
  constructor(role, scene) {
    this.role   = role;
    this.mesh   = buildCharacterMesh(role === 'cat');
    this.buffer = []; // { time, x, y, z, ry }
    scene.add(this.mesh);
    this.mesh.position.set(role === 'cat' ? -2 : 2, 0, 5);
  }

  /** Called when a network packet arrives */
  receiveState(state) {
    this.buffer.push({ time: Date.now(), ...state });
    // Keep buffer trimmed to last 1 second
    const cutoff = Date.now() - 1000;
    this.buffer = this.buffer.filter(s => s.time > cutoff);
  }

  /** Interpolate to render position */
  update() {
    const renderTime = Date.now() - CONFIG.INTERP_DELAY;
    const buf = this.buffer;

    if (buf.length < 2) {
      // Not enough data; snap to last known
      if (buf.length === 1) {
        this.mesh.position.set(buf[0].x, buf[0].y, buf[0].z);
        this.mesh.rotation.y = buf[0].ry;
      }
      return;
    }

    // Find two states bracketing renderTime
    let before = null, after = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].time <= renderTime) { before = buf[i]; break; }
    }
    for (let i = 0; i < buf.length; i++) {
      if (buf[i].time >= renderTime) { after = buf[i]; break; }
    }

    if (!before && after) {
      this.mesh.position.set(after.x, after.y, after.z);
      this.mesh.rotation.y = after.ry;
      return;
    }
    if (before && !after) {
      // Extrapolate slightly from last known velocity
      this.mesh.position.set(before.x, before.y, before.z);
      this.mesh.rotation.y = before.ry;
      return;
    }
    if (!before || !after) return;

    // Interpolate
    const span = after.time - before.time;
    const t    = span > 0 ? (renderTime - before.time) / span : 0;
    const tc   = clamp(t, 0, 1);

    this.mesh.position.x  = lerp(before.x,  after.x,  tc);
    this.mesh.position.y  = lerp(before.y,  after.y,  tc);
    this.mesh.position.z  = lerp(before.z,  after.z,  tc);

    // Shortest-path rotation lerp
    const rDiff = ((after.ry - before.ry + Math.PI) % (Math.PI * 2)) - Math.PI;
    this.mesh.rotation.y = before.ry + rDiff * tc;
  }
}

// ═══════════════════════════════════════════════════════════
// 8. NETWORK MANAGER
// ═══════════════════════════════════════════════════════════
class NetworkManager {
  constructor(wsUrl) {
    this.wsUrl    = wsUrl;
    this.ws       = null;
    this.roomId   = null;
    this.role     = null;   // 'cat' | 'dog'
    this.playerId = null;
    this.onMessage  = null; // callback(type, data)
    this.onOpen     = null;
    this.onClose    = null;
    this._sendInterval = null;
  }

  connect(roomId) {
    this.roomId = roomId;
    const url   = `${this.wsUrl}/room/${encodeURIComponent(roomId)}`;
    console.log('[Net] Connecting to', url);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[Net] Connected');
      if (this.onOpen) this.onOpen();
    };

    this.ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (this.onMessage) this.onMessage(msg.type, msg);
      } catch (err) {
        console.warn('[Net] Bad message', e.data);
      }
    };

    this.ws.onclose = () => {
      console.log('[Net] Disconnected');
      if (this.onClose) this.onClose();
    };

    this.ws.onerror = err => {
      console.error('[Net] Error', err);
    };
  }

  send(type, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  /** Start sending player state at ~20 FPS */
  startSending(getStateFn) {
    if (this._sendInterval) clearInterval(this._sendInterval);
    this._sendInterval = setInterval(() => {
      const state = getStateFn();
      this.send('playerMove', state);
    }, CONFIG.TICK_RATE);
  }

  stop() {
    if (this._sendInterval) clearInterval(this._sendInterval);
    if (this.ws) this.ws.close();
  }
}

// ═══════════════════════════════════════════════════════════
// 9. GAME ORCHESTRATOR
// ═══════════════════════════════════════════════════════════
class Game {
  constructor() {
    // DOM
    this.canvas       = document.getElementById('gameCanvas');
    this.lobby        = document.getElementById('lobby');
    this.hud          = document.getElementById('hud');
    this.hudRole      = document.getElementById('hudRole');
    this.hudRoom      = document.getElementById('hudRoom');
    this.hudStatus    = document.getElementById('hudStatus');
    this.puzzleHint   = document.getElementById('puzzleHint');
    this.clickOverlay = document.getElementById('clickOverlay');
    this.joinBtn      = document.getElementById('joinBtn');
    this.roomInput    = document.getElementById('roomInput');
    this.lobbyStatus  = document.getElementById('lobbyStatus');

    // Three.js core
    this.renderer = null;
    this.scene    = null;
    this.camera   = null;

    // Game systems
    this.world      = null;
    this.physics    = null;
    this.cam3P      = null;
    this.player     = null;
    this.remote     = null;
    this.net        = null;

    // State
    this.running    = false;
    this.role       = null;
    this.roomId     = null;
    this.peerOnline = false;

    // Timing
    this._lastTime  = 0;

    // Mouse lock
    this._mouseLocked = false;

    this._setupLobby();
  }

  _setupLobby() {
    this.joinBtn.addEventListener('click', () => this._join());
    this.roomInput.addEventListener('keydown', e => {
      if (e.code === 'Enter') this._join();
    });
  }

  _join() {
    const roomId = this.roomInput.value.trim();
    if (!roomId) {
      this._lobbyMsg('Enter a room ID!', true);
      return;
    }
    this.roomId = roomId;
    this._lobbyMsg('Connecting…');
    this.joinBtn.disabled = true;

    this.net = new NetworkManager(WS_URL);
    this.net.onMessage = (type, data) => this._onNetMessage(type, data);
    this.net.onClose   = () => this._onDisconnect();
    this.net.connect(roomId);

    // Wait for role assignment from server
    // Timeout if server unreachable
    this._joinTimeout = setTimeout(() => {
      // If no role yet, run in offline / solo mode
      if (!this.role) {
        this._lobbyMsg('⚠️ No server — running solo as Cat', false);
        this._startGame('cat');
      }
    }, 3000);
  }

  _onNetMessage(type, data) {
    switch (type) {
      case 'welcome':
        // Server assigns role
        clearTimeout(this._joinTimeout);
        this.net.role     = data.role;
        this.net.playerId = data.playerId;
        this.role         = data.role;
        this._lobbyMsg(`Joined as ${data.role === 'cat' ? '🐱 Cat' : '🐶 Dog'}! Waiting for partner…`);
        break;

      case 'peerJoined':
        this.peerOnline = true;
        this._startGame(this.role);
        break;

      case 'peerLeft':
        this.peerOnline = false;
        if (this.hudStatus) this.hudStatus.textContent = '⚠️ Partner disconnected';
        break;

      case 'playerMove':
        if (this.remote) {
          this.remote.receiveState(data);
        }
        break;

      case 'worldEvent':
        if (this.world && data.event === 'switchActivated') {
          this.world.activateSwitch();
        }
        break;

      case 'startGame':
        // Server says both players ready
        if (!this.running) this._startGame(this.role);
        break;
    }
  }

  _onDisconnect() {
    if (this.hudStatus) this.hudStatus.textContent = '🔌 Disconnected';
  }

  _lobbyMsg(msg, isError = false) {
    this.lobbyStatus.textContent = msg;
    this.lobbyStatus.className   = 'lobby-status' + (isError ? ' error' : '');
  }

  // ── INIT THREE.JS ──────────────────────────────────────
  _initThree() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas:    this.canvas,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x87ceeb, 1); // sky blue

    // Scene
    this.scene  = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x87ceeb, 20, 60);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ── START GAME ─────────────────────────────────────────
  _startGame(role) {
    if (this.running) return;
    this.role    = role;
    this.running = true;

    // Hide lobby, show game
    this.lobby.classList.add('hidden');
    this.canvas.classList.remove('hidden');
    this.hud.classList.remove('hidden');
    this.clickOverlay.classList.remove('hidden');

    // HUD
    const isCat = role === 'cat';
    this.hudRole.textContent  = isCat ? '🐱 CAT' : '🐶 DOG';
    this.hudRole.className    = isCat ? '' : 'dog-role';
    this.hudRoom.textContent  = `Room: ${this.roomId || 'Solo'}`;
    this.hudStatus.textContent = this.peerOnline ? '✅ Partner online' : '⏳ Waiting for partner…';

    // Hint
    this.puzzleHint.textContent = isCat
      ? '🐱 Climb platforms → reach the yellow switch → press E!'
      : '🐶 Push the orange box near the platforms → help cat climb!';

    // Init Three.js
    this._initThree();

    // Physics
    this.physics = new PhysicsWorld();

    // World
    this.world  = new GameWorld(this.scene, this.physics);

    // Third-person camera
    this.cam3P  = new ThirdPersonCamera(this.camera);

    // Local player
    this.player = new PlayerController(role, this.physics, this.cam3P);
    const localMesh = buildCharacterMesh(isCat);
    this.scene.add(localMesh);
    this.player.setMesh(localMesh);

    // Remote player
    const remoteRole = isCat ? 'dog' : 'cat';
    this.remote = new RemotePlayer(remoteRole, this.scene);

    // Network sending
    if (this.net && this.net.ws) {
      this.net.startSending(() => this.player.getState());
    }

    // Mouse lock
    this._setupPointerLock();

    // Start loop
    this._lastTime = performance.now();
    this._loop();
  }

  // ── POINTER LOCK ───────────────────────────────────────
  _setupPointerLock() {
    this.clickOverlay.addEventListener('click', () => {
      this.canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this._mouseLocked = document.pointerLockElement === this.canvas;
      this.clickOverlay.classList.toggle('hidden', this._mouseLocked);
    });

    document.addEventListener('mousemove', e => {
      if (!this._mouseLocked) return;
      this.cam3P.onMouseMove(e.movementX, e.movementY);
    });

    // Also handle touch for mobile (simple swipe)
    let _lastTouch = null;
    this.canvas.addEventListener('touchstart', e => {
      _lastTouch = e.touches[0];
    }, { passive: true });
    this.canvas.addEventListener('touchmove', e => {
      if (!_lastTouch) return;
      const t  = e.touches[0];
      const dx = t.clientX - _lastTouch.clientX;
      const dy = t.clientY - _lastTouch.clientY;
      this.cam3P.onMouseMove(dx * 2, dy * 2);
      _lastTouch = t;
    }, { passive: true });
  }

  // ── MAIN LOOP ──────────────────────────────────────────
  _loop() {
    if (!this.running) return;
    requestAnimationFrame(() => this._loop());

    const now = performance.now();
    const dt  = Math.min((now - this._lastTime) / 1000, 0.05); // cap at 50ms
    this._lastTime = now;

    // Physics step
    this.physics.step(dt);

    // Player update
    const events = this.player.update(dt, this.world);

    // Notify network of world events
    if (events.interacted && this.net) {
      this.net.send('worldEvent', { event: 'switchActivated' });
    }

    // World update (door animation, box sync)
    this.world.update(dt);

    // Sync box body back to physics statics if it moved
    // (simple: just update box AABB in statics list)
    this._updateBoxCollision();

    // Remote player interpolation
    this.remote.update();

    // Camera update
    this.cam3P.update(
      this.player.body.position,
      dt,
      this.scene,
      this.world.getCollidableMeshes()
    );

    // Update puzzle hint
    this._updateHint();

    // Render
    this.renderer.render(this.scene, this.camera);
  }

  _updateBoxCollision() {
    // Keep box physics in sync with the static collision list
    if (!this.world.box || !this.world.boxBody) return;
    const bp = this.world.boxBody.position;
    const hs = 0.75;
    // Find box entry in physics statics and update it
    // (quick approach: just re-add it each tick at current pos)
    const collidables = this.world.meshes;
    const boxEntry = collidables.find(m => m.mesh === this.world.box);
    if (boxEntry) {
      boxEntry.aabb = {
        minX: bp.x - hs, maxX: bp.x + hs,
        minY: bp.y,       maxY: bp.y + 1.5,
        minZ: bp.z - hs,  maxZ: bp.z + hs,
      };
    }
  }

  _updateHint() {
    if (!this.world.doorOpen) {
      if (this.role === 'cat') {
        const near = this.world.nearSwitch(this.player.body.position);
        if (near) {
          this.puzzleHint.textContent = '🔘 Press E to activate the switch!';
        }
      }
    } else {
      this.puzzleHint.textContent = '🚪 Door is open! Escape through the back wall!';
    }

    this.hudStatus.textContent = this.peerOnline
      ? (this.world.doorOpen ? '🎉 Door open! Escape!' : '✅ Partner online')
      : '⏳ Waiting for partner…';
  }
}

// ═══════════════════════════════════════════════════════════
// 10. BOOTSTRAP
// ═══════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  window._game = new Game();
});
