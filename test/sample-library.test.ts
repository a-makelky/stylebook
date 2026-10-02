import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STARTER_SKILL } from "../src/seed";

const root = join(__dirname, "..", "sample-library");

function frontMatter(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	if (!match) return {};
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
	}
	return fields;
}

describe("sample library", () => {
	const skills = readdirSync(join(root, "skills"));

	it("has the skills the demo uses", () => {
		expect(skills.sort()).toEqual([
			"contract-summary",
			"interview-to-draft",
			"pitch-deck-outline",
			"research-brief",
			"transcript-clean-up",
		]);
	});

	it.each(skills)("%s has a name matching its folder and a description", (skill) => {
		const fields = frontMatter(readFileSync(join(root, "skills", skill, "SKILL.md"), "utf8"));
		expect(fields.name).toBe(skill);
		expect(fields.description?.length ?? 0).toBeGreaterThan(40);
	});

	it("keeps interview-to-draft identical to the skill the live demo publishes", () => {
		expect(readFileSync(join(root, "skills", "interview-to-draft", "SKILL.md"), "utf8")).toBe(
			STARTER_SKILL,
		);
	});

	it("names only skills that exist in its workflows", () => {
		for (const file of readdirSync(join(root, "workflows"))) {
			const text = readFileSync(join(root, "workflows", file), "utf8");
			for (const [, name] of text.matchAll(/`([a-z0-9-]+)`/g)) {
				expect(skills).toContain(name);
			}
		}
	});

	it("keeps no secrets in its connections", () => {
		const text = readFileSync(join(root, "connections", "servers.json"), "utf8");
		const servers = JSON.parse(text) as { mcpServers: Record<string, { url?: string }> };
		expect(Object.keys(servers.mcpServers).length).toBeGreaterThan(0);
		expect(text).not.toMatch(/token|secret|password|key/i);
	});
});
