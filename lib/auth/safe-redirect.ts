// Accept only app-relative destinations. URL parsing catches browser
// normalisation (including backslashes) before either client or server redirects.
export function safeRedirectPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return "/";
  try {
    const base = "https://lifeos.invalid";
    const destination = new URL(value, base);
    if (destination.origin !== base) return "/";
    return destination.pathname + destination.search + destination.hash;
  } catch {
    return "/";
  }
}
