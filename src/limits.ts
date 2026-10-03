// Starting limits. Artifacts bills per operation after the included amount,
// and per GB-month of storage:
// https://developers.cloudflare.com/artifacts/platform/pricing/
// Values can be set on the Worker. When a var is absent, the default is used.

import type { Env } from "./env";

export interface Limits {
	workspaces: number;
	workspacesPerEmail: number;
	workspacesPerIpPerDay: number;
	people: number;
	agents: number;
	openSuggestions: number;
	signInEmailsPerHour: number;
	signInEmailsPerIpPerHour: number;
	signInEmailsGlobalPerHour: number;
}

export const DEFAULT_LIMITS: Limits = {
	workspaces: 40,
	workspacesPerEmail: 2,
	workspacesPerIpPerDay: 5,
	people: 25,
	agents: 40,
	openSuggestions: 200,
	signInEmailsPerHour: 5,
	signInEmailsPerIpPerHour: 20,
	signInEmailsGlobalPerHour: 100,
};

function num(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) return fallback;
	return parsed;
}

export interface BackupLimits {
	backupBytes: number;
	uploadBytes: number;
}

const DEFAULT_BACKUP_BYTES = 20_000_000;

export function backupLimits(env: { MAX_BACKUP_BYTES?: string; MAX_BACKUP_UPLOAD_BYTES?: string }): BackupLimits {
	return {
		backupBytes: num(env.MAX_BACKUP_BYTES, DEFAULT_BACKUP_BYTES),
		uploadBytes: num(env.MAX_BACKUP_UPLOAD_BYTES, DEFAULT_BACKUP_BYTES),
	};
}

export function limitsOf(env: Pick<Env, keyof LimitsAsEnv>): Limits {
	return {
		workspaces: num(env.MAX_WORKSPACES, DEFAULT_LIMITS.workspaces),
		workspacesPerEmail: num(env.MAX_WORKSPACES_PER_EMAIL, DEFAULT_LIMITS.workspacesPerEmail),
		workspacesPerIpPerDay: num(env.MAX_WORKSPACES_PER_IP_PER_DAY, DEFAULT_LIMITS.workspacesPerIpPerDay),
		people: num(env.MAX_PEOPLE, DEFAULT_LIMITS.people),
		agents: num(env.MAX_AGENTS, DEFAULT_LIMITS.agents),
		openSuggestions: num(env.MAX_OPEN_SUGGESTIONS, DEFAULT_LIMITS.openSuggestions),
		signInEmailsPerHour: num(env.MAX_SIGN_IN_EMAILS_PER_HOUR, DEFAULT_LIMITS.signInEmailsPerHour),
		signInEmailsPerIpPerHour: num(env.MAX_SIGN_IN_EMAILS_PER_IP_PER_HOUR, DEFAULT_LIMITS.signInEmailsPerIpPerHour),
		signInEmailsGlobalPerHour: num(env.MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR, DEFAULT_LIMITS.signInEmailsGlobalPerHour),
	};
}

type LimitsAsEnv = {
	MAX_WORKSPACES?: string;
	MAX_WORKSPACES_PER_EMAIL?: string;
	MAX_WORKSPACES_PER_IP_PER_DAY?: string;
	MAX_PEOPLE?: string;
	MAX_AGENTS?: string;
	MAX_OPEN_SUGGESTIONS?: string;
	MAX_SIGN_IN_EMAILS_PER_HOUR?: string;
	MAX_SIGN_IN_EMAILS_PER_IP_PER_HOUR?: string;
	MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR?: string;
};

export const LIMIT_MESSAGE = {
	workspaces: "Stylebook is not taking new workspaces right now.",
	workspacesPerEmail: "This email has already started as many workspaces as it can.",
	workspacesPerIp: "Too many workspaces were started from this network today. Try again tomorrow.",
	people: "This workspace has as many people as it can hold.",
	agents: "This workspace has as many agents as it can hold.",
	openSuggestions: "This workspace has as many open suggestions as it can hold.",
	signIn: "Too many sign-in emails were sent. Try again in an hour.",
} as const;
