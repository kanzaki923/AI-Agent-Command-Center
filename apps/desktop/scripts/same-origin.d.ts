export function isSameOriginRequest(req: {
  headers: Record<string, string | string[] | undefined>;
}): boolean;
