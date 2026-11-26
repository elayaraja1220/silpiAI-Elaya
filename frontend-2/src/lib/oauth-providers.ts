// Google and Facebook sign-in: the parts that are plain data (pure: no I/O), shared by the server and the sign-in screen.

export const OAUTH_PROVIDERS = ["google", "facebook"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const isOAuthProvider = (v: unknown): v is OAuthProvider => typeof v === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(v);

export const PROVIDER_LABELS: Record<OAuthProvider, string> = { google: "Google", facebook: "Facebook" };

type Env = Record<string, string | undefined>;

/** The app's id and secret from the environment, or null when either is missing. They are never sent to the browser. */
export function providerCredentials(provider: OAuthProvider, env: Env = process.env): { id: string; secret: string } | null {
  const id = (provider === "google" ? env.SILPI_GOOGLE_CLIENT_ID : env.SILPI_FACEBOOK_APP_ID)?.trim();
  const secret = (provider === "google" ? env.SILPI_GOOGLE_CLIENT_SECRET : env.SILPI_FACEBOOK_APP_SECRET)?.trim();
  return id && secret ? { id, secret } : null;
}

/** The address the provider sends the person back to. It must be listed exactly in the provider's console. */
export const redirectUriFor = (provider: OAuthProvider, base: string): string => `${base.replace(/\/+$/, "")}/api/auth/oauth/${provider}/callback`;

export const GOOGLE_ENDPOINTS = { authorize: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo" } as const;
export const FACEBOOK_VERSION = "v19.0";
export const FACEBOOK_ENDPOINTS = { authorize: `https://www.facebook.com/${FACEBOOK_VERSION}/dialog/oauth`, token: `https://graph.facebook.com/${FACEBOOK_VERSION}/oauth/access_token`, me: `https://graph.facebook.com/${FACEBOOK_VERSION}/me?fields=id,name,email` } as const;

/** The page the person is sent to so they can say yes at the provider. */
export function authorizeUrl(provider: OAuthProvider, p: { clientId: string; redirectUri: string; state: string; challenge?: string }): string {
  const q = new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: "code", state: p.state });
  if (provider === "google") {
    q.set("scope", "openid email profile");
    q.set("prompt", "select_account");
    if (p.challenge) { q.set("code_challenge", p.challenge); q.set("code_challenge_method", "S256"); }
    return `${GOOGLE_ENDPOINTS.authorize}?${q}`;
  }
  q.set("scope", "email,public_profile");
  return `${FACEBOOK_ENDPOINTS.authorize}?${q}`;
}

/** Every reason a social sign-in can fail, in words the person can act on. The address carries only the short code, never text. */
export const OAUTH_ERRORS = {
  "not-configured": "This sign-in method is not set up yet. Use your email instead.",
  denied: "Sign-in was cancelled. You can try again or use your email.",
  state: "That sign-in could not be confirmed (it may have expired). Please try again.",
  failed: "The sign-in did not work. Please try again in a moment.",
  "unverified-email": "Your Google email address is not verified, so it cannot be used to create an account.",
  "no-email": "No email address was shared, and an account needs one. Allow email access, or use your email instead.",
  exists: "An account with this email already exists. Sign in with your password (or reset it), then connect this sign-in method from your account.",
  disabled: "This account is not active.",
  "link-taken": "That account is already connected to a different SILPI AI account.",
} as const;
export type OAuthErrorCode = keyof typeof OAUTH_ERRORS;
export const isOAuthError = (v: unknown): v is OAuthErrorCode => typeof v === "string" && Object.prototype.hasOwnProperty.call(OAUTH_ERRORS, v);
