import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, type webcrypto } from 'node:crypto';
import { type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatGptCredentials, ChatGptStatus } from '@acc/protocol';
import type { Logger } from '../core/log';

/** Where the OSS flow of "Sign in with ChatGPT" lives (developers.openai.com/siwc). */
export const CHATGPT_AUTH_BASE = 'https://auth.openai.com';
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
/** The client id of a first sign-in; OpenAI issues one for this host and hands it back. */
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/** Granted scopes a plan token needs. */
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', PLAN_SCOPE];
/** Only the port may vary between sign-ins; host and path are fixed by the registration. */
const CALLBACK_PATH = '/auth/callback';
/** The browser side has this long. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** Refresh an access token this close to its expiry. */
const REFRESH_MARGIN_MS = 60_000;

export interface ChatGptStore {
  get(): ChatGptCredentials | null;
  set(credentials: ChatGptCredentials | null): void;
  /** A stable opaque id of this host (`urn:uuid:…`), created on first use. */
  hostId(): string;
}

export interface ChatGptAuthOptions {
  store: ChatGptStore;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
  /** Defaults to the public endpoints; tests point them at a fake. */
  authBase?: string;
  resource?: string;
  agentName?: string;
  /** How the authorization URL reaches a browser (default: the OS's opener). */
  openBrowser?: (url: string) => void;
  /** Called after the stored credentials changed (sign-in, refresh, sign-out). */
  onChange?: () => void;
  timeoutMs?: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Open a URL with the OS (never throws; the UI opens it too). */
function openWithOs(url: string): void {
  try {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is also shown in the UI.
  }
}

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * "Sign in with ChatGPT" for an open-source local app (developers.openai.com/siwc,
 * token-sharing-open-source): OpenID Connect with PKCE on a loopback callback, a dynamically
 * registered client id that this host keeps, a rotating refresh token (30 days), one-hour
 * access tokens refreshed near expiry, and revocation on sign-out. The access token is used
 * by the OpenAI Responses provider for the plan's quota instead of API billing. Secrets live
 * in config.json through `store`; they never reach clients or logs.
 */
export class ChatGptAuth {
  private pending: Pending | null = null;
  private lastError: string | null = null;
  private refreshing: Promise<string | null> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ChatGptAuthOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private get authBase(): string {
    return (this.opts.authBase ?? CHATGPT_AUTH_BASE).replace(/\/+$/, '');
  }

