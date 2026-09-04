import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createHash, randomBytes } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { mountPasswordAuth } from "./auth.js";

function setup(password = "test-password", persistPath?: string) {
    const app = new Hono();
    const baseUrl = "https://example.com";
    const auth = mountPasswordAuth(app, baseUrl, password, persistPath);
    return { app, baseUrl, auth, validateToken: auth.validateToken };
}

function generatePKCE() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

interface TestClient {
    client_id: string;
    client_secret?: string;
    token_endpoint_auth_method: "client_secret_post" | "none";
}

async function registerClient(
    app: Hono,
    redirectUri = "https://app.example.com/callback",
    tokenEndpointAuthMethod: "client_secret_post" | "none" = "client_secret_post",
): Promise<TestClient> {
    const resp = await app.request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_name: "test",
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: tokenEndpointAuthMethod,
        }),
    });
    assert.equal(resp.status, 201);
    return (await resp.json()) as TestClient;
}

function tokenRequest(params: Record<string, string>, client: TestClient): string {
    return new URLSearchParams({
        ...params,
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
    }).toString();
}

function extractHiddenFields(html: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const re = /name="(\w+)"\s+value="([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        fields[m[1]] = m[2];
    }
    return fields;
}

async function getAuthorizePage(
    app: Hono,
    clientId: string,
    challenge: string,
    redirectUri = "https://app.example.com/callback",
) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "test-state",
        response_type: "code",
    });
    const resp = await app.request(`/oauth/authorize?${params}`);
    const html = await resp.text();
    return { resp, html, fields: extractHiddenFields(html) };
}

async function submitPassword(app: Hono, code: string, csrf: string, password: string) {
    return app.request("/oauth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, csrf, password }).toString(),
    });
}

async function completeOAuthFlow(
    app: Hono,
    password: string,
    tokenEndpointAuthMethod: "client_secret_post" | "none" = "client_secret_post",
) {
    const pkce = generatePKCE();
    const client = await registerClient(app, "https://app.example.com/callback", tokenEndpointAuthMethod);
    const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
    const approveResp = await submitPassword(app, fields.code, fields.csrf, password);
    assert.equal(approveResp.status, 302, "approve should redirect");
    const location = approveResp.headers.get("location")!;
    const authCode = new URL(location).searchParams.get("code")!;

    const tokenResp = await app.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenRequest({
            grant_type: "authorization_code",
            code: authCode,
            code_verifier: pkce.verifier,
            redirect_uri: "https://app.example.com/callback",
        }, client),
    });
    const tokens = (await tokenResp.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
    };
    return { ...tokens, client };
}

// --- Tests ---

describe("OAuth Discovery", () => {
    it("serves protected resource metadata", async () => {
        const { app, baseUrl } = setup();
        const resp = await app.request("/.well-known/oauth-protected-resource");
        const body = (await resp.json()) as any;
        assert.equal(body.resource, baseUrl);
        assert.deepEqual(body.authorization_servers, [baseUrl]);
    });

    it("serves authorization server metadata with S256", async () => {
        const { app, baseUrl } = setup();
        const resp = await app.request("/.well-known/oauth-authorization-server");
        const body = (await resp.json()) as any;
        assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
        assert.deepEqual(body.token_endpoint_auth_methods_supported, ["client_secret_post", "none"]);
        assert.equal(body.token_endpoint, `${baseUrl}/oauth/token`);
        assert.equal(body.registration_endpoint, `${baseUrl}/oauth/register`);
    });
});

describe("Dynamic Client Registration", () => {
    it("returns 201 with client_id and client_secret", async () => {
        const { app } = setup();
        const resp = await app.request("/oauth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_name: "test", redirect_uris: ["https://x.com/cb"] }),
        });
        assert.equal(resp.status, 201);
        const body = (await resp.json()) as any;
        assert.ok(body.client_id);
        assert.ok(body.client_secret);
        assert.deepEqual(body.redirect_uris, ["https://x.com/cb"]);
        assert.equal(body.token_endpoint_auth_method, "client_secret_post");
        assert.equal(body.client_secret_expires_at, 0);
    });

    it("honors token_endpoint_auth_method: none — no client_secret issued", async () => {
        const { app } = setup();
        const resp = await app.request("/oauth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_name: "test",
                redirect_uris: ["https://x.com/cb"],
                token_endpoint_auth_method: "none",
            }),
        });
        assert.equal(resp.status, 201);
        const body = (await resp.json()) as any;
        assert.equal(body.token_endpoint_auth_method, "none");
        assert.equal(body.client_secret, undefined);
    });

    it("rejects an unrecognized token endpoint auth method", async () => {
        const { app } = setup();
        const resp = await app.request("/oauth/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_name: "test",
                redirect_uris: ["https://x.com/cb"],
                token_endpoint_auth_method: "client_secret_basic",
            }),
        });
        assert.equal(resp.status, 400);
        const body = (await resp.json()) as any;
        assert.equal(body.error, "invalid_client_metadata");
    });
});

