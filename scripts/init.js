/**
 * What this does:
 * - Loads scan-tree.ply and shows it as Points with height coloring
 * - Lets you click on the scan to add a "pin" (small sphere) with a text note
 * - Pins are persisted to a CouchDB backend API (localhost:3001)
 * - localStorage is used as a fast cache for instant loading
 * - Sync button triggers CouchDB bidirectional replication to cloud
 * - Live polling (every 5s) picks up changes from other users
 *
 * Backend API (Express + CouchDB on port 3001):
 *   GET    /api/documents      -> list all documents
 *   POST   /api/documents      -> create a new document
 *   PUT    /api/documents/:id  -> update a document
 *   DELETE /api/documents/:id  -> delete a document
 *   POST   /api/sync           -> trigger cloud sync
 *   GET    /api/sync/status    -> get sync status
 */

//////////////////////
// Basic identifiers //
//////////////////////
//

const DEVICE_ID_KEY = "pins.deviceId";
function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      "pi-" +
      Math.random().toString(16).slice(2) +
      "-" +
      Date.now().toString(16);
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
const DEVICE_ID = getOrCreateDeviceId();

const PINS_KEY = "pins.list.v1";
function loadLocalPins() {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveLocalPins(pins) {
  localStorage.setItem(PINS_KEY, JSON.stringify(pins));
}

//////////////////////
// Backend API       //
//////////////////////

const API_BASE = "http://localhost:3001";
const POLL_INTERVAL = 5000;
const pinRevisions = new Map(); // Track CouchDB _rev for updates/deletes

async function fetchPinsFromAPI() {
  const res = await fetch(`${API_BASE}/api/documents`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();

  // Handle both array and CouchDB-style response
  const docs = Array.isArray(data)
    ? data
    : (data.rows || []).map((r) => r.doc || r);

  return docs
    .filter((doc) => doc && doc.pos) // Must have position data to be a pin
    .map((doc) => {
      if (doc._rev) pinRevisions.set(doc._id || doc.id, doc._rev);
      return {
        id: doc._id || doc.id,
        author: doc.author,
        time: doc.time,
        pos: doc.pos,
        text: doc.text,
      };
    });
}

async function savePinToAPI(pin) {
  const doc = {
    _id: pin.id,
    type: "pin",
    id: pin.id,
    author: pin.author,
    time: pin.time,
    pos: pin.pos,
    text: pin.text,
  };

  const res = await fetch(`${API_BASE}/api/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });

  if (!res.ok) throw new Error(`Failed to save pin: ${res.status}`);
  const result = await res.json();
  if (result.rev || result._rev)
    pinRevisions.set(pin.id, result.rev || result._rev);
  return result;
}

async function deletePinFromAPI(pinId) {
  const res = await fetch(
    `${API_BASE}/api/documents/${encodeURIComponent(pinId)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404)
    throw new Error(`Failed to delete: ${res.status}`);
  pinRevisions.delete(pinId);
}

async function triggerAPISync() {
  const res = await fetch(`${API_BASE}/api/sync`, { method: "POST" });
  if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
  return await res.json();
}

async function getAPISyncStatus() {
  const res = await fetch(`${API_BASE}/api/sync/status`);
  if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
  return await res.json();
}

function setStatus(msg) {
  document.getElementById("status-message").textContent = msg;
}

//////////////////////
// Three.js setup    //
//////////////////////

const scene = new THREE.Scene();
// Deep cyberpunk void with subtle neon gradient
scene.background = new THREE.Color(0x020208);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  2000,
);
camera.position.set(0, 0, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Cyberpunk lighting setup
scene.add(new THREE.HemisphereLight(0x00ffff, 0x440088, 0.3));
// Add ambient cyan glow
const ambientLight = new THREE.AmbientLight(0x004466, 0.2);
scene.add(ambientLight);
// Add directional neon light
const neonLight = new THREE.DirectionalLight(0x00ffff, 0.4);
neonLight.position.set(1, 1, 1);
scene.add(neonLight);

let pointsObj = null; // THREE.Points
let geometryRef = null; // BufferGeometry for points
let pinGroup = new THREE.Group();
scene.add(pinGroup);

// Raycasting for picking
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.3; // picking tolerance in world units (tune)
const mouse = new THREE.Vector2();

//////////////////////
// Pins rendering    //
//////////////////////

// id -> Mesh so we don't duplicate
const pinMeshesById = new Map();

function updatePinLabels() {
  for (const obj of pinMeshesById.values()) {
    const { sprite, label, pin } = obj;

    const v = new THREE.Vector3(pin.pos.x, pin.pos.y, pin.pos.z);
    v.project(camera);

    // behind camera? hide
    if (v.z < -1 || v.z > 1) {
      label.style.display = "none";
      continue;
    }

    const x = (v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-v.y * 0.5 + 0.5) * window.innerHeight;

    label.style.display = "block";
    label.style.left = x + "px";
    label.style.top = y + "px";
  }
}

const labelsEl = document.getElementById("labels");

function addPinMesh(pin) {
  if (pinMeshesById.has(pin.id)) {
    // Update label text if pin data changed
    const existing = pinMeshesById.get(pin.id);
    existing.label.textContent = pin.text || "(no text)";
    existing.pin = pin;
    return;
  }

  const geometry = new THREE.SphereGeometry(0.02, 8, 6);
  const material = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.8,
  });
  const sphere = new THREE.Mesh(geometry, material);
  sphere.position.set(pin.pos.x, pin.pos.y, pin.pos.z);

  // Add glowing wireframe
  const wireframeGeometry = new THREE.SphereGeometry(0.03, 8, 6);
  const wireframeMaterial = new THREE.MeshBasicMaterial({
    color: 0xff00ff,
    wireframe: true,
    transparent: true,
    opacity: 0.6,
  });
  const wireframe = new THREE.Mesh(wireframeGeometry, wireframeMaterial);
  wireframe.position.set(pin.pos.x, pin.pos.y, pin.pos.z);

  // Create pin group with both meshes
  const pinMesh = new THREE.Group();
  pinMesh.add(sphere);
  pinMesh.add(wireframe);

  pinGroup.add(pinMesh);

  const label = document.createElement("div");
  label.className = "pin-label";
  label.textContent = pin.text || "(no text)";
  labelsEl.appendChild(label);

  pinMeshesById.set(pin.id, { sprite: pinMesh, label, pin });
}

const renderPinsList = (pins) => {
  const el = document.getElementById("pins-list-items");
  el.innerHTML = "";
  pins
    .slice()
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .forEach((p) => {
      const row = document.createElement("div");
      row.className = "pin-row";
      const t = new Date(p.time).toLocaleString();
      row.innerHTML = `<div><strong>${escapeHtml(p.text || "(no text)")}</strong></div><br /><code>${t}<br />${p.author}</code>`;
      el.appendChild(row);
    });
};

const escapeHtml = (s) => {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[c],
  );
};

