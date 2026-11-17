/**
 * A lightweight, stable identity for a document's bytes, used to keep its
 * annotations: SHA-256 of the file (above 64 MB, of its first and last 32 MB
 * and its length, which still changes with any incremental save). Falls back
 * to FNV-1a where WebCrypto is unavailable (insecure origins).
 */
export async function fingerprint(bytes: ArrayBuffer): Promise<string> {
  const LIMIT = 64 * 1024 * 1024;
  const SPAN = 32 * 1024 * 1024;
  let data: Uint8Array<ArrayBuffer>;
  if (bytes.byteLength <= LIMIT) data = new Uint8Array(bytes);
  else {
    data = new Uint8Array(2 * SPAN + 8);
    data.set(new Uint8Array(bytes, 0, SPAN), 0);
    data.set(new Uint8Array(bytes, bytes.byteLength - SPAN, SPAN), SPAN);
    new DataView(data.buffer).setFloat64(2 * SPAN, bytes.byteLength);
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', data));
    return `sha256:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  let h = 0xcbf29ce484222325n;
  for (const b of data) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `fnv1a:${h.toString(16).padStart(16, '0')}:${bytes.byteLength}`;
}
