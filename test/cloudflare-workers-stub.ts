// Vitest runs in Node. The real classes come from the Workers runtime.
export class WorkerEntrypoint<Env = unknown> {
	env: Env;
	constructor(_ctx: unknown, env: Env) {
		this.env = env;
	}
}

export class WorkflowEntrypoint<Env = unknown> {
	env: Env;
	constructor(_ctx: unknown, env: Env) {
		this.env = env;
	}
}
