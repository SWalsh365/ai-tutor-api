// lib/linkAllowlist.js
// Strict URL allowlisting for model output (stateless)

const URL_REGEX =
  /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi; // stops before common trailing punctuation/brackets

function normalizeUrl(u) {
  try {
    // Trim common trailing punctuation that sneaks into prose
    const trimmed = String(u).replace(/[.,;:!?]+$/g, "");
    const url = new URL(trimmed);

    // Normalize: https preferred, remove default ports, drop hash
    url.protocol = "https:";
    url.hash = "";

    // Normalize path: remove trailing slash (except root)
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return null;
  }
}

function buildAllowSet(allowedUrls) {
  const set = new Set();
  for (const u of allowedUrls || []) {
    const n = normalizeUrl(u);
    if (n) set.add(n);
  }
  return set;
}

/**
 * Enforce strict allowlisting:
 * - Keeps ALL non-URL text as-is
 * - Removes any URL not present in allowedUrls
 * - Returns { text, removedUrls[] }
 */
function enforceAllowlistedLinks(text, allowedUrls) {
  const input = String(text ?? "");
  const allowSet = buildAllowSet(allowedUrls);

  const removed = [];
  const out = input.replace(URL_REGEX, (match) => {
    const norm = normalizeUrl(match);
    if (!norm) {
      removed.push(match);
      return ""; // strip malformed
    }
    if (allowSet.has(norm)) return match; // keep original formatting
    removed.push(match);
    return ""; // strip disallowed
  });

  // Cleanup: collapse repeated spaces created by stripping URLs
  const cleaned = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: cleaned, removedUrls: removed };
}

export { enforceAllowlistedLinks };

