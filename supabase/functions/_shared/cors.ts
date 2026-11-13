export type CorsSettings = {
  allowedOrigins?: string;
  allowLocalhost?: boolean;
  vercelPreviewProject?: string;
  vercelPreviewTeam?: string;
};

const defaultProductionOrigins = ["https://mylvl-chi.vercel.app"];
const localhostNames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function validOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.origin !== value.trim() || parsed.username || parsed.password) return null;
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localhostNames.has(parsed.hostname))) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function configuredOrigins(settings: CorsSettings): Set<string> {
  const configured = settings.allowedOrigins?.split(",").map(validOrigin).filter(
    (value): value is string => value !== null,
  ) ?? [];
  return new Set([...defaultProductionOrigins, ...configured]);
}

function authorizedVercelPreview(origin: string, settings: CorsSettings): boolean {
  const project = settings.vercelPreviewProject?.trim().toLowerCase();
  const team = settings.vercelPreviewTeam?.trim().toLowerCase();
  if (!project || !team || !/^[a-z0-9-]+$/.test(project) || !/^[a-z0-9-]+$/.test(team)) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.origin !== origin) return false;
    const host = parsed.hostname;
    const prefix = `${project}-`;
    const suffix = `-${team}.vercel.app`;
    if (!host.startsWith(prefix) || !host.endsWith(suffix)) return false;
    const deploymentLabel = host.slice(prefix.length, -suffix.length);
    return deploymentLabel.length > 0 && /^[a-z0-9-]+$/.test(deploymentLabel);
  } catch {
    return false;
  }
}

export function isOriginAllowed(origin: string | null, settings: CorsSettings = {}): boolean {
  // Non-browser callers have no Origin; the handler still requires a valid JWT.
  if (origin === null) return true;
  if (validOrigin(origin) !== origin) return false;
  if (configuredOrigins(settings).has(origin)) return true;
  try {
    if (settings.allowLocalhost && localhostNames.has(new URL(origin).hostname)) return true;
  } catch {
    return false;
  }
  return authorizedVercelPreview(origin, settings);
}

export function corsHeaders(origin: string | null, settings: CorsSettings = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && isOriginAllowed(origin, settings)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

