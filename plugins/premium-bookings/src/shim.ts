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

export interface ContentItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	locale: string | null;
	data: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
}

export interface UserInfo {
	id: string;
	email: string;
	name: string | null;
	role: number;
}

/** Plugin-to-plugin interop (`plugins:call` capability). */
export interface PluginsAccess {
	/** Invoke a route of another installed plugin that lists us in its `callers`. Throws when refused. */
	call<T = unknown>(pluginId: string, route: string, input?: unknown): Promise<T>;
	/** Publish `<ourId>:<name>` to every plugin subscribed through a `plugin:event` hook. */
	emit(name: string, payload?: unknown): Promise<void>;
}

/** What a `plugin:event` hook receives. */
export interface PluginEvent<T = unknown> {
	name: string;
	from: string;
	payload: T;
	emittedAt: string;
}

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
	content?: {
		get(collection: string, id: string): Promise<ContentItem | null>;
		list(collection: string, options?: { limit?: number; cursor?: string; orderBy?: Record<string, "asc" | "desc">; where?: { status?: string; locale?: string } }): Promise<{ items: ContentItem[]; cursor?: string; hasMore: boolean }>;
	};
	users?: {
		get(id: string): Promise<UserInfo | null>;
		getByEmail(email: string): Promise<UserInfo | null>;
		list(opts?: { role?: number; limit?: number; cursor?: string }): Promise<{ items: UserInfo[]; nextCursor?: string }>;
	};
	plugins?: PluginsAccess;
	requestMeta?: { ip: string | null; userAgent: string | null; referer: string | null; geo?: { country?: string | null } | null };
}

export interface RouteContext<TInput = unknown> extends PluginContext {
	input: TInput;
	request: Request;
	/** Bound on session/permission routes. */
	user?: UserInfo;
	/** Set when another plugin invoked this route through `ctx.plugins.call`. */
	callerPlugin?: string;
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
		return handler(merged);
	};
}

/** The sandbox hands routes a plain request snapshot (headers as an object) or a real Request. */
export function headerValue(request: unknown, name: string): string {
	const h = (request as { headers?: unknown } | undefined)?.headers;
	if (!h) return "";
	if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? "";
	const o = h as Record<string, string>;
	return o[name] ?? o[name.toLowerCase()] ?? "";
}

/** Routes meant for sibling plugins only (manifest `callers`): refuse direct HTTP callers. */
export function requireCaller(ctx: RouteContext<unknown>, ...allowed: string[]): string {
	const from = ctx.callerPlugin;
	if (!from) throw PluginRouteError.forbidden("This route is for other plugins");
	if (allowed.length && !allowed.includes(from)) throw PluginRouteError.forbidden(`Not callable by ${from}`);
	return from;
}

export const definePlugin = <T>(definition: T): T => definition;
