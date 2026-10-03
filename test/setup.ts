// The OAuth library checks this flag before it will accept a published client
// identity. Wrangler sets it from compatibility_flags. Tests are not workerd.
(globalThis as unknown as { Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: boolean } } }).Cloudflare = {
	compatibilityFlags: { global_fetch_strictly_public: true },
};
