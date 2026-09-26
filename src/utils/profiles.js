// src/utils/profiles.js
// Fixed-address profiles: gives each setup a permanent ID (u-xxxx) whose
// latest config hash is stored server-side, so the Stremio install URL never
// has to change when settings change.
//
// Storage: Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// are set (use this on Hugging Face / any host with a temporary disk),
// otherwise a local JSON file at data/profiles.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Redis } = require('@upstash/redis');

const PROFILE_PREFIX = 'u-';
const PROFILE_ID_RE = /^u-[A-Za-z0-9]{20,40}$/;
const PROFILE_PATH_RE = /^\/(u-[A-Za-z0-9]{20,40})(\/[^?]*)?(\?.*)?$/;
const CONFIG_HASH_RE = /^[A-Za-z0-9_-]{8,200000}$/;
const REDIS_KEY_PREFIX = 'aiolists:profile:';
const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'profiles.json');

let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}
const storageType = redis ? 'upstash' : 'file';

// ---------- File storage ----------
let fileCache = null;
let writeChain = Promise.resolve();

function loadFile() {
  if (fileCache) return fileCache;
  try {
    fileCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    fileCache = {};
  }
  return fileCache;
}

function saveFile() {
  const snapshot = JSON.stringify(fileCache);
  writeChain = writeChain.then(async () => {
    await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch(err => console.error('[PROFILES] Failed to write profiles file:', err.message));
  return writeChain;
}

// ---------- Public store API ----------
async function getProfileHash(id) {
  if (!PROFILE_ID_RE.test(id)) return null;
  if (redis) {
    const value = await redis.get(REDIS_KEY_PREFIX + id);
    return typeof value === 'string' ? value : null;
  }
  return loadFile()[id] || null;
}

async function setProfileHash(id, configHash) {
  if (!PROFILE_ID_RE.test(id) || !CONFIG_HASH_RE.test(configHash)) {
    throw new Error('Invalid profile ID or config hash');
  }
  if (redis) {
    await redis.set(REDIS_KEY_PREFIX + id, configHash);
    return;
  }
  loadFile()[id] = configHash;
  await saveFile();
}

function newProfileId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(24);
  let id = PROFILE_PREFIX;
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

// ---------- Express wiring ----------

// Routes: POST /api/profile  { configHash } -> { success, profileId }
function createProfileRouter() {
  const router = express.Router();

  router.get('/profile/status', (req, res) => {
    res.json({ enabled: true, storage: storageType });
  });

  router.post('/profile', async (req, res) => {
    try {
      const { configHash } = req.body || {};
      if (!configHash || !CONFIG_HASH_RE.test(configHash) || configHash.startsWith(PROFILE_PREFIX)) {
        return res.status(400).json({ success: false, error: 'A valid configHash is required' });
      }
      const profileId = newProfileId();
      await setProfileHash(profileId, configHash);
      res.json({ success: true, profileId });
    } catch (error) {
      console.error('[PROFILES] Failed to create profile:', error.message);
      res.status(500).json({ success: false, error: 'Failed to create profile' });
    }
  });

  return router;
}

// Middleware: rewrites /u-xxx/... to /<stored config hash>/... so every existing
// route works unchanged, and saves any new configHash the route returns back
// into the profile (answering with the profile ID instead of the raw hash).
function profileMiddleware() {
  return async (req, res, next) => {
    const match = PROFILE_PATH_RE.exec(req.url);
    if (!match) return next();

    const profileId = match[1];
    const rest = match[2] || '';
    const query = match[3] || '';

    let storedHash;
    try {
      storedHash = await getProfileHash(profileId);
    } catch (error) {
      console.error('[PROFILES] Storage read failed:', error.message);
      return res.status(503).json({ error: 'Profile storage unavailable' });
    }

    if (!storedHash) {
      if (req.method === 'GET' && (rest === '/configure' || rest === '' || rest === '/')) {
        return res.redirect('/configure?missingProfile=1');
      }
      return res.status(404).json({ error: 'Profile not found' });
    }

    req.profileId = profileId;
    req.url = `/${storedHash}${rest}${query}`;

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const keys = ['configHash', 'newConfigHash'];
      const hasNewHash = body && typeof body === 'object' &&
        keys.some(k => typeof body[k] === 'string' && body[k] && !body[k].startsWith(PROFILE_PREFIX));
      if (!hasNewHash) return originalJson(body);

      const newHash = keys.map(k => body[k]).find(v => typeof v === 'string' && v && !v.startsWith(PROFILE_PREFIX));
      const updated = { ...body };
      keys.forEach(k => { if (typeof updated[k] === 'string' && updated[k]) updated[k] = profileId; });

      const save = newHash !== storedHash ? setProfileHash(profileId, newHash) : Promise.resolve();
      save
        .then(() => originalJson(updated))
        .catch(error => {
          console.error('[PROFILES] Failed to save profile:', error.message);
          res.status(500);
          originalJson({ success: false, error: 'Settings could not be saved to your profile' });
        });
      return res;
    };

    next();
  };
}

function logProfileStorage() {
  if (storageType === 'upstash') {
    console.log('[PROFILES] Fixed-address profiles stored in Upstash Redis.');
  } else {
    console.log(`[PROFILES] Fixed-address profiles stored in ${DATA_FILE}. ` +
      'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on hosts with temporary disks (e.g. Hugging Face).');
  }
}

module.exports = {
  PROFILE_PREFIX,
  getProfileHash,
  setProfileHash,
  createProfileRouter,
  profileMiddleware,
  logProfileStorage,
};
