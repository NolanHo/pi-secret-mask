import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretArtifactStore } from "../src/artifacts.js";
import { projectMessages, projectText } from "../src/project.js";
import { injectSecretReferences, redactInjectedSecrets, replaceRecordContents } from "../src/secret-ref.js";

function withStore(fn: (store: SecretArtifactStore) => void): void {
	const root = mkdtempSync(join(tmpdir(), "pi-secret-mask-test-"));
	try {
		fn(new SecretArtifactStore("test-session", root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("projectText masks assignment secrets and stores the raw value outside projected text", () => {
	withStore((store) => {
		const raw = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456";
		const projected = projectText(raw, "test.assignment", store);

		assert.equal(projected.maskCount, 1);
		assert.match(projected.value, /OPENAI_API_KEY=\[secret_ref id=psm_mask_[a-f0-9]{24}/);
		assert.doesNotMatch(projected.value, /abcdefghijklmnopqrstuvwxyz123456/);
		const id = projected.value.match(/psm_mask_[a-f0-9]{24}/)?.[0];
		assert.ok(id);
		assert.equal(store.readSecret(id), "sk-proj-abcdefghijklmnopqrstuvwxyz123456");
	});
});

test("projectText does not remask existing secret markers", () => {
	withStore((store) => {
		const once = projectText("TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456", "test.marker", store);
		const twice = projectText(once.value, "test.marker", store);

		assert.equal(once.maskCount, 1);
		assert.equal(twice.maskCount, 0);
		assert.equal(twice.value, once.value);
	});
});

test("projectMessages masks text blocks without changing non-text blocks", () => {
	withStore((store) => {
		const image = { type: "image", data: "abc", mimeType: "image/png" };
		const messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: "password: long-enough-secret" },
					image,
				],
				timestamp: 1,
			},
		];

		const projected = projectMessages(messages, store, "test.messages");

		assert.equal(projected.maskCount, 1);
		const content = projected.value[0].content as Array<{ type: string; text?: string }>;
		assert.match(content[0].text ?? "", /\[secret_ref id=psm_mask_[a-f0-9]{24}/);
		assert.equal(content[1], image);
	});
});

test("injectSecretReferences replaces references at tool boundary and redacts outputs", () => {
	withStore((store) => {
		const projected = projectText("TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456", "test.inject", store);
		const id = projected.value.match(/psm_mask_[a-f0-9]{24}/)?.[0];
		assert.ok(id);

		const input = { command: `curl -H 'Authorization: Bearer \${secret:${id}}' https://example.test` };
		const injected = injectSecretReferences(input, store);
		assert.equal(injected.secrets.length, 1);
		assert.match(injected.value.command, /ghp_abcdefghijklmnopqrstuvwxyz123456/);

		const redacted = redactInjectedSecrets({ output: injected.value.command }, injected.secrets);
		assert.doesNotMatch(redacted.output, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
		assert.match(redacted.output, new RegExp(`\\[secret_ref id=${id} redacted\\]`));
	});
});

test("replaceRecordContents mutates tool input objects in place", () => {
	const target = { command: "old", keep: true } as Record<string, unknown>;
	replaceRecordContents(target, { command: "new" });
	assert.deepEqual(target, { command: "new" });
});
