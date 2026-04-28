import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SecretArtifactRecord {
	id: string;
	sessionId: string;
	kind: "mask";
	mimeType: "text/plain";
	content: string;
	bytes: number;
	chars: number;
	sourcePath: string;
	createdAt: string;
	metadata: {
		pattern: string;
	};
}

export function assertSecretArtifactId(id: string): void {
	if (!/^psm_mask_[a-f0-9]{24}$/.test(id)) {
		throw new Error(`Invalid pi-secret-mask artifact id "${id}"`);
	}
}

export function secretReference(id: string): string {
	assertSecretArtifactId(id);
	return `\${secret:${id}}`;
}

export class SecretArtifactStore {
	readonly root: string;

	constructor(readonly sessionId: string, root = join(defaultAgentDir(), "pi-secret-mask", sessionId)) {
		this.root = root;
	}

	putSecret(input: { content: string; sourcePath: string; pattern: string }): SecretArtifactRecord {
		mkdirSync(this.root, { recursive: true });
		const hash = createHash("sha256")
			.update(this.sessionId)
			.update("\0")
			.update(input.pattern)
			.update("\0")
			.update(input.sourcePath)
			.update("\0")
			.update(input.content)
			.digest("hex")
			.slice(0, 24);
		const id = `psm_mask_${hash}`;
		const path = this.pathFor(id);
		if (existsSync(path)) {
			try {
				return JSON.parse(readFileSync(path, "utf-8")) as SecretArtifactRecord;
			} catch {
				// Deterministic artifacts are rewritten from the current source text below.
			}
		}

		const record: SecretArtifactRecord = {
			id,
			sessionId: this.sessionId,
			kind: "mask",
			mimeType: "text/plain",
			content: input.content,
			bytes: Buffer.byteLength(input.content, "utf-8"),
			chars: [...input.content].length,
			sourcePath: input.sourcePath,
			createdAt: new Date().toISOString(),
			metadata: { pattern: input.pattern },
		};
		this.writeJsonAtomic(path, record);
		appendFileSync(join(this.root, "artifacts.jsonl"), `${JSON.stringify({ ...record, content: undefined })}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		return record;
	}

	readSecret(id: string): string {
		assertSecretArtifactId(id);
		const path = this.pathFor(id);
		if (!existsSync(path)) throw new Error(`Secret artifact not found: ${id}`);
		const record = JSON.parse(readFileSync(path, "utf-8")) as SecretArtifactRecord;
		return record.content;
	}

	private pathFor(id: string): string {
		return join(this.root, `${id}.json`);
	}

	private writeJsonAtomic(path: string, record: SecretArtifactRecord): void {
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmp, path);
	}
}

export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}
