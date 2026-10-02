// Vitest runs in Node. The real class comes from the Workers runtime.
export class WorkflowEntrypoint<Env = unknown> {
	env: Env;
	constructor(_ctx: unknown, env: Env) {
		this.env = env;
	}
}
