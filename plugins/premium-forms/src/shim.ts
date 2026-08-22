/**
 * Minimal stand-ins for the `emdash` runtime imports the handlers use, so
 * the sandbox bundle is fully self-contained (the sandbox cannot import
 * `emdash`). Types are structural — they mirror the subset we touch.
 */

export type StorageCollection<T = unknown> = {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	delete(id: string): Promise<boolean>;
	exists(id: string): Promise<boolean>;
	getMany(ids: string[]): Promise<Map<string, T>>;
	putMany(items: Array<{ id: string; data: T }>): Promise<void>;
	deleteMany(ids: string[]): Promise<number>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean }>;
	count(where?: Record<string, unknown>): Promise<number>;
};

export interface PluginContext {
	plugin: { id: string; version: string };
	storage: Record<string, StorageCollection>;
	kv: {
		get<T>(key: string): Promise<T | null>;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<boolean>;
		list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
	};
	log: { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void };
	http?: { fetch(url: string, init?: RequestInit): Promise<Response> };
	email?: { send(message: { to: string; subject: string; text?: string; html?: string }): Promise<unknown> };
	media?: unknown;
	cron?: { schedule(name: string, opts: { schedule: string }): Promise<void>; cancel(name: string): Promise<void> };
	site?: { url: string };
	requestMeta?: { ip: string | null; userAgent: string | null; referer: string | null; geo?: { country?: string | null } | null };
}

export interface RouteContext<TInput = unknown> extends PluginContext {
	input: TInput;
	request: Request;
}

/**
 * Route errors. Inside the sandbox only the message survives the RPC
 * boundary (the host answers 400 ROUTE_ERROR with it), so keep messages
 * user-readable.
 */
export class PluginRouteError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status = 400,
	) {
		super(message);
		// Errors cross the isolate boundary as foreign-realm objects, so the host
		// falls back to String(err) = `${name}: ${message}`. An empty name makes
		// that the bare message; the machine-readable kind lives in `code`.
		this.name = "";
	}
	/** The sandbox host stringifies thrown errors (`${err}`) into the API
	 *  error message — return the bare message so visitors never see the
	 *  class name. */
	override toString(): string {
		return this.message;
	}
	toResponse(): Response {
		return new Response(JSON.stringify({ success: false, error: { code: this.code, message: this.message } }), {
			status: this.status,
			headers: { "Content-Type": "application/json" },
		});
	}
	static notFound(message: string) { return new PluginRouteError("NOT_FOUND", message, 404); }
	static forbidden(message: string) { return new PluginRouteError("FORBIDDEN", message, 403); }
	static badRequest(message: string) { return new PluginRouteError("BAD_REQUEST", message, 400); }
	static conflict(message: string) { return new PluginRouteError("CONFLICT", message, 409); }
	static internal(message: string) { return new PluginRouteError("INTERNAL", message, 500); }
}

/** Wrap a handler so PluginRouteErrors surface as status-bearing Responses. */
export function route<TIn, TOut>(handler: (ctx: RouteContext<TIn>) => Promise<TOut>) {
	return async (routeCtx: RouteContext<TIn>, ctx?: PluginContext): Promise<TOut> => {
		// Two-arg (routeCtx, ctx) calling convention: merge so handlers can use
		// either style; routeCtx carries input/request, ctx carries capabilities.
		const merged = (ctx ? Object.assign(Object.create(null), ctx, routeCtx) : routeCtx) as RouteContext<TIn>;
		// The sandbox bridge relays thrown Errors by message (as a 400 with
		// code ROUTE_ERROR); anything else is stringified. PluginRouteError is an
		// Error, so it travels as its message.
		return handler(merged);
	};
}

export const definePlugin = <T>(definition: T): T => definition;