describe("/oauth/authorize", () => {
    it("rejects unknown client_id", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const params = new URLSearchParams({
            client_id: "unknown",
            redirect_uri: "https://x.com/cb",
            code_challenge: pkce.challenge,
            code_challenge_method: "S256",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
        assert.ok((await resp.text()).includes("Unknown client"));
    });

    it("rejects unregistered redirect_uri", async () => {
        const { app } = setup();
        const client = await registerClient(app, "https://legit.com/cb");
        const pkce = generatePKCE();
        const params = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: "https://evil.com/steal",
            code_challenge: pkce.challenge,
            code_challenge_method: "S256",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
        assert.ok((await resp.text()).includes("Invalid redirect URI"));
    });

    it("rejects missing code_challenge", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const params = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: "https://app.example.com/callback",
            code_challenge_method: "S256",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
        assert.ok((await resp.text()).includes("PKCE"));
    });

    it("rejects code_challenge_method other than S256", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const params = new URLSearchParams({
            client_id: client.client_id,
            redirect_uri: "https://app.example.com/callback",
            code_challenge: "test",
            code_challenge_method: "plain",
        });
        const resp = await app.request(`/oauth/authorize?${params}`);
        assert.equal(resp.status, 400);
    });

    it("returns HTML form with code and csrf fields", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { resp, fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        assert.equal(resp.status, 200);
        assert.ok(fields.code);
        assert.ok(fields.csrf);
    });
});

describe("/oauth/approve — password validation", () => {
    it("rejects invalid code", async () => {
        const { app } = setup();
        const resp = await submitPassword(app, "bad-code", "bad-csrf", "test-password");
        assert.equal(resp.status, 400);
    });

    it("rejects wrong CSRF token", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, "wrong-csrf", "test-password");
        assert.equal(resp.status, 403);
    });

    it("rejects wrong password", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, fields.csrf, "wrong");
        assert.equal(resp.status, 401);
        assert.ok((await resp.text()).includes("Wrong password"));
    });

    it("redirects with code and state on correct password", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        assert.equal(resp.status, 302);
        const location = resp.headers.get("location")!;
        assert.ok(location.includes("code="));
        assert.ok(location.includes("state=test-state"));
    });
});

describe("/oauth/approve — rate limiting", () => {
    it("locks out after 5 failed attempts", async () => {
        const { app } = setup();
        const client = await registerClient(app);
        const pkce = generatePKCE();

        for (let i = 0; i < 5; i++) {
            const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
            const resp = await submitPassword(app, fields.code, fields.csrf, "wrong");
            if (i < 4) {
                assert.equal(resp.status, 401, `attempt ${i + 1} should be 401`);
            } else {
                assert.equal(resp.status, 429, `attempt ${i + 1} should trigger lockout`);
                assert.ok((await resp.text()).includes("Too many attempts"));
            }
        }
    });

    it("resets counters on successful login", async () => {
        const { app } = setup("mypass");
        const client = await registerClient(app);
        const pkce = generatePKCE();

        // Fail 4 times (just under lockout)
        for (let i = 0; i < 4; i++) {
            const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
            await submitPassword(app, fields.code, fields.csrf, "wrong");
        }

        // Succeed
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const resp = await submitPassword(app, fields.code, fields.csrf, "mypass");
        assert.equal(resp.status, 302);

        // Fail 4 more times — should NOT lock out (counter was reset)
        for (let i = 0; i < 4; i++) {
            const { fields: f } = await getAuthorizePage(app, client.client_id, pkce.challenge);
            const r = await submitPassword(app, f.code, f.csrf, "wrong");
            assert.equal(r.status, 401, `post-reset attempt ${i + 1} should be 401, not 429`);
        }
    });
});

