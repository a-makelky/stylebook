// Backups. Admins download, mirror and restore. Members see one sentence.
// Words on this page follow design/README.md.

import { actorFromRequest, keyCookie } from "./auth";
import { downloadWorkspace, cleanBackupAddress, startFromBackup, startFromHistory, DOWNLOAD_TOO_BIG } from "./backup";
import { sealSecret } from "./backup-crypto";
import {
	installationWorkspace,
	readMirror,
	removeMirror,
	saveGithubState,
	saveMirror,
	setMirrorKeep,
	takeGithubState,
	writeAudit,
	type MirrorRow,
} from "./backup-store";
import type { Actor } from "./actors";
import type { Env } from "./env";
import {
	canCreateRepository,
	githubAddress,
	githubCreatePrivate,
	githubInstallation,
	githubInstallationToken,
	githubReady,
	githubRepositories,
	githubUserCanUseInstallation,
	GITHUB_NOT_READY,
	installUrl,
	type GithubRepoChoice,
} from "./github-app";
import { clientIp } from "./mail";
import { cloneHistory, MIRROR_REF, runMirror } from "./mirror";
import { plainDate } from "./review";
import { describeError } from "./redact";
import { authorize, workspaceState } from "./roles";
import { openSession, workspaceById } from "./teams";

export const BACKUP_ADMIN_LINE = "An Admin can download or back up this workspace.";
export const OTHER_NOT_READY = "Backups to another service are not set up on this server yet.";
export const GITHUB_UNCONFIRMED = "That GitHub connection could not be confirmed. Try again.";
export const GITHUB_IN_USE = "That GitHub connection is already used by another workspace.";

export const BACKUP_POSTS = [
	"/backups/download",
	"/backups/github/connect",
	"/backups/github/callback",
	"/backups/github/choose",
	"/backups/github/create",
	"/backups/github/now",
	"/backups/github/keep",
	"/backups/github/disconnect",
	"/backups/github/restore",
	"/backups/other",
	"/backups/other/now",
	"/backups/other/keep",
	"/backups/other/disconnect",
	"/backups/restore",
] as const;

const GETS = new Set(["/backups", "/backups/github/callback", "/backups/github/setup"]);

export function isBackupPath(path: string): boolean {
	return GETS.has(path) || (BACKUP_POSTS as readonly string[]).includes(path);
}

export function lastBackedUp(iso: string, now = new Date()): string {
	const seconds = Math.round((now.getTime() - Date.parse(iso)) / 1000);
	if (!Number.isFinite(seconds) || seconds < 45) return "Last backed up just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `Last backed up ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 36) return `Last backed up ${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.round(hours / 24);
	return `Last backed up ${days} day${days === 1 ? "" : "s"} ago`;
}

export function mirrorStatus(row: Pick<MirrorRow, "lastOkAt" | "lastError"> | null, now = new Date()): string {
	if (row?.lastError) return row.lastError;
	if (row?.lastOkAt) return lastBackedUp(row.lastOkAt, now);
	return "Not backed up yet.";
}

