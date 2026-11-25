const encode = new TextEncoder();

function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

async function key() {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(process.env.LINE_SECRETS_KEY ?? ""), c => c.charCodeAt(0));
  } catch {
    throw new Error("LINE_SECRETS_KEY_INVALID");
  }
  if (bytes.length !== 32) throw new Error("LINE_SECRETS_KEY_INVALID");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealLineSecret(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), encode.encode(value));
  return base64(iv) + "." + base64(new Uint8Array(ciphertext));
}

export async function openLineSecret(value: string) {
  const [iv, ciphertext] = value.split(".");
  const decode = (part: string) => Uint8Array.from(atob(part), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decode(iv) }, await key(), decode(ciphertext),
  ));
}

export async function verifyLineSignature(body: ArrayBuffer, secret: string, signature: string | null) {
  if (!signature) return false;
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0)); }
  catch { return false; }
  const hmac = await crypto.subtle.importKey("raw", encode.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", hmac, bytes, body);
}
