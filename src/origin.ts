// Defence in depth beside the SameSite=Strict session cookie.
// A browser sends Origin on a POST. Sec-Fetch-Site is sent on browser requests.
// Git and MCP clients send neither, so those calls are unchanged.

export function foreignPost(request: Request): boolean {
	if (request.method !== "POST") return false;
	const site = new URL(request.url).origin;
	const origin = request.headers.get("Origin");
	if (origin !== null && origin !== site) return true;
	const fetchSite = request.headers.get("Sec-Fetch-Site");
	if (fetchSite !== null && fetchSite !== "same-origin") return true;
	return false;
}

export function foreignPostResponse(): Response {
	return new Response("That request came from another site.\n", {
		status: 403,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
	});
}
