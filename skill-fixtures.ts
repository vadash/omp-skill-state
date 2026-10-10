import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";

// Writes a skill directory under `root` and returns the Skill entry omp would
// discover. Shared by index.test.ts and state.test.ts so the fixture has one shape.
export async function makeSkill(root: string, name: string, schema?: string): Promise<Skill> {
	const baseDir = path.join(root, name);
	await mkdir(baseDir);
	await writeFile(path.join(baseDir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill ${name}\n---\n\nBody of ${name}.\n`);
	if (schema !== undefined) await writeFile(path.join(baseDir, "state.schema.json"), schema);
	return { name, description: `test skill ${name}`, filePath: path.join(baseDir, "SKILL.md"), baseDir, source: "test" };
}
