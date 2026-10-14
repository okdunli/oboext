#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = join(ROOT, 'performance-reports');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

if (!existsSync(REPORT_DIR)) {
  mkdirSync(REPORT_DIR, { recursive: true });
}

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      pageLoadTimes: [],
      dbQueryTimes: [],
      memoryUsage: [],
      networkRequests: [],
      renderTimes: []
    };
    this.startTime = Date.now();
  }

  recordPageLoadTime(url, loadTime) {
    this.metrics.pageLoadTimes.push({
      url,
      loadTime,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    });
  }

  recordDbQuery(query, queryTime) {
    this.metrics.dbQueryTimes.push({
      query,
      queryTime,
      timestamp: new Date().toISOString()
    });
  }

  recordMemoryUsage() {
    const memoryUsage = process.memoryUsage();
    this.metrics.memoryUsage.push({
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      timestamp: new Date().toISOString()
    });
  }

  recordNetworkRequest(url, method, duration, status) {
    this.metrics.networkRequests.push({
      url,
      method,
      duration,
      status,
      timestamp: new Date().toISOString()
    });
  }

  recordRenderTime(component, renderTime) {
    this.metrics.renderTimes.push({
      component,
      renderTime,
      timestamp: new Date().toISOString()
    });
  }

  generateReport() {
    const report = {
      timestamp: TIMESTAMP,
      duration: Date.now() - this.startTime,
      summary: this.generateSummary(),
      metrics: this.metrics,
      recommendations: this.generateRecommendations()
    };

    const reportPath = join(REPORT_DIR, `performance-report-${TIMESTAMP}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const htmlReport = this.generateHtmlReport(report);
    const htmlPath = join(REPORT_DIR, `performance-report-${TIMESTAMP}.html`);
    writeFileSync(htmlPath, htmlReport);

    console.log(`Performance report generated: ${reportPath}`);
    console.log(`HTML report generated: ${htmlPath}`);

    return report;
  }

  generateSummary() {
    const summary = {
      totalPageLoads: this.metrics.pageLoadTimes.length,
      avgPageLoadTime: this.calculateAverage(this.metrics.pageLoadTimes.map(p => p.loadTime)),
      totalDbQueries: this.metrics.dbQueryTimes.length,
      avgDbQueryTime: this.calculateAverage(this.metrics.dbQueryTimes.map(q => q.queryTime)),
      totalNetworkRequests: this.metrics.networkRequests.length,
      avgNetworkRequestTime: this.calculateAverage(this.metrics.networkRequests.map(n => n.duration)),
      maxMemoryUsage: Math.max(...this.metrics.memoryUsage.map(m => m.heapUsed)),
      totalRenderTime: this.metrics.renderTimes.reduce((sum, r) => sum + r.renderTime, 0)
    };

    return summary;
  }

  generateRecommendations() {
    const recommendations = [];

    const avgPageLoadTime = this.calculateAverage(this.metrics.pageLoadTimes.map(p => p.loadTime));
    if (avgPageLoadTime > 3000) {
      recommendations.push({
        priority: 'high',
        category: 'Page Load',
        issue: 'Slow page loading',
        recommendation: 'Optimize images, minify CSS/JS, enable compression'
      });
    }

    const avgDbQueryTime = this.calculateAverage(this.metrics.dbQueryTimes.map(q => q.queryTime));
    if (avgDbQueryTime > 100) {
      recommendations.push({
        priority: 'high',
        category: 'Database',
        issue: 'Slow database queries',
        recommendation: 'Add indexes, optimize queries, consider caching'
      });
    }

    const maxMemoryUsage = Math.max(...this.metrics.memoryUsage.map(m => m.heapUsed));
    if (maxMemoryUsage > 500 * 1024 * 1024) { // 500MB
      recommendations.push({
        priority: 'medium',
        category: 'Memory',
        issue: 'High memory usage',
        recommendation: 'Optimize memory usage, consider garbage collection'
      });
    }

    const avgNetworkRequestTime = this.calculateAverage(this.metrics.networkRequests.map(n => n.duration));
    if (avgNetworkRequestTime > 2000) {
      recommendations.push({
        priority: 'medium',
        category: 'Network',
        issue: 'Slow network requests',
        recommendation: 'Use CDN, enable compression, reduce external requests'
      });
    }

    return recommendations;
  }

  generateHtmlReport(report) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>性能报告 - ${TIMESTAMP}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 8px; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 20px 0; }
        .metric { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .recommendation { margin: 20px 0; padding: 15px; border-radius: 8px; }
        .high { background: #fee; border-left: 4px solid #f44; }
        .medium { background: #ffeaa7; border-left: 4px solid #f39c12; }
        .low { background: #e8f5e8; border-left: 4px solid #27ae60; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f5f5f5; }
    </style>
</head>
<body>
    <div class="header">
        <h1>性能报告</h1>
        <p>生成时间: ${TIMESTAMP}</p>
        <p>监控时长: ${report.duration}ms</p>
    </div>

    <div class="summary">
        <div class="metric">
            <h3>页面加载</h3>
            <p>总请求数: ${report.summary.totalPageLoads}</p>
            <p>平均加载时间: ${report.summary.avgPageLoadTime.toFixed(2)}ms</p>
        </div>
        <div class="metric">
            <h3>数据库查询</h3>
            <p>总查询数: ${report.summary.totalDbQueries}</p>
            <p>平均查询时间: ${report.summary.avgDbQueryTime.toFixed(2)}ms</p>
        </div>
        <div class="metric">
            <h3>网络请求</h3>
            <p>总请求数: ${report.summary.totalNetworkRequests}</p>
            <p>平均请求时间: ${report.summary.avgNetworkRequestTime.toFixed(2)}ms</p>
        </div>
        <div class="metric">
            <h3>内存使用</h3>
            <p>最大内存: ${(report.summary.maxMemoryUsage / 1024 / 1024).toFixed(2)}MB</p>
            <p>总渲染时间: ${report.summary.totalRenderTime}ms</p>
        </div>
    </div>

    <div class="recommendations">
        <h2>优化建议</h2>
        ${report.recommendations.map(rec => `
            <div class="recommendation ${rec.priority}">
                <h3>${rec.category} - ${rec.priority.toUpperCase()}</h3>
                <p><strong>问题:</strong> ${rec.issue}</p>
                <p><strong>建议:</strong> ${rec.recommendation}</p>
            </div>
        `).join('')}
    </div>

    <div class="details">
        <h2>详细数据</h2>
        <h3>页面加载时间</h3>
        <table>
            <thead>
                <tr><th>URL</th><th>加载时间(ms)</th><th>时间戳</th></tr>
            </thead>
            <tbody>
                ${report.metrics.pageLoadTimes.map(p => `
                    <tr>
                        <td>${p.url}</td>
                        <td>${p.loadTime}</td>
                        <td>${new Date(p.timestamp).toLocaleString()}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>

        <h3>数据库查询时间</h3>
        <table>
            <thead>
                <tr><th>查询</th><th>查询时间(ms)</th><th>时间戳</th></tr>
            </thead>
            <tbody>
                ${report.metrics.dbQueryTimes.map(q => `
                    <tr>
                        <td>${q.query}</td>
                        <td>${q.queryTime}</td>
                        <td>${new Date(q.timestamp).toLocaleString()}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
</body>
</html>
    `;
  }

  calculateAverage(values) {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }
}

export function createPerformanceMiddleware() {
  const monitor = new PerformanceMonitor();

  return (req, res, next) => {
    const startTime = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      monitor.recordNetworkRequest(req.url, req.method, duration, res.statusCode);
    });

    next();
  };
}

export function createDbQueryMonitor() {
  const monitor = new PerformanceMonitor();

  return (query, startTime) => {
    const queryTime = Date.now() - startTime;
    monitor.recordDbQuery(query, queryTime);
  };
}

export function createPageRenderMonitor() {
  const monitor = new PerformanceMonitor();

  return (component, renderTime) => {
    monitor.recordRenderTime(component, renderTime);
  };
}

export function runPerformanceAnalysis() {
  console.log('开始性能分析...');
  
  const monitor = new PerformanceMonitor();
  
  setTimeout(() => {
    for (let i = 0; i < 10; i++) {
      monitor.recordPageLoadTime(`/page-${i}`, Math.random() * 2000 + 500);
    }
    
    for (let i = 0; i < 20; i++) {
      monitor.recordDbQuery(`SELECT * FROM table_${i}`, Math.random() * 100 + 10);
    }
    
    for (let i = 0; i < 5; i++) {
      monitor.recordMemoryUsage();
    }
    
    const report = monitor.generateReport();
    
    console.log('性能分析完成!');
    console.log(`发现 ${report.recommendations.length} 个优化建议`);
    
    return report;
  }, 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPerformanceAnalysis();
}