//////////////////////
// Local-first model //
//////////////////////

let pins = loadLocalPins(); // Start with cached pins for instant load
pins.forEach(addPinMesh);
renderPinsList(pins);

// Then fetch latest from backend API
(async () => {
  try {
    setStatus("Connecting to backend...");
    const apiPins = await fetchPinsFromAPI();
    syncPinsFromDB(apiPins);
    setStatus(`Loaded ${pins.length} pins from database`);
  } catch (e) {
    console.warn("Backend unavailable, using cached pins:", e);
    setStatus(`Using ${pins.length} cached pins (backend offline)`);
  }
})();

async function upsertPin(pin) {
  // Optimistically add pin locally for instant feedback
  const idx = pins.findIndex((p) => p.id === pin.id);
  if (idx === -1) pins.push(pin);
  else pins[idx] = pin;
  saveLocalPins(pins);
  addPinMesh(pin);
  renderPinsList(pins);

  // Persist to backend API, then re-fetch DB state to confirm
  try {
    await savePinToAPI(pin);
    const apiPins = await fetchPinsFromAPI();
    syncPinsFromDB(apiPins);
  } catch (e) {
    console.error("Failed to save pin to backend:", e);
    setStatus("Pin saved locally (backend offline)");
  }
}

function syncPinsFromDB(dbPins) {
  const dbPinIds = new Set(dbPins.map((p) => p.id));

  // Remove meshes/labels for pins no longer in the DB
  for (const [id, obj] of pinMeshesById.entries()) {
    if (!dbPinIds.has(id)) {
      pinGroup.remove(obj.sprite);
      obj.label.remove();
      pinMeshesById.delete(id);
    }
  }

  // DB is the source of truth — replace local state entirely
  pins = dbPins;
  saveLocalPins(pins);

  // Ensure meshes exist for all current pins
  pins.forEach(addPinMesh);
  renderPinsList(pins);
}

//////////////////////
// Load PLY (yours)  //
//////////////////////

const loader = new THREE.PLYLoader();
loader.load("scans/scan-tree.ply", (geometry) => {
  geometry.computeVertexNormals();
  geometryRef = geometry;

  // Better height gradient: normalize z via bounding box
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const zMin = bb.min.z,
    zMax = bb.max.z;
  const range = zMax - zMin || 1;

  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const z = geometry.attributes.position.getZ(i);
    const t = (z - zMin) / range; // 0..1
    let r, g, b;
    if (t < 0.33) {
      // Deep blue to cyan
      const localT = t * 3;
      r = 0;
      g = localT * 0.7;
      b = 0.2 + localT * 0.8;
    } else if (t < 0.66) {
      // Cyan to magenta
      const localT = (t - 0.33) * 3;
      r = localT * 1.0;
      g = 0.7 * (1 - localT * 0.5);
      b = 1.0;
    } else {
      // Magenta to bright cyan
      const localT = (t - 0.66) * 3;
      r = 1.0 * (1 - localT);
      g = 0.35 + localT * 0.65;
      b = 1.0;
    }
    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.015,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
  });

  pointsObj = new THREE.Points(geometry, material);
  scene.add(pointsObj);

  // Optional: center camera/controls on the geometry
  const center = new THREE.Vector3();
  bb.getCenter(center);
  controls.target.copy(center);
  camera.position.copy(center.clone().add(new THREE.Vector3(0, 0, 2)));

  setStatus("Loaded " + count + " points. Device: " + DEVICE_ID);
});

