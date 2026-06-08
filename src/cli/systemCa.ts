import { readFileSync, existsSync } from "node:fs";
import * as nodeTls from "node:tls";

// `tls.setDefaultCACertificates` only exists on Node >= 22.15. Access it through
// the namespace (not a named import) so that on older Node it is `undefined` and
// handled by the runtime guard below — a static named import of a missing export
// is an ESM SyntaxError that would crash the whole CLI at load.
const { rootCertificates } = nodeTls;
const setDefaultCACertificates = nodeTls.setDefaultCACertificates;

const CANDIDATE_BUNDLES = [
  "/etc/ssl/cert.pem",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
];

function parsePemBundle(pem: string): string[] {
  const certs: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem)) !== null) certs.push(m[0]);
  return certs;
}

/**
 * Node trusts only its bundled CA list by default. On corporate networks that
 * use TLS-inspecting proxies (Zscaler, ZTNA appliances), the proxy injects its
 * own root cert into the OS keychain, which Node ignores. Loading the system
 * bundle once at startup makes the scraper actually usable on those networks.
 */
export function installSystemCas(): { added: number; source: string | null } {
  if (typeof setDefaultCACertificates !== "function") {
    return { added: 0, source: null };
  }
  const extraEnv = process.env["NODE_EXTRA_CA_CERTS"];
  const sources: { path: string; certs: string[] }[] = [];
  for (const path of CANDIDATE_BUNDLES) {
    if (!existsSync(path)) continue;
    try {
      const certs = parsePemBundle(readFileSync(path, "utf8"));
      if (certs.length > 0) sources.push({ path, certs });
    } catch {
      // ignore unreadable bundles
    }
  }
  if (extraEnv && existsSync(extraEnv)) {
    try {
      const certs = parsePemBundle(readFileSync(extraEnv, "utf8"));
      if (certs.length > 0) sources.push({ path: extraEnv, certs });
    } catch {
      // ignore
    }
  }
  const all = new Set<string>(rootCertificates);
  for (const s of sources) for (const c of s.certs) all.add(c);
  if (all.size === rootCertificates.length) return { added: 0, source: null };
  setDefaultCACertificates([...all]);
  return {
    added: all.size - rootCertificates.length,
    source: sources.map(s => s.path).join(","),
  };
}
