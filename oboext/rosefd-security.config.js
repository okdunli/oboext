import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "src", "server")
  .replace(/\\/g, "/");

const SCRIPT_HOSTS = [
  "https://giscus.app",
  "https://utteranc.es", 
  "https://cdn.jsdelivr.net",
  "https://*.disqus.com",
  "https://*.disquscdn.com",
  "https://cdnjs.cloudflare.com",
  "https://cdn.tailwindcss.com"
];

const CSP_COMMON = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'", 
  "style-src 'self' 'unsafe-inline'", 
  "img-src 'self' data: https: https://picsum.photos https://fastly.picsum.photos https://www.gravatar.com https://cn.gravatar.com https://cravatar.cn https://weavatar.com https://seccdn.libravatar.org https://q1.qlogo.cn https://*.disquscdn.com",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://giscus.app https://*.disqus.com",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob: data:",
  "child-src 'self'",
  "upgrade-insecure-requests"
].join("; ");

const securityHeaders = {
  "Content-Security-Policy": (admin) => {
    const scriptSrc = admin 
      ? `'self'`
      : `'self' 'unsafe-inline' 'unsafe-eval' ${SCRIPT_HOSTS.join(' ')}`;
    return `${CSP_COMMON}; script-src ${scriptSrc}`;
  },
  
  // HSTS
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  
  // X-Content-Type-Options
  "X-Content-Type-Options": "nosniff",
  
  // X-Frame-Options
  "X-Frame-Options": "DENY",
  
  // X-XSS-Protection
  "X-XSS-Protection": "1; mode=block",
  
  // Referrer-Policy
  "Referrer-Policy": "strict-origin-when-cross-origin",
  
  // Permissions-Policy
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=()",
  
  // Cache-Control
  "Cache-Control": "public, max-age=0, must-revalidate",
  
  "Clear-Site-Data": '"cache", "cookies", "storage"'
};

const generateSecurityHeaders = (admin) => {
  const headers = {};
  
  Object.entries(securityHeaders).forEach(([key, value]) => {
    if (typeof value === 'function') {
      headers[key] = value(admin);
    } else {
      headers[key] = value;
    }
  });
  
  return headers;
};

const CSP_REPORT_ENDPOINT = "/api/security/csp-report";

const PREAMBLE = `
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function __rvQs() {
  return typeof window !== "undefined"
    ? new URLSearchParams(window.location.search)
    : getContext().query || new URLSearchParams();
}
function __rvLoad(key, payload) {
  return typeof window !== "undefined"
    ? fetch(
        "/api/data?r=" + encodeURIComponent(key) + "&d=" + encodeURIComponent(JSON.stringify(payload || {})),
        {
          headers: {
            accept: "application/json",
            "x-rv-url": window.location.pathname + window.location.search,
          },
        }
      ).then((r) => {
        if (!r.ok) throw new Error("load " + key + " failed: " + r.status);
        return r.json();
      })
    : globalThis.__oboeLoaders.dispatch(key, payload, getContext());
}

function reportCSPViolation(violation) {
  if (navigator.sendBeacon) {
    const reportData = {
      documentURL: location.href,
      referrer: document.referrer,
      violation: violation
    };
    navigator.sendBeacon('/api/security/csp-report', JSON.stringify(reportData));
  }
}
`;

function isServerOnly(filePath) {
  const p = filePath.replace(/\\/g, "/");
  return p.includes("/pages/api/") || p.includes("/pages/_middleware.rose");
}

function isAdminPage(filePath) {
  const p = filePath.replace(/\\/g, "/");
  return p.includes("/pages/admin/");
}

export default [
  {
    name: "oboext-security",
    transform(code, filePath) {
      code = code.replace(/@server\/([a-z-]+)/g, (_, name) => `${SERVER_DIR}/${name}.js`);

      if (isServerOnly(filePath)) return code;

      const m = code.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
      if (!m) return code;

      const body = m[1];
      const admin = isAdminPage(filePath);
      const securityHeaders = generateSecurityHeaders(admin);
      
      const cspScript = `
        window.addEventListener('securitypolicyviolation', function(e) {
          reportCSPViolation({
            violatedDirective: e.violatedDirective,
            originalPolicy: e.originalPolicy,
            sourceFile: e.sourceFile,
            lineNumber: e.lineNumber,
            columnNumber: e.columnNumber,
            status: e.status
          });
        });
      `;

      const injected = `${PREAMBLE}\n${cspScript}\n${body}`;
      return code.slice(0, m.index) + code.slice(m.index).replace(m[0], `<script>${injected}</script>`);
    },
  },
];

export { securityHeaders, generateSecurityHeaders, CSP_REPORT_ENDPOINT };