//////////////////////
// Click to add pin  //
//////////////////////

let down = null;

renderer.domElement.addEventListener("pointerdown", (ev) => {
  down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
});

renderer.domElement.addEventListener("pointerup", async (ev) => {
  if (!down) return;

  const dx = ev.clientX - down.x;
  const dy = ev.clientY - down.y;
  const dist = Math.hypot(dx, dy);
  down = null;

  // If user dragged, don't place a pin
  if (dist > 4) return;

  // Place pin on click
  await tryAddPinAtEvent(ev);
});

async function tryAddPinAtEvent(ev) {
  // ignore clicks on HUD
  const hud = document.getElementById("hud");
  if (hud.contains(ev.target)) return;

  if (!pointsObj || !geometryRef) return;

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(pointsObj, false);
  if (!hits.length) {
    setStatus("no hit - click closer to the scan");
    return;
  }

  const idx = hits[0].index;
  const pos = new THREE.Vector3(
    geometryRef.attributes.position.getX(idx),
    geometryRef.attributes.position.getY(idx),
    geometryRef.attributes.position.getZ(idx),
  );

  // Disable controls while prompting (prevents “stuck dragging”)
  const prevEnabled = controls.enabled;
  controls.enabled = false;

  const text = prompt("Pin text:", "Example annotation");

  controls.enabled = prevEnabled;

  // Also forcibly stop any in-progress control interaction
  controls.update();

  if (text === null) return;

  const pin = {
    id:
      DEVICE_ID +
      "-" +
      Date.now().toString(16) +
      "-" +
      Math.random().toString(16).slice(2),
    author: DEVICE_ID,
    time: Date.now(),
    pos: { x: pos.x, y: pos.y, z: pos.z },
    text: text.trim(),
  };

  upsertPin(pin);

  // Fly-to (your code)
  controls.target.set(pin.pos.x, pin.pos.y, pin.pos.z);
  camera.position.set(
    pin.pos.x,
    pin.pos.y,
    pin.pos.z + (window.PIN_SCALE || 0.2) * 20,
  );
  controls.update();

  setStatus("Ready for sync");
}

//////////////////////
// Sync UI           //
//////////////////////

document.getElementById("sync-btn").addEventListener("click", async () => {
  try {
    setStatus("Triggering cloud sync...");

    // Trigger CouchDB bidirectional replication
    await triggerAPISync();

    // Brief wait for replication to propagate
    await new Promise((r) => setTimeout(r, 1000));

    // Refresh pins from backend
    const apiPins = await fetchPinsFromAPI();
    syncPinsFromDB(apiPins);

    // Show sync status
    try {
      const status = await getAPISyncStatus();
      const cloudCount = status.cloudDocCount ?? "?";
      setStatus(
        `Synced. Local: ${pins.length} pins | Cloud: ${cloudCount} docs`,
      );
    } catch {
      setStatus(`Synced. ${pins.length} pins loaded`);
    }
  } catch (e) {
    console.error(e);
    setStatus("Sync failed: " + e.message);
  }
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  if (!confirm("Delete ALL pins from the database?")) return;

  setStatus("Deleting all pins...");

  // Delete from backend API
  const deletePromises = pins.map((pin) =>
    deletePinFromAPI(pin.id).catch((e) =>
      console.warn(`Failed to delete ${pin.id}:`, e),
    ),
  );
  await Promise.all(deletePromises);

  pins = [];
  saveLocalPins(pins);

  // Remove meshes
  for (const obj of pinMeshesById.values()) {
    pinGroup.remove(obj.sprite);
    obj.label.remove();
  }
  pinMeshesById.clear();
  renderPinsList(pins);
  setStatus("All pins deleted");
});

//////////////////////
// Live polling      //
//////////////////////

setInterval(async () => {
  try {
    const apiPins = await fetchPinsFromAPI();
    syncPinsFromDB(apiPins);
  } catch {
    // Silently ignore polling errors
  }
}, POLL_INTERVAL);

//////////////////////
// Render loop       //
//////////////////////

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updatePinLabels();

  // Cyberpunk pin pulsing animation
  const time = Date.now() * 0.002;
  for (const obj of pinMeshesById.values()) {
    const { sprite } = obj;
    if (sprite && sprite.children) {
      // Pulse the inner sphere
      const innerSphere = sprite.children[0];
      if (innerSphere) {
        innerSphere.material.opacity = 0.6 + 0.4 * Math.sin(time * 2);
      }
      // Rotate the wireframe
      const wireframe = sprite.children[1];
      if (wireframe) {
        wireframe.rotation.x = time * 0.5;
        wireframe.rotation.y = time * 0.7;
        wireframe.material.opacity = 0.4 + 0.3 * Math.sin(time * 3);
      }
    }
  }

  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
