export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Keep Telegram HTML body under ~3900 chars after escaping. */
export function clipPlainForTelegram(plain: string, max = 3800): string {
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max)}\n…`;
}
