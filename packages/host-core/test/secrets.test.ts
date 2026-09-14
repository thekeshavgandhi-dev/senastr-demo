import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY_FILE, SecretBox, isEncryptedValue } from "../src/secrets";
import { ProviderStore } from "../src/providers";
import { McpService } from "../src/mcp";

const dir = () => mkdtempSync(join(tmpdir(), "senastr-secrets-"));

afterEach(() => {
  delete process.env.SENASTR_SECRET_KEY;
});

describe("SecretBox", () => {
  it("round-trips a value and never stores it in clear text", () => {
    const box = new SecretBox(dir());
    const encrypted = box.encrypt("sk-live-abcdef123456");
    expect(isEncryptedValue(encrypted)).toBe(true);
    expect(encrypted).not.toContain("sk-live");
    expect(box.decrypt(encrypted)).toBe("sk-live-abcdef123456");
  });

  it("is idempotent and passes legacy plaintext through", () => {
    const box = new SecretBox(dir());
    const once = box.encrypt("value");
    expect(box.encrypt(once)).toBe(once);
    expect(box.decrypt("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const box = new SecretBox(dir());
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));
  });

  it("writes a 0600 key file that persists across instances", () => {
    const dataDir = dir();
    const box = new SecretBox(dataDir);
    const encrypted = box.encrypt("durable");
    const mode = statSync(join(dataDir, KEY_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
    // A second instance (same host) reads the same key file.
    delete process.env.SENASTR_SECRET_KEY;
    const reopened = new SecretBox(dataDir);
    expect(reopened.decrypt(encrypted)).toBe("durable");
  });

  it("honours an injected key (SENASTR_SECRET_KEY) in preference to the file", () => {
    const dataDir = dir();
    process.env.SENASTR_SECRET_KEY = Buffer.from("injected-key-material").toString("base64");
    const injected = new SecretBox(dataDir);
    const encrypted = injected.encrypt("payload");
    delete process.env.SENASTR_SECRET_KEY;
    // A box without the injected key cannot decrypt it.
    const fileBacked = new SecretBox(dataDir);
    expect(() => fileBacked.decrypt(encrypted)).toThrow();
  });

  it("rejects a tampered ciphertext (authenticated encryption)", () => {
    const box = new SecretBox(dir());
    const encrypted = box.encrypt("authentic");
    const tampered = `${encrypted.slice(0, -4)}AAAA`;
    expect(() => box.decrypt(tampered)).toThrow();
  });
});

describe("ProviderStore credential protection", () => {
  it("stores API keys encrypted and still serves them to the host", async () => {
    const dataDir = dir();
    const store = new ProviderStore(dataDir);
    store.set({
      id: "openai",
      kind: "openai",
      label: "OpenAI",
      apiKeys: ["sk-secret-one", "sk-secret-two"],
      headers: { "x-org": "org-secret" },
      models: ["gpt-5"],
    });

    await store.flush();
    const onDisk = readFileSync(join(dataDir, "providers.json"), "utf8");
    expect(onDisk).not.toContain("sk-secret-one");
    expect(onDisk).not.toContain("sk-secret-two");
    expect(onDisk).not.toContain("org-secret");
    expect(onDisk).toContain("enc:v1:");

    const loaded = new ProviderStore(dataDir).get("openai");
    expect(loaded.apiKeys).toEqual(["sk-secret-one", "sk-secret-two"]);
    expect(loaded.headers?.["x-org"]).toBe("org-secret");
  });

  it("keeps the renderer view masked", () => {
    const dataDir = dir();
    const store = new ProviderStore(dataDir);
    store.set({ id: "openai", kind: "openai", label: "OpenAI", apiKey: "sk-secret", models: ["m"] });
    const summary = store.list()[0];
    expect(summary.hasApiKey).toBe(true);
    expect(summary.apiKeyCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("sk-secret");
  });

  it("still resolves the mask round-trip on edit", async () => {
    const dataDir = dir();
    const store = new ProviderStore(dataDir);
    store.set({ id: "openai", kind: "openai", label: "OpenAI", apiKeys: ["stored-key-one", "k2"], models: ["m"] });
    store.set({ id: "openai", kind: "openai", label: "Renamed", apiKeys: ["••••••", "k3"], models: ["m"] });
    const loaded = store.get("openai");
    expect(loaded.apiKeys).toEqual(["stored-key-one", "k3"]);
    await store.flush();
    const onDisk = readFileSync(join(dataDir, "providers.json"), "utf8");
    expect(onDisk).not.toContain("stored-key-one");
  });

  it("migrates plaintext credentials written by an older build", async () => {
    const dataDir = dir();
    writeFileSync(
      join(dataDir, "providers.json"),
      JSON.stringify([
        {
          id: "legacy",
          kind: "openai",
          label: "legacy",
          apiKey: "sk-legacy-plaintext",
          apiKeys: ["sk-legacy-plaintext"],
          models: ["m"],
        },
      ]),
    );
    const store = new ProviderStore(dataDir);
    expect(store.get("legacy").apiKey).toBe("sk-legacy-plaintext");
    await store.flush();
    const onDisk = readFileSync(join(dataDir, "providers.json"), "utf8");
    expect(onDisk).not.toContain("sk-legacy-plaintext");
    expect(onDisk).toContain("enc:v1:");
  });
});

describe("McpService credential protection", () => {
  it("encrypts env and header values at rest while still spawning with them", async () => {
    const dataDir = dir();
    const mcp = new McpService(dataDir);
    mcp.set({
      id: "github",
      label: "GitHub",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp",
      headers: { authorization: "Bearer gh-secret-token" },
    });
    await mcp.flush();
    const onDisk = readFileSync(join(dataDir, "mcp-servers.json"), "utf8");
    expect(onDisk).not.toContain("gh-secret-token");
    expect(onDisk).toContain("enc:v1:");
    const loaded = new McpService(dataDir).get("github");
    expect(loaded.headers?.authorization).toBe("Bearer gh-secret-token");
    // Renderer view masks values even though they are decrypted internally.
    expect(JSON.stringify(mcp.list()[0])).not.toContain("gh-secret-token");
  });

  it("migrates a plaintext env map", async () => {
    const dataDir = dir();
    writeFileSync(
      join(dataDir, "mcp-servers.json"),
      JSON.stringify([
        {
          id: "legacy",
          label: "legacy",
          transport: "stdio",
          command: "node",
          env: { API_TOKEN: "tok-legacy" },
          enabled: true,
          level: "global",
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    );
    const mcp = new McpService(dataDir);
    expect(mcp.get("legacy").env?.API_TOKEN).toBe("tok-legacy");
    await mcp.flush();
    expect(readFileSync(join(dataDir, "mcp-servers.json"), "utf8")).not.toContain("tok-legacy");
  });

  it("keeps the secret mask working on edit", () => {
    const dataDir = dir();
    const mcp = new McpService(dataDir);
    mcp.set({
      id: "srv",
      label: "srv",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { authorization: "Bearer keep-me" },
    });
    mcp.set({
      id: "srv",
      label: "srv renamed",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { authorization: "••••••" },
    });
    expect(mcp.get("srv").headers?.authorization).toBe("Bearer keep-me");
  });
});