function esc(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Shown when GitHub sends the browser back. Nothing is saved until the POST. */
export function githubReturnMain(params: URLSearchParams): string {
	const code = params.get("code") ?? "";
	const installation = params.get("installation_id") ?? "";
	const state = params.get("state") ?? "";
	const ready =
		/^[A-Za-z0-9._-]{8,200}$/.test(code) &&
		/^\d{1,20}$/.test(installation) &&
		/^[0-9a-f]{48}$/.test(state);
	if (!ready) {
		return `<div class="sheet"><h1>GitHub</h1><p>GitHub did not finish connecting. Try again from Backups.</p></div>`;
	}
	return `<div class="sheet">
    <h1>GitHub</h1>
    <p>Finish connecting GitHub to this workspace.</p>
    <form method="post" action="/backups/github/callback">
      <input type="hidden" name="code" value="${esc(code)}">
      <input type="hidden" name="installation_id" value="${esc(installation)}">
      <input type="hidden" name="state" value="${esc(state)}">
      <button class="primary" type="submit">Finish connecting GitHub</button>
    </form>
  </div>`;
}

export function githubSetupMain(code: string | null): string {
	const safe = code && /^[A-Za-z0-9_-]{8,200}$/.test(code) ? code : "";
	const body = safe
		? `<p>GitHub sent a one-time code. Copy it and exchange it on your computer, then add the secrets there. This page does not save the code.</p>
      <pre>${esc(safe)}</pre>`
		: `<p>GitHub did not send a code. Start again from the manifest.</p>`;
	return `<div class="sheet"><h1>GitHub</h1>${body}</div>`;
}

function memberMain(): string {
	return `<div class="sheet">
    <p class="meta"><a href="/">Library</a></p>
    <h1>Backups</h1>
    <p>${BACKUP_ADMIN_LINE}</p>
  </div>`;
}

function noticeBlock(notice: string | null, tone: "ok" | "error"): string {
	if (!notice) return "";
	return `<p class="${tone === "error" ? "overlap" : "notice"}">${esc(notice)}</p>`;
}

function keepForm(action: string, on: boolean): string {
	return `<form method="post" action="${action}">
    <label class="check"><input type="checkbox" name="keep" value="yes"${on ? " checked" : ""}> Keep it up to date</label>
    <button class="secondary" type="submit">Save</button>
  </form>`;
}

function nowForm(action: string): string {
	return `<form method="post" action="${action}"><button class="primary" type="submit">Back up now</button></form>`;
}

function disconnectForm(action: string, where: string): string {
	return `<form method="post" action="${action}"><button class="text" type="submit">Disconnect</button></form>
    <p class="meta">This stops backups. It does not delete anything ${where}.</p>`;
}

function githubBlock(input: {
	configured: boolean;
	row: MirrorRow | null;
	choices: GithubRepoChoice[] | null;
	canCreate: boolean;
	problem: string | null;
}): string {
	if (!input.configured && !input.row) {
		return `<h2>Back up to GitHub</h2><p>${GITHUB_NOT_READY}</p>`;
	}
	if (!input.configured) {
		return `<h2>Back up to GitHub</h2><p>${GITHUB_NOT_READY}</p>${disconnectForm("/backups/github/disconnect", "on GitHub")}`;
	}
	if (!input.row?.installationId) {
		return `<h2>Back up to GitHub</h2>
      <p>Connect GitHub, then pick an empty repository. Stylebook never creates a public repository.</p>
      <form method="post" action="/backups/github/connect"><button class="primary" type="submit">Connect GitHub</button></form>`;
	}
	if (!input.row.address) {
		const options = (input.choices ?? [])
			.map((choice) => {
				const label = choice.empty ? `${choice.fullName} (empty)` : choice.fullName;
				return `<option value="${esc(choice.fullName)}">${esc(label)}</option>`;
			})
			.join("");
		const picker = options
			? `<form method="post" action="/backups/github/choose">
          <label for="github-choice">Pick an empty repository</label>
          <select id="github-choice" name="choice">${options}</select>
          <button class="primary" type="submit">Use this repository</button>
        </form>`
			: `<p>${esc(input.problem ?? "Create a private repository on GitHub, leave it empty, and pick it here.")}</p>`;
		const create = input.canCreate
			? `<form method="post" action="/backups/github/create">
          <label for="github-name">Create a private repository named</label>
          <input id="github-name" name="name" required>
          <button class="secondary" type="submit">Create</button>
        </form>`
			: `<p class="meta">Create a private repository on GitHub, leave it empty, and pick it here.</p>`;
		return `<h2>Back up to GitHub</h2>${picker}${create}${disconnectForm("/backups/github/disconnect", "on GitHub")}`;
	}
	const where = input.row.login ? `${input.row.login} / ${input.row.address.split("/").slice(-1)[0]?.replace(/\.git$/, "")}` : "GitHub";
	return `<h2>Back up to GitHub</h2>
    <p class="meta">Backing up to ${esc(where)}.</p>
    <p>${esc(mirrorStatus(input.row))}</p>
    ${nowForm("/backups/github/now")}
    ${keepForm("/backups/github/keep", input.row.keepCurrent)}
    ${disconnectForm("/backups/github/disconnect", "on GitHub")}`;
}

function otherBlock(configured: boolean, row: MirrorRow | null): string {
	if (!configured && !row) return `<h2>Back up to another service</h2><p>${OTHER_NOT_READY}</p>`;
	if (!row?.address) {
		return `<h2>Back up to another service</h2>
      <p>GitLab, Bitbucket, Codeberg, or a company server. The secret is saved for this workspace and is not shown again.</p>
      <form method="post" action="/backups/other">
        <label for="backup-address">Address</label>
        <input id="backup-address" name="address" required autocomplete="off">
        <label for="backup-login">Name</label>
        <input id="backup-login" name="login" autocomplete="off" placeholder="stylebook">
        <label for="backup-secret">Secret</label>
        <input id="backup-secret" name="secret" type="password" required autocomplete="off">
        <p class="meta">Saved for this workspace and not shown again.</p>
        <button class="primary" type="submit">Save</button>
      </form>`;
	}
	return `<h2>Back up to another service</h2>
    <p class="meta">${esc(row.address.replace(/\.git\/?$/, ""))}</p>
    <p>${esc(mirrorStatus(row))}</p>
    ${nowForm("/backups/other/now")}
    ${keepForm("/backups/other/keep", row.keepCurrent)}
    ${disconnectForm("/backups/other/disconnect", "on that service")}`;
}

function restoreBlock(githubChoices: GithubRepoChoice[] | null): string {
	const github = githubChoices
		? `<form method="post" action="/backups/github/restore">
        <label for="restore-github-name">Name the new workspace</label>
        <input id="restore-github-name" name="name" required>
        <label for="restore-github">GitHub backup</label>
        <select id="restore-github" name="choice">${githubChoices
					.map((choice) => `<option value="${esc(choice.fullName)}">${esc(choice.fullName)}</option>`)
					.join("")}</select>
        <button class="secondary" type="submit">Restore</button>
      </form>`
		: "";
	return `<h2>Restore</h2>
    <p>Start a workspace from a backup. This does not change the workspace you are in. People and agents are invited again.</p>
    <form method="post" action="/backups/restore" enctype="multipart/form-data">
      <label for="restore-name">Name the new workspace</label>
      <input id="restore-name" name="name" required>
      <label for="restore-file">Backup file</label>
      <input id="restore-file" name="file" type="file" accept=".zip,application/zip" required>
      <button class="primary" type="submit">Restore</button>
    </form>
    ${github}`;
}

function readOnlyNote(title: string): string {
	return `<h2>${title}</h2><p>This workspace is read-only.</p>`;
}

export function renderBackups(input: {
	notice: string | null;
	tone: "ok" | "error";
	githubConfigured: boolean;
	otherConfigured: boolean;
	github: MirrorRow | null;
	other: MirrorRow | null;
	choices: GithubRepoChoice[] | null;
	canCreate: boolean;
	githubProblem: string | null;
	readOnly?: boolean;
}): string {
	const when = plainDate(new Date().toISOString());
	return `<div class="sheet backups">
    <p class="meta"><a href="/">Library</a></p>
    <h1>Backups</h1>
    <p class="meta">${esc(when)}</p>
    ${noticeBlock(input.notice, input.tone)}
    <h2>Download</h2>
    <p>A folder of the library as it is now, with History.</p>
    <form method="post" action="/backups/download">
      <label class="check" for="include-suggestions"><input id="include-suggestions" type="checkbox" name="suggestions" value="yes"> Include open suggestions</label>
      <button class="primary" type="submit">Download</button>
    </form>
    ${input.readOnly ? readOnlyNote("Back up to GitHub") : githubBlock({
			configured: input.githubConfigured,
			row: input.github,
			choices: input.choices,
			canCreate: input.canCreate,
			problem: input.githubProblem,
		})}
    ${input.readOnly ? readOnlyNote("Back up to another service") : otherBlock(input.otherConfigured, input.other)}
    ${input.readOnly ? readOnlyNote("Restore") : restoreBlock(input.githubConfigured && input.github?.installationId ? input.choices : null)}
  </div>`;
}

export type Layout = (workspaceName: string, main: string, status?: number, admin?: boolean) => Response;

function redirect(location: string, cookies: string[] = []): Response {
	const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 303, headers });
}