  private get resource(): string {
    return this.opts.resource ?? CHATGPT_RESOURCE;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  status(): ChatGptStatus {
    const creds = this.opts.store.get();
    if (this.pending) return { state: 'waiting', email: creds?.email ?? null, error: null };
    if (creds) return { state: 'signed_in', email: creds.email, error: null };
    return { state: this.lastError ? 'error' : 'signed_out', email: null, error: this.lastError };
  }

  /** Start a sign-in: a loopback listener, the browser, and the wait for the callback. */
  async signIn(): Promise<{ url: string }> {
    this.cancelPending();
    this.lastError = null;
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    const existing = this.opts.store.get();
    const clientId = existing?.clientId ?? DYNAMIC_CLIENT_ID;
    const server = createServer((req, res) => void this.onCallback(req.url ?? '/', res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const params = new URLSearchParams({
      client_id: clientId,
      ext_agent_host_id: this.opts.store.hostId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      resource: this.resource,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (clientId === DYNAMIC_CLIENT_ID) {
      params.set('agent_name_hint', this.opts.agentName ?? 'AI Agent Command Center');
    } else if (existing?.email) {
      params.set('login_hint', existing.email);
    }
    const url = `${this.authBase}/api/accounts/authorize?${params.toString()}`;
    const timer = setTimeout(() => {
      this.fail('時間切れです。もう一度サインインしてください');
    }, this.opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    this.pending = { state, nonce, verifier, redirectUri, clientId, server, timer };
    (this.opts.openBrowser ?? openWithOs)(url);
    return { url };
  }

  /** The loopback callback: the browser lands here with the code. */
  private async onCallback(rawUrl: string, res: ServerResponse): Promise<void> {
    const reply = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>AI Agent Command Center</title><body style="font-family:sans-serif;padding:40px"><p>${text}</p></body>`,
      );
    };
    const url = new URL(rawUrl, 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH) {
      reply(404, 'Not found');
      return;
    }
    const p = this.pending;
    if (!p || url.searchParams.get('state') !== p.state) {
      reply(400, 'このサインインは有効ではありません。アプリからやり直してください。');
      return;
    }
    if (url.searchParams.get('error')) {
      reply(200, 'サインインを取り消しました。この画面は閉じてください。');
      this.fail('サインインが取り消されました');
      return;
    }
    const code = url.searchParams.get('code');
    const issued = url.searchParams.get('client_id');
    if (!code) {
      reply(400, 'コードがありません。');
      this.fail('認可コードが届きませんでした');
      return;
    }
    if (issued && p.clientId !== DYNAMIC_CLIENT_ID && issued !== p.clientId) {
      reply(400, 'クライアント ID が一致しません。');
      this.fail('クライアント ID が一致しません');
      return;
    }
    const clientId = p.clientId === DYNAMIC_CLIENT_ID ? issued : p.clientId;
    if (!clientId) {
      reply(400, 'クライアント ID が届きませんでした。');
      this.fail('クライアント ID が届きませんでした');
      return;
    }
    try {
      const tokens = await this.token({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: p.verifier,
        redirect_uri: p.redirectUri,
        resource: this.resource,
      });
      const scopes = (tokens.scope ?? '').split(/\s+/);
      if (!scopes.includes(PLAN_SCOPE)) {
        throw new Error(
          'ChatGPT の利用枠を使う許可（chatgpt.tokens.use.direct）が与えられませんでした',
        );
      }
      const claims = await this.verifyIdToken(tokens.id_token, clientId, p.nonce);
      this.opts.store.set({
        clientId,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: new Date(this.now() + tokens.expires_in * 1000).toISOString(),
        email: typeof claims.email === 'string' ? claims.email : null,
        sub: typeof claims.sub === 'string' ? claims.sub : null,
      });
      this.cancelPending();
      this.lastError = null;
      this.opts.onChange?.();
      reply(200, 'サインインしました。この画面は閉じて、アプリに戻ってください。');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.log.warn('chatgpt sign-in failed', { error: message });
      reply(500, 'サインインに失敗しました。アプリに戻って確かめてください。');
      this.fail(message);
    }
  }

  private fail(message: string): void {
    this.cancelPending();
    this.lastError = message;
  }

  private cancelPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.server.close();
  }

  private async token(form: Record<string, string>): Promise<{
    access_token: string;
    refresh_token: string;
    id_token: string;
    expires_in: number;
    scope?: string;
  }> {
    const res = await this.fetchImpl(`${this.authBase}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const code = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      throw new TokenError(code);
    }
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
      throw new Error('トークンの応答にアクセストークンがありません');
    }
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      id_token: typeof body.id_token === 'string' ? body.id_token : '',
      expires_in: typeof body.expires_in === 'number' ? body.expires_in : 3600,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    };
  }

  /**
   * Validate the ID token (issuer, audience, nonce, expiry, signature against the published
   * JWKS) and return its claims.
   */
  private async verifyIdToken(
    idToken: string,
    clientId: string,
    nonce: string,
  ): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('ID トークンの形式が正しくありません');
    const header = decodeJwtPart(parts[0]!);
    const claims = decodeJwtPart(parts[1]!);
    if (claims.iss !== this.authBase) throw new Error('ID トークンの発行者が違います');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new Error('ID トークンの宛先が違います');
    if (claims.nonce !== nonce) throw new Error('ID トークンの nonce が違います');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < this.now()) {
      throw new Error('ID トークンの期限が切れています');
    }
    const config = await this.openIdConfig();
    const jwksRes = await this.fetchImpl(config.jwks_uri);
    if (!jwksRes.ok) throw new Error('署名鍵を取得できませんでした');
    const jwks = (await jwksRes.json()) as {
      keys?: (webcrypto.JsonWebKey & { kid?: string; alg?: string })[];
    };
    const key = (jwks.keys ?? []).find((k) => !header.kid || k.kid === header.kid);
    if (!key) throw new Error('ID トークンの署名鍵が見つかりません');
    const alg = typeof header.alg === 'string' ? header.alg : (key.alg ?? 'RS256');
    const algorithm =
      alg === 'ES256'
        ? ({ name: 'ECDSA', namedCurve: 'P-256' } as const)
        : ({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const);
    const cryptoKey = await globalThis.crypto.subtle.importKey('jwk', key, algorithm, false, [
      'verify',
    ]);
    const ok = await globalThis.crypto.subtle.verify(
      alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5',
      cryptoKey,
      Buffer.from(parts[2]!, 'base64url'),
      Buffer.from(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) throw new Error('ID トークンの署名が正しくありません');
    return claims;
  }

  private async openIdConfig(): Promise<{ jwks_uri: string; revocation_endpoint?: string }> {
    const res = await this.fetchImpl(`${this.authBase}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error('OpenID の設定を取得できませんでした');
    const body = (await res.json()) as { jwks_uri?: unknown; revocation_endpoint?: unknown };
    if (typeof body.jwks_uri !== 'string') throw new Error('OpenID の設定に jwks_uri がありません');
    return {
      jwks_uri: body.jwks_uri,
      ...(typeof body.revocation_endpoint === 'string'
        ? { revocation_endpoint: body.revocation_endpoint }
        : {}),
    };
  }

  /** A valid access token, refreshed near expiry; null when not signed in. */
  accessToken(): Promise<string | null> {
    const creds = this.opts.store.get();
    if (!creds) return Promise.resolve(null);
    const expiresAt = creds.expiresAt ? Date.parse(creds.expiresAt) : 0;
    if (creds.accessToken && expiresAt - REFRESH_MARGIN_MS > this.now()) {
      return Promise.resolve(creds.accessToken);
    }
    // One refresh at a time: refresh tokens rotate, a second concurrent refresh would be reused.
    this.refreshing ??= this.refresh(creds).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(creds: ChatGptCredentials): Promise<string | null> {
    try {
      const tokens = await this.token({
        grant_type: 'refresh_token',
        client_id: creds.clientId,
        refresh_token: creds.refreshToken,
        resource: this.resource,
      });
      this.opts.store.set({
        ...creds,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: new Date(this.now() + tokens.expires_in * 1000).toISOString(),
      });
      this.opts.onChange?.();
      return tokens.access_token;
    } catch (err) {
      const code = err instanceof TokenError ? err.code : null;
      if (code && REAUTH_CODES.has(code)) {
        // The grant is gone: forget the tokens, keep the client id for the next sign-in.
        this.opts.log.warn('chatgpt refresh refused; signed out', { code });
        this.opts.store.set(null);
        this.lastError = 'ChatGPT のサインインが切れました。設定からサインインし直してください';
        this.opts.onChange?.();
        return null;
      }
      this.opts.log.warn('chatgpt refresh failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      // A passing failure: use the old token if it is still valid, else report nothing.
      const expiresAt = creds.expiresAt ? Date.parse(creds.expiresAt) : 0;
      return creds.accessToken && expiresAt > this.now() ? creds.accessToken : null;
    }
  }

  /** Revoke the refresh token (best effort) and forget the credentials. */
  async signOut(): Promise<void> {
    this.cancelPending();
    const creds = this.opts.store.get();
    this.opts.store.set(null);
    this.lastError = null;
    this.opts.onChange?.();
    if (!creds) return;
    try {
      const config = await this.openIdConfig();
      if (!config.revocation_endpoint) return;
      await this.fetchImpl(config.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: creds.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: creds.clientId,
        }).toString(),
      });
    } catch (err) {
      this.opts.log.warn('chatgpt revocation not confirmed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  close(): void {
    this.cancelPending();
  }
}

/** Refresh answers after which only a new sign-in helps (errors and recovery). */
const REAUTH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

class TokenError extends Error {
  constructor(readonly code: string) {
    super(`token endpoint: ${code}`);
    this.name = 'TokenError';
  }
}

/** A fresh host id for ChatGPT registration. */
export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}