describe("Token Exchange", () => {
    it("issues tokens with correct PKCE", async () => {
        const { app } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");
        assert.ok(tokens.access_token);
        assert.ok(tokens.refresh_token);
        assert.equal(tokens.expires_in, 3600);
    });

    it("rejects an authorization code until password approval without consuming it", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);

        const premature = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: fields.code,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(premature.status, 400);
        assert.equal(((await premature.json()) as any).error, "invalid_grant");

        const approved = await submitPassword(app, fields.code, fields.csrf, "test-password");
        assert.equal(approved.status, 302);
        const authCode = new URL(approved.headers.get("location")!).searchParams.get("code")!;
        assert.equal(authCode, fields.code);

        const exchange = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: authCode,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(exchange.status, 200);
    });

    it("keeps a public client's code unexchangeable after a wrong password", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app, "https://app.example.com/callback", "none");
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);

        const rejectedApproval = await submitPassword(app, fields.code, fields.csrf, "wrong-password");
        assert.equal(rejectedApproval.status, 401);
        const rotatedFields = extractHiddenFields(await rejectedApproval.text());

        const premature = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: fields.code,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(premature.status, 400);
        assert.equal(((await premature.json()) as any).error, "invalid_grant");

        const approved = await submitPassword(app, fields.code, rotatedFields.csrf, "test-password");
        assert.equal(approved.status, 302);

        const exchange = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: fields.code,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(exchange.status, 200);
    });

    it("rejects incorrect PKCE verifier", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const location = approveResp.headers.get("location")!;
        const authCode = new URL(location).searchParams.get("code")!;

        const tokenResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: authCode,
                code_verifier: "wrong-verifier",
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(tokenResp.status, 400);
        const body = (await tokenResp.json()) as any;
        assert.equal(body.error, "invalid_grant");

        const validResponse = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: authCode,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(validResponse.status, 200, "failed PKCE attempt must not consume the authorization code");
    });

    it("rejects a missing confidential client secret", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const authCode = new URL(approveResp.headers.get("location")!).searchParams.get("code")!;

        const tokenResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: authCode,
                client_id: client.client_id,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }).toString(),
        });
        assert.equal(tokenResp.status, 400);
        assert.equal(((await tokenResp.json()) as any).error, "invalid_client");
    });

    it("rejects an incorrect confidential client secret", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const authCode = new URL(approveResp.headers.get("location")!).searchParams.get("code")!;

        const tokenResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: authCode,
                client_id: client.client_id,
                client_secret: "0".repeat(64),
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }).toString(),
        });
        assert.equal(tokenResp.status, 400);
        assert.equal(((await tokenResp.json()) as any).error, "invalid_client");
    });

    it("allows a public client to exchange a code without a secret", async () => {
        const { app } = setup();
        const tokens = await completeOAuthFlow(app, "test-password", "none");
        assert.ok(tokens.access_token);
        assert.equal(tokens.client.client_secret, undefined);
    });

    it("rejects a code issued to a different authenticated client", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const otherClient = await registerClient(app, "https://other.example.com/callback");
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const location = approveResp.headers.get("location")!;
        const authCode = new URL(location).searchParams.get("code")!;

        const tokenResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: authCode,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, otherClient),
        });
        assert.equal(tokenResp.status, 400);
        const body = (await tokenResp.json()) as any;
        assert.equal(body.error, "invalid_grant");

        const validResponse = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: authCode,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(validResponse.status, 200, "cross-client attempt must not consume the authorization code");
    });

    it("authorization code is single-use", async () => {
        const { app } = setup();
        const pkce = generatePKCE();
        const client = await registerClient(app);
        const { fields } = await getAuthorizePage(app, client.client_id, pkce.challenge);
        const approveResp = await submitPassword(app, fields.code, fields.csrf, "test-password");
        const location = approveResp.headers.get("location")!;
        const authCode = new URL(location).searchParams.get("code")!;

        // First exchange: success
        const resp1 = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: authCode,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(resp1.status, 200);

        // Second exchange: fail
        const resp2 = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "authorization_code",
                code: authCode,
                code_verifier: pkce.verifier,
                redirect_uri: "https://app.example.com/callback",
            }, client),
        });
        assert.equal(resp2.status, 400);
    });

    it("rejects unsupported grant_type", async () => {
        const { app } = setup();
        const resp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
        });
        assert.equal(resp.status, 400);
    });
});