function back(notice: string, tone: "ok" | "error" = "ok"): Response {
	const params = new URLSearchParams({ notice });
	if (tone === "error") params.set("tone", "error");
	return redirect(`/backups?${params.toString()}`);
}

function randomState(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function posted(request: Request): Promise<URLSearchParams> {
	return new URLSearchParams(await request.text());
}

export async function handleBackups(request: Request, env: Env, layout: Layout): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (!isBackupPath(path) || path === "/backups/github/setup") return null;

	const signed = await actorFromRequest(request, env);
	if (!signed) return null;

	const workspace = await workspaceById(env.DB, signed.actor.workspaceId);
	const workspaceName = workspace?.name ?? "Workspace";
	const decision = await authorize(env, signed.actor, "export");
	const show = (main: string, status = 200) => layout(workspaceName, main, status, decision.ok);
	if (!decision.ok) {
		const status = request.method === "GET" && path === "/backups" ? 200 : 403;
		return show(memberMain(), status);
	}

	const notice = url.searchParams.get("notice");
	const tone = url.searchParams.get("tone") === "error" ? "error" : "ok";
	const state = await workspaceState(env.DB, signed.actor.workspaceId);
	const readOnly = Boolean(state?.suspended);

	try {
		if (request.method === "POST" && path !== "/backups/download") {
			const action = path === "/backups/restore" || path === "/backups/github/restore" ? "restore" : "mirror";
			const decision = await authorize(env, signed.actor, action);
			if (!decision.ok) {
				await writeAudit(env.DB, signed.actor, action === "restore" ? "restore" : "mirror-now", decision.sentence);
				return back(decision.sentence, "error");
			}
		}

		if (request.method === "POST" && path === "/backups/download") {
			const form = await posted(request);
			const file = await downloadWorkspace(env, signed.actor, form.get("suggestions") === "yes");
			if ("sentence" in file) {
				await writeAudit(env.DB, signed.actor, "download", file.sentence);
				return back(file.sentence, "error");
			}
			await writeAudit(env.DB, signed.actor, "download", `Downloaded. ${file.bytes} bytes in ${file.ms} ms.`);
			console.log(JSON.stringify({ event: "backup_download", bytes: file.bytes, ms: file.ms }));
			const headers = new Headers({
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${file.filename}"`,
				"Cache-Control": "no-store",
			});
			return new Response(file.zip, { status: 200, headers });
		}

		if (request.method === "POST" && path === "/backups/github/connect") {
			if (!githubReady(env)) return back(GITHUB_NOT_READY, "error");
			const state = randomState();
			await saveGithubState(env.DB, state, signed.actor);
			await writeAudit(env.DB, signed.actor, "mirror-connect", "Started connecting GitHub.");
			return redirect(installUrl(env.GITHUB_APP_SLUG ?? "", state));
		}

		if (request.method === "POST" && path === "/backups/github/callback") {
			if (!githubReady(env)) return back(GITHUB_NOT_READY, "error");
			const form = await posted(request);
			const stateValue = form.get("state") ?? "";
			const installation = form.get("installation_id") ?? "";
			const code = form.get("code") ?? "";
			if (!stateValue || !(await takeGithubState(env.DB, stateValue, signed.actor))) {
				return back("That connection expired. Try again.", "error");
			}
			const shapeOk = /^\d{1,20}$/.test(installation) && /^[A-Za-z0-9._-]{8,200}$/.test(code);
			const allowed = shapeOk && (await githubUserCanUseInstallation(env, code, installation));
			if (!allowed) {
				await writeAudit(env.DB, signed.actor, "mirror-connect", "Refused a GitHub connection.");
				return back(GITHUB_UNCONFIRMED, "error");
			}
			const owner = await installationWorkspace(env.DB, installation);
			if (owner && owner !== signed.actor.workspaceId) {
				await writeAudit(
					env.DB,
					signed.actor,
					"mirror-connect",
					"Refused a GitHub connection already used by another workspace.",
				);
				return back(GITHUB_IN_USE, "error");
			}
			const info = await githubInstallation(env, installation);
			const existing = await readMirror(env.DB, signed.actor.workspaceId, "github");
			await saveMirror(env.DB, signed.actor.workspaceId, {
				kind: "github",
				address: "",
				tokenCipher: null,
				installationId: installation,
				login: info?.account ?? null,
				keepCurrent: existing?.keepCurrent ?? false,
			});
			await writeAudit(env.DB, signed.actor, "mirror-connect", "Connected GitHub.");
			return back("Connected GitHub. Pick an empty repository.");
		}

		if (request.method === "POST" && (path === "/backups/github/choose" || path === "/backups/github/create")) {
			const row = await readMirror(env.DB, signed.actor.workspaceId, "github");
			if (!row?.installationId || !githubReady(env)) return back(GITHUB_NOT_READY, "error");
			const token = await githubInstallationToken(env, row.installationId);
			if (!token) return back("GitHub could not be reached. Try again.", "error");
			const form = await posted(request);
			let address: string | null = null;
			if (path === "/backups/github/create") {
				const info = await githubInstallation(env, row.installationId);
				if (!info || !canCreateRepository(info.permissions)) {
					return back("Create a private repository on GitHub, leave it empty, and pick it here.", "error");
				}
				const created = await githubCreatePrivate(token, info.account, info.accountType, form.get("name") ?? "");
				if ("sentence" in created) return back(created.sentence, "error");
				address = created.address;
			} else {
				const choices = await githubRepositories(token);
				const choice = form.get("choice") ?? "";
				if (!choices?.some((item) => item.fullName === choice)) {
					return back("Pick an empty repository.", "error");
				}
				address = githubAddress(choice);
			}
			if (!address) return back("Pick an empty repository.", "error");
			await saveMirror(env.DB, signed.actor.workspaceId, {
				kind: "github",
				address,
				tokenCipher: null,
				installationId: row.installationId,
				login: row.login,
				keepCurrent: row.keepCurrent,
			});
			await writeAudit(env.DB, signed.actor, "mirror-connect", "Chose a GitHub backup.");
			return back("GitHub backup saved.");
		}

		if (request.method === "POST" && path === "/backups/other") {
			if (!env.BACKUP_KEY) return back(OTHER_NOT_READY, "error");
			const form = await posted(request);
			const address = cleanBackupAddress(form.get("address") ?? "", url.host);
			if (!address) return back("Enter the address of the backup.", "error");
			const secret = (form.get("secret") ?? "").trim();
			if (secret.length < 8 || secret.length > 500 || /[\r\n]/.test(secret)) {
				return back("Enter the secret for that backup.", "error");
			}
			const login = (form.get("login") ?? "").trim().slice(0, 80) || "stylebook";
			const existing = await readMirror(env.DB, signed.actor.workspaceId, "other");
			await saveMirror(env.DB, signed.actor.workspaceId, {
				kind: "other",
				address,
				tokenCipher: await sealSecret(env.BACKUP_KEY, secret),
				installationId: null,
				login,
				keepCurrent: existing?.keepCurrent ?? false,
			});
			await writeAudit(env.DB, signed.actor, "mirror-connect", "Saved a backup to another service.");
			return back("Backup saved.");
		}

		const mirrorAction = /^(.*)\/(now|keep|disconnect)$/.exec(path);
		if (request.method === "POST" && mirrorAction) {
			const kind = mirrorAction[1] === "/backups/github" ? "github" : mirrorAction[1] === "/backups/other" ? "other" : null;
			const verb = mirrorAction[2];
			if (!kind || !verb) return show(memberMain(), 404);
			if (verb === "disconnect") {
				await removeMirror(env.DB, signed.actor.workspaceId, kind);
				await writeAudit(env.DB, signed.actor, "mirror-disconnect", "Disconnected a backup.");
				return back("Disconnected.");
			}
			if (verb === "keep") {
				const form = await posted(request);
				const keep = form.get("keep") === "yes";
				await setMirrorKeep(env.DB, signed.actor.workspaceId, kind, keep);
				await writeAudit(
					env.DB,
					signed.actor,
					"mirror-keep",
					keep ? "Will keep this backup up to date." : "Will not keep this backup up to date.",
				);
				return back(keep ? "This backup stays up to date." : "This backup will not update on its own.");
			}
			const result = await runMirror(env, signed.actor.workspaceId, kind);
			await writeAudit(env.DB, signed.actor, "mirror-now", result.ok ? "Backed up." : result.sentence);
			return back(result.ok ? "Backed up." : result.sentence, result.ok ? "ok" : "error");
		}

		if (request.method === "POST" && path === "/backups/restore") {
			const cap = Number(env.MAX_BACKUP_UPLOAD_BYTES ?? "20000000");
			const declared = Number(request.headers.get("Content-Length") ?? "0");
			if (Number.isFinite(declared) && declared > cap + 1_000_000) {
				await writeAudit(env.DB, signed.actor, "restore", DOWNLOAD_TOO_BIG);
				return back("This backup is larger than Stylebook can restore.", "error");
			}
			const data = await request.formData();
			const name = String(data.get("name") ?? "");
			const file = data.get("file");
			if (!(file instanceof Blob)) return back("Choose a backup file.", "error");
			if (file.size > cap) {
				await writeAudit(env.DB, signed.actor, "restore", "This backup is larger than Stylebook can restore.");
				return back("This backup is larger than Stylebook can restore.", "error");
			}
			const started = await startFromBackup(env, signed.actor, new Uint8Array(await file.arrayBuffer()), name, clientIp(request));
			if ("sentence" in started) {
				await writeAudit(env.DB, signed.actor, "restore", started.sentence);
				return back(started.sentence, "error");
			}
			await writeAudit(env.DB, signed.actor, "restore", "Started a workspace from a backup.");
			await writeAudit(env.DB, started.actor, "restore", "Started from a backup.");
			const secret = await openSession(env.DB, started.actor);
			return redirect("/?notice=This workspace was started from the backup.", [keyCookie(secret)]);
		}

		if (request.method === "POST" && path === "/backups/github/restore") {
			if (!githubReady(env)) return back(GITHUB_NOT_READY, "error");
			const row = await readMirror(env.DB, signed.actor.workspaceId, "github");
			if (!row?.installationId) return back("Connect GitHub first.", "error");
			const form = await posted(request);
			const choice = form.get("choice") ?? "";
			const token = await githubInstallationToken(env, row.installationId, choice.split("/")[1]);
			if (!token) return back("GitHub could not be reached. Try again.", "error");
			const choices = await githubRepositories(token);
			if (!choices?.some((item) => item.fullName === choice)) return back("Choose a GitHub backup.", "error");
			const address = githubAddress(choice);
			if (!address) return back("Choose a GitHub backup.", "error");
			let copy: Awaited<ReturnType<typeof cloneHistory>>;
			try {
				copy = await cloneHistory(address, token, "x-access-token", "stylebook");
			} catch {
				return back("That backup has no Stylebook history.", "error");
			}
			const started = await startFromHistory(env, signed.actor, copy, form.get("name") ?? "", clientIp(request), MIRROR_REF);
			if ("sentence" in started) {
				await writeAudit(env.DB, signed.actor, "restore", started.sentence);
				return back(started.sentence, "error");
			}
			await writeAudit(env.DB, signed.actor, "restore", "Started a workspace from a GitHub backup.");
			await writeAudit(env.DB, started.actor, "restore", "Started from a backup.");
			const secret = await openSession(env.DB, started.actor);
			return redirect("/?notice=This workspace was started from the backup.", [keyCookie(secret)]);
		}

		if (request.method === "GET" && path === "/backups") {
			const github = await readMirror(env.DB, signed.actor.workspaceId, "github");
			const other = await readMirror(env.DB, signed.actor.workspaceId, "other");
			let choices: GithubRepoChoice[] | null = null;
			let canCreate = false;
			let githubProblem: string | null = null;
			if (!readOnly && githubReady(env) && github?.installationId) {
				const token = await githubInstallationToken(env, github.installationId);
				const info = await githubInstallation(env, github.installationId);
				canCreate = Boolean(info && canCreateRepository(info.permissions));
				choices = token ? await githubRepositories(token) : null;
				if (!choices) githubProblem = "GitHub could not be reached. Try again.";
			}
			return show(
				renderBackups({
					notice,
					tone,
					githubConfigured: githubReady(env),
					otherConfigured: Boolean(env.BACKUP_KEY),
					github,
					other,
					choices,
					canCreate,
					githubProblem,
					readOnly,
				}),
			);
		}
	} catch (error) {
		console.log(JSON.stringify({ event: "backup_failed", message: describeError(error).message }));
		return show(
			renderBackups({
				notice: "Something went wrong. Try again.",
				tone: "error",
				githubConfigured: githubReady(env),
				otherConfigured: Boolean(env.BACKUP_KEY),
				github: null,
				other: null,
				choices: null,
				canCreate: false,
				githubProblem: null,
				readOnly,
			}),
			500,
		);
	}

	return show(memberMain(), 404);
}
