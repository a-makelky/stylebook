// The other-service secret is encrypted with a key held in a Worker secret.
// The ciphertext is what D1 stores. The secret is never written to a log.
// https://developers.cloudflare.com/workers/configuration/secrets/

const VERSION = "v1";

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function aesKey(secret: string): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt a secret. The result does not contain the secret. */
export async function sealSecret(key: string, plain: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(key), new TextEncoder().encode(plain)),
	);
	return `${VERSION}.${bytesToBase64(iv)}.${bytesToBase64(cipher)}`;
}

/** Decrypt a value from {@link sealSecret}. */
export async function openSecret(key: string, sealed: string): Promise<string> {
	const parts = sealed.split(".");
	if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
		throw new Error("The saved secret could not be read.");
	}
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64ToBytes(parts[1]) },
		await aesKey(key),
		base64ToBytes(parts[2]),
	);
	return new TextDecoder().decode(plain);
}
