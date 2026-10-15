/**
 * 改进的CSP配置
 * 
 * 主要改进：
 * 1. 移除不必要的'unsafe-inline'
 * 2. 添加更严格的安全策略
 * 3. 支持HSTS
 * 4. 添加X-Content-Type-Options
 * 5. 添加X-Frame-Options
 * 6. 添加Referrer-Policy
 * 7. 添加Permissions-Policy
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const SERVER_DIR = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), "src", "server")
  .replace(/\\/g, "/");

// 改进的CSP配置
const SCRIPT_HOSTS = [
  "https://giscus.app",
  "https://utteranc.es", 
  "https://cdn.jsdelivr.net",
  "https://*.disqus.com",
  "https://*.disquscdn.com",
  "https://cdnjs.cloudflare.com",
  "https://cdn.tailwindcss.com"
];

// 更严格的CSP配置
const CSP_COMMON = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // 保留必要的'unsafe-inline'用于插件
  "style-src 'self' 'unsafe-inline'", // 保留必要的'unsafe-inline'用于样式
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

// 增强的安全头
const securityHeaders = {
  // CSP配置
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
  
  // 清除敏感信息
  "Clear-Site-Data": '"cache", "cookies", "storage"'
};

// 生成安全头
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

// 添加CSP报告端点
const CSP_REPORT_ENDPOINT = "/api/security/csp-report";

// 改进的预处理器代码
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

// CSP违规报告
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

// 检查是否为服务器端文件
function isServerOnly(filePath) {
  const p = filePath.replace(/\\/g, "/");
  return p.includes("/pages/api/") || p.includes("/pages/_middleware.rose");
}

// 检查是否为管理页面
function isAdminPage(filePath) {
  const p = filePath.replace(/\\/g, "/");
  return p.includes("/pages/admin/");
}

export default [
  {
    name: "oboext-security",
    transform(code, filePath) {
      // @server/* -> 绝对源路径（仅服务器模块）
      code = code.replace(/@server\/([a-z0-9-]+)/g, (_, name) => `${SERVER_DIR}/${name}.js`);

      if (isServerOnly(filePath)) return code;

      // 仅处理页面和布局组件
      const m = code.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
      if (!m) return code;

      const body = m[1];
      const admin = isAdminPage(filePath);
      const securityHeaders = generateSecurityHeaders(admin);
      
      // 添加安全报告脚本
      const cspScript = `
        // CSP监控
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

// 导出安全头配置
export { securityHeaders, generateSecurityHeaders, CSP_REPORT_ENDPOINT };