// The Worker typecheck lists no Node types. nodejs_compat provides this module.
declare module "node:zlib" {
	export class Inflate {
		bytesWritten: number;
		on(event: "data", listener: (chunk: Uint8Array) => void): this;
		on(event: "error", listener: () => void): this;
		on(event: "end", listener: () => void): this;
		on(event: "close", listener: () => void): this;
		end(data: Uint8Array): void;
		destroy(): void;
	}
}
