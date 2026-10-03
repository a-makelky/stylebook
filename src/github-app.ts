// GitHub App authentication. Stylebook stores an installation id, not a personal
// token, and mints a short-lived installation token for each send.
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
// https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
// Contents: Read and write is the only repository permission the manifest asks
// for. That is what Git access needs. It does not include administration, so
// creating a repository is offered only when an installation actually has it.

import type { Env } from "./env";

export const GITHUB_NOT_READY = "GitHub backups are not set up on this server yet.";

const GITHUB_API = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";

export function githubReady(env: Env): boolean {
	return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_SLUG);
}

/** Creating a repository needs Administration: Read and write. Contents does not. */
export function canCreateRepository(permissions: { administration?: string } | null | undefined): boolean {
	return permissions?.administration === "write";
}

/** Always private. Stylebook never asks GitHub for a public repository. */
export function privateRepositoryBody(
	name: string,
): { name: string; private: true; auto_init: false } | null {
	const clean = name
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 100);
	if (!clean || !/^[A-Za-z0-9]/.test(clean)) return null;
	return { name: clean, private: true, auto_init: false };
}

export function githubAddress(fullName: string): string | null {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return null;
	return `https://github.com/${fullName}.git`;
}

export function githubFullName(address: string): string | null {
	try {
		const url = new URL(address);
		if (url.hostname !== "github.com") return null;
		const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
		return githubAddress(path) ? path : null;
	} catch {
		return null;
	}
}

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

function b64url(bytes: Uint8Array): string {
	return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concat(parts: Uint8Array[]): Uint8Array {
	const length = parts.reduce((total, part) => total + part.byteLength, 0);
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function der(tag: number, content: Uint8Array): Uint8Array {
	let length: Uint8Array;
	if (content.byteLength < 128) length = new Uint8Array([content.byteLength]);
	else if (content.byteLength < 256) length = new Uint8Array([0x81, content.byteLength]);
	else length = new Uint8Array([0x82, (content.byteLength >> 8) & 0xff, content.byteLength & 0xff]);
	const out = new Uint8Array(1 + length.byteLength + content.byteLength);
	out[0] = tag;
	out.set(length, 1);
	out.set(content, 1 + length.byteLength);
	return out;
}

/** GitHub gives a PKCS#1 key. WebCrypto imports PKCS#8. */
function wrapPkcs1(pkcs1: Uint8Array): Uint8Array {
	const version = der(0x02, new Uint8Array([0x00]));
	const algorithm = new Uint8Array([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
	]);
	return der(0x30, concat([version, algorithm, der(0x04, pkcs1)]));
}

export function pemToPkcs8(pem: string): ArrayBuffer {
	const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
	const body = normalized
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	const derBytes = base64ToBytes(body);
	const pkcs8 = normalized.includes("BEGIN RSA PRIVATE KEY") ? wrapPkcs1(derBytes) : derBytes;
	return pkcs8.buffer.slice(pkcs8.byteOffset, pkcs8.byteOffset + pkcs8.byteLength) as ArrayBuffer;
}

/** A JSON Web Token that authenticates as the GitHub App. It expires within 10 minutes. */
export async function githubAppJwt(appId: string, pem: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(pem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const encoder = new TextEncoder();
	const header = b64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const payload = b64url(
		encoder.encode(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId })),
	);
	const signing = encoder.encode(`${header}.${payload}`);
	const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signing));
	return `${header}.${payload}.${b64url(signature)}`;
}

function apiHeaders(bearer: string): Headers {
	return new Headers({
		Authorization: `Bearer ${bearer}`,
		Accept: ACCEPT,
		"User-Agent": "stylebook",
		"X-GitHub-Api-Version": "2022-11-28",
	});
}

export interface GithubRepoChoice {
	fullName: string;
	empty: boolean;
	private: boolean;
}

export interface GithubInstallation {
	account: string;
	accountType: "User" | "Organization";
	permissions: { administration?: string; contents?: string };
}

async function appToken(env: Env): Promise<string | null> {
	if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
	try {
		return await githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
	} catch {
		return null;
	}
}

export async function githubInstallation(env: Env, installationId: string): Promise<GithubInstallation | null> {
	const jwt = await appToken(env);
	if (!jwt) return null;
	const response = await fetch(`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}`, {
		headers: apiHeaders(jwt),
	});
	if (!response.ok) return null;
	const body = (await response.json()) as {
		account?: { login?: string; type?: string };
		permissions?: { administration?: string; contents?: string };
	};
	const account = body.account?.login;
	if (!account) return null;
	return {
		account,
		accountType: body.account?.type === "Organization" ? "Organization" : "User",
		permissions: body.permissions ?? {},
	};
}

/** An installation token lives for one hour and is not stored. */
export async function githubInstallationToken(env: Env, installationId: string): Promise<string | null> {
	const jwt = await appToken(env);
	if (!jwt) return null;
	const response = await fetch(
		`${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
		{ method: "POST", headers: apiHeaders(jwt) },
	);
	if (!response.ok) return null;
	const body = (await response.json()) as { token?: string };
	return body.token || null;
}

export async function githubRepositories(token: string): Promise<GithubRepoChoice[] | null> {
	const response = await fetch(`${GITHUB_API}/installation/repositories?per_page=100`, {
		headers: apiHeaders(token),
	});
	if (!response.ok) return null;
	const body = (await response.json()) as {
		repositories?: { full_name?: string; private?: boolean; size?: number }[];
	};
	const choices: GithubRepoChoice[] = [];
	for (const repo of body.repositories ?? []) {
		if (!repo.full_name || !githubAddress(repo.full_name)) continue;
		choices.push({
			fullName: repo.full_name,
			empty: (repo.size ?? 0) === 0,
			private: repo.private !== false,
		});
	}
	choices.sort((left, right) => Number(right.empty) - Number(left.empty) || left.fullName.localeCompare(right.fullName));
	return choices;
}

export async function githubCreatePrivate(
	token: string,
	account: string,
	accountType: "User" | "Organization",
	name: string,
): Promise<{ address: string } | { sentence: string }> {
	const body = privateRepositoryBody(name);
	if (!body) return { sentence: "Give the repository a short name." };
	const path =
		accountType === "Organization"
			? `${GITHUB_API}/orgs/${encodeURIComponent(account)}/repos`
			: `${GITHUB_API}/user/repos`;
	const response = await fetch(path, {
		method: "POST",
		headers: apiHeaders(token),
		body: JSON.stringify(body),
	});
	if (!response.ok) return { sentence: "GitHub could not create that. Create a private repository and pick it here." };
	const created = (await response.json()) as { full_name?: string; private?: boolean };
	if (created.private !== true || !created.full_name) {
		return { sentence: "Stylebook will not use a public repository." };
	}
	const address = githubAddress(created.full_name);
	if (!address) return { sentence: "GitHub could not create that. Create a private repository and pick it here." };
	return { address };
}

export function installUrl(slug: string, state: string): string {
	const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
	url.searchParams.set("state", state);
	return url.toString();
}
