const DB_NAME = 'liquid-glass-credentials-v1';
const DB_VERSION = 1;

function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('credentials')) db.createObjectStore('credentials');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open secure phone storage.'));
  });
}

async function getStoreValue(storeName, key) {
  const db = await openVault();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function putStoreValue(storeName, key, value) {
  const db = await openVault();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Secure phone storage was interrupted.'));
    });
  } finally { db.close(); }
}

async function removeStoreValue(storeName, key) {
  const db = await openVault();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function encryptionKey() {
  let key = await getStoreValue('keys', 'phone-key');
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await putStoreValue('keys', 'phone-key', key);
  }
  return key;
}

export async function saveCredential(deviceId, token) {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  await putStoreValue('credentials', deviceId, { iv, ciphertext });
}

export async function readCredential(deviceId) {
  const item = await getStoreValue('credentials', deviceId);
  if (!item) return null;
  const key = await encryptionKey();
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: item.iv }, key, item.ciphertext);
  return new TextDecoder().decode(plaintext);
}

export async function removeCredential(deviceId) {
  await removeStoreValue('credentials', deviceId);
}