describe("Token Refresh", () => {
    it("rotates tokens — old ones invalidated", async () => {
        const { app, validateToken } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");

        // Old token works
        assert.ok(validateToken(`Bearer ${tokens.access_token}`));

        // Refresh
        const refreshResp = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
            }, tokens.client),
        });
        assert.equal(refreshResp.status, 200);
        const newTokens = (await refreshResp.json()) as any;
        assert.ok(newTokens.access_token);
        assert.notEqual(newTokens.access_token, tokens.access_token);

        // Old token no longer works
        assert.equal(validateToken(`Bearer ${tokens.access_token}`), false);

        // New token works
        assert.ok(validateToken(`Bearer ${newTokens.access_token}`));

        // Old refresh token no longer works
        const resp2 = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
            }, tokens.client),
        });
        assert.equal(resp2.status, 400);
    });

    it("rejects missing or incorrect confidential client authentication", async () => {
        const { app } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");

        const missingSecret = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
                client_id: tokens.client.client_id,
            }).toString(),
        });
        assert.equal(missingSecret.status, 400);
        assert.equal(((await missingSecret.json()) as any).error, "invalid_client");

        const wrongSecret = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
                client_id: tokens.client.client_id,
                client_secret: "0".repeat(64),
            }).toString(),
        });
        assert.equal(wrongSecret.status, 400);
        assert.equal(((await wrongSecret.json()) as any).error, "invalid_client");
    });

    it("rejects a refresh token issued to a different authenticated client", async () => {
        const { app } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");
        const otherClient = await registerClient(app, "https://other.example.com/callback");

        const response = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
            }, otherClient),
        });
        assert.equal(response.status, 400);
        assert.equal(((await response.json()) as any).error, "invalid_grant");

        const validResponse = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
            }, tokens.client),
        });
        assert.equal(validResponse.status, 200, "cross-client attempt must not consume the refresh token");
    });

    it("allows a public client to refresh without a secret", async () => {
        const { app } = setup();
        const tokens = await completeOAuthFlow(app, "test-password", "none");

        const response = await app.request("/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenRequest({
                grant_type: "refresh_token",
                refresh_token: tokens.refresh_token,
            }, tokens.client),
        });
        assert.equal(response.status, 200);
    });

    it("enforces confidential client authentication after legacy state reload", async () => {
        const directory = await mkdtemp(join(tmpdir(), "obsidian-sync-mcp-auth-"));
        const persistPath = join(directory, "auth.json");

        try {
            const first = setup("test-password", persistPath);
            const tokens = await completeOAuthFlow(first.app, "test-password");

            // Registrations saved before tokenEndpointAuthMethod was persisted
            // still contain the issued secret. Load them as confidential rather
            // than weakening them to public clients.
            const persisted = JSON.parse(await readFile(persistPath, "utf-8"));
            delete persisted.clients[tokens.client.client_id].tokenEndpointAuthMethod;
            await writeFile(persistPath, JSON.stringify(persisted), "utf-8");

            const second = setup("test-password", persistPath);
            assert.equal(await second.auth.loadTokens(), true);

            const missingSecret = await second.app.request("/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: tokens.refresh_token,
                    client_id: tokens.client.client_id,
                }).toString(),
            });
            assert.equal(missingSecret.status, 400);

            const valid = await second.app.request("/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: tokenRequest({
                    grant_type: "refresh_token",
                    refresh_token: tokens.refresh_token,
                }, tokens.client),
            });
            assert.equal(valid.status, 200);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("invalidates pre-fix tokens while retaining their client registration", async () => {
        const directory = await mkdtemp(join(tmpdir(), "obsidian-sync-mcp-auth-"));
        const persistPath = join(directory, "auth.json");

        try {
            const first = setup("test-password", persistPath);
            const tokens = await completeOAuthFlow(first.app, "test-password");

            const persisted = JSON.parse(await readFile(persistPath, "utf-8"));
            delete persisted.version;
            await writeFile(persistPath, JSON.stringify(persisted), "utf-8");

            const second = setup("test-password", persistPath);
            assert.equal(await second.auth.loadTokens(), false);
            assert.equal(second.validateToken(`Bearer ${tokens.access_token}`), false);

            const oldRefresh = await second.app.request("/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: tokenRequest({
                    grant_type: "refresh_token",
                    refresh_token: tokens.refresh_token,
                }, tokens.client),
            });
            assert.equal(oldRefresh.status, 400);
            assert.equal(((await oldRefresh.json()) as any).error, "invalid_grant");

            const pkce = generatePKCE();
            const { fields } = await getAuthorizePage(second.app, tokens.client.client_id, pkce.challenge);
            const approved = await submitPassword(second.app, fields.code, fields.csrf, "test-password");
            assert.equal(approved.status, 302, "retained client should be able to reauthorize");

            const exchange = await second.app.request("/oauth/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: tokenRequest({
                    grant_type: "authorization_code",
                    code: fields.code,
                    code_verifier: pkce.verifier,
                    redirect_uri: "https://app.example.com/callback",
                }, tokens.client),
            });
            assert.equal(exchange.status, 200);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe("validateToken", () => {
    it("returns false for undefined", () => {
        const { validateToken } = setup();
        assert.equal(validateToken(undefined), false);
    });

    it("returns false for non-Bearer header", () => {
        const { validateToken } = setup();
        assert.equal(validateToken("Basic abc"), false);
    });

    it("returns false for unknown token", () => {
        const { validateToken } = setup();
        assert.equal(validateToken("Bearer bad-token"), false);
    });

    it("returns true for valid token from OAuth flow", async () => {
        const { app, validateToken } = setup();
        const tokens = await completeOAuthFlow(app, "test-password");
        assert.ok(validateToken(`Bearer ${tokens.access_token}`));
    });
});
