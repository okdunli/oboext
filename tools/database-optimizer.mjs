#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_CONFIG_PATH = join(ROOT, 'db-config.json');
const REPORT_DIR = join(ROOT, 'db-reports');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

if (!existsSync(REPORT_DIR)) {
  mkdirSync(REPORT_DIR, { recursive: true });
}

class DatabaseOptimizer {
  constructor() {
    this.config = {
      pglite: {
        maxMemory: 512 * 1024 * 1024, // 512MB
        maxWALSize: 64 * 1024 * 1024, // 64MB
        cacheSize: 32 * 1024 * 1024, // 32MB
        journalMode: 'WAL',
        synchronous: 'NORMAL',
        tempStore: 'MEMORY'
      },
      postgres: {
        pool: {
          min: 2,
          max: 10,
          idleTimeoutMillis: 30000,
          maxLifetime: 600000
        },
        connection: {
          connectTimeout: 10000,
          idleTimeoutMillis: 30000,
          maxLifetime: 600000
        }
      },
      cache: {
        enabled: true,
        ttl: 300, // 5分钟
        maxSize: 1000,
        strategies: {
          'posts': 'TTL',
          'pages': 'TTL',
          'categories': 'LRU',
          'tags': 'LRU',
          'users': 'TTL'
        }
      }
    };
  }

  generateConfig() {
    const configContent = JSON.stringify(this.config, null, 2);
    writeFileSync(DB_CONFIG_PATH, configContent);
    console.log(`数据库配置文件已生成: ${DB_CONFIG_PATH}`);
    return this.config;
  }

  analyzeQueryPerformance(queries) {
    const analysis = {
      totalQueries: queries.length,
      avgQueryTime: 0,
      slowQueries: [],
      fastQueries: [],
      recommendations: []
    };

    const totalQueryTime = queries.reduce((sum, query) => sum + query.time, 0);
    analysis.avgQueryTime = totalQueryTime / queries.length;

    queries.forEach(query => {
      if (query.time > 1000) {
        analysis.slowQueries.push(query);
      } else if (query.time < 100) {
        analysis.fastQueries.push(query);
      }
    });

    if (analysis.slowQueries.length > 0) {
      analysis.recommendations.push({
        priority: 'high',
        type: 'Slow Queries',
        count: analysis.slowQueries.length,
        description: `发现 ${analysis.slowQueries.length} 个慢查询`,
        queries: analysis.slowQueries.map(q => ({
          sql: q.sql,
          time: q.time,
          index: this.suggestIndex(q.sql)
        }))
      });
    }

    return analysis;
  }

  suggestIndex(sql) {
    const suggestions = [];
    
    const whereMatch = sql.match(/WHERE\s+(.*?)\s*(GROUP|ORDER|LIMIT|;|$)/i);
    if (whereMatch) {
      const whereConditions = whereMatch[1].split(/AND|OR/i);
      whereConditions.forEach(condition => {
        const match = condition.match(/(\w+)\s*[=<>]/i);
        if (match) {
          suggestions.push(`CREATE INDEX idx_${match[1]} ON table_name (${match[1]})`);
        }
      });
    }

    const joinMatch = sql.match(/JOIN\s+(\w+)\s+ON\s+(.*?)\s*(WHERE|GROUP|ORDER|LIMIT|;|$)/i);
    if (joinMatch) {
      suggestions.push(`CREATE INDEX idx_${joinMatch[1]}_id ON ${joinMatch[1]} (id)`);
    }

    const orderMatch = sql.match(/ORDER\s+BY\s+(.*?)\s*(LIMIT|;|$)/i);
    if (orderMatch) {
      const orderColumns = orderMatch[1].split(',');
      orderColumns.forEach(column => {
        const cleanColumn = column.trim().split(' ')[0];
        suggestions.push(`CREATE INDEX idx_${cleanColumn} ON table_name (${cleanColumn})`);
      });
    }

    return suggestions;
  }

  generateOptimizationReport() {
    const report = {
      timestamp: TIMESTAMP,
      config: this.config,
      recommendations: this.generateRecommendations(),
      bestPractices: this.getBestPractices()
    };

    const reportPath = join(REPORT_DIR, `db-optimization-${TIMESTAMP}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const htmlReport = this.generateHtmlReport(report);
    const htmlPath = join(REPORT_DIR, `db-optimization-${TIMESTAMP}.html`);
    writeFileSync(htmlPath, htmlReport);

    console.log(`数据库优化报告已生成: ${reportPath}`);
    console.log(`HTML报告已生成: ${htmlPath}`);

    return report;
  }

  generateRecommendations() {
    const recommendations = [];

    recommendations.push({
      priority: 'high',
      category: 'PGlite',
      title: '内存配置优化',
      description: '根据服务器内存调整PGlite配置',
      config: {
        maxMemory: '根据服务器内存调整',
        cacheSize: '增加缓存大小以提高性能',
        journalMode: '使用WAL模式提高性能'
      }
    });

    recommendations.push({
      priority: 'high',
      category: 'PostgreSQL',
      title: '连接池配置',
      description: '优化连接池配置以提高并发性能',
      config: {
        pool: {
          min: '根据并发量调整',
          max: '根据服务器资源调整',
          idleTimeoutMillis: '适当减少空闲超时时间'
        }
      }
    });

    recommendations.push({
      priority: 'medium',
      category: '缓存',
      title: '查询缓存策略',
      description: '实现查询缓存以提高性能',
      config: {
        cache: {
          enabled: '启用查询缓存',
          ttl: '设置合理的缓存过期时间',
          maxSize: '限制缓存大小以避免内存溢出'
        }
      }
    });

    return recommendations;
  }

  getBestPractices() {
    return [
      {
        category: '数据库设计',
        practices: [
          '为常用查询字段创建索引',
          '避免在WHERE子句中使用函数',
          '合理使用JOIN',
          '避免SELECT *，只查询需要的字段',
          '使用分页查询避免大数据集'
        ]
      },
      {
        category: '查询优化',
        practices: [
          '使用EXPLAIN分析查询计划',
          '避免N+1查询问题',
          '使用批量操作减少数据库交互',
          '合理使用事务',
          '定期优化和重建索引'
        ]
      },
      {
        category: '连接管理',
        practices: [
          '使用连接池管理数据库连接',
          '合理设置连接超时时间',
          '避免连接泄漏',
          '监控连接使用情况',
          '根据负载调整连接池大小'
        ]
      },
      {
        category: '性能监控',
        practices: [
          '监控查询执行时间',
          '记录慢查询日志',
          '监控数据库资源使用情况',
          '定期分析性能瓶颈',
          '建立性能基准'
        ]
      }
    ];
  }

  generateHtmlReport(report) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>数据库优化报告 - ${TIMESTAMP}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 8px; }
        .recommendations { margin: 20px 0; }
        .recommendation { margin: 15px 0; padding: 15px; border-radius: 8px; }
        .high { background: #fee; border-left: 4px solid #f44; }
        .medium { background: #ffeaa7; border-left: 4px solid #f39c12; }
        .low { background: #e8f5e8; border-left: 4px solid #27ae60; }
        .best-practices { margin: 20px 0; }
        .practice-category { margin: 20px 0; padding: 15px; background: #f9f9f9; border-radius: 8px; }
        .practice-list { list-style: none; padding: 0; }
        .practice-list li { margin: 10px 0; padding: 10px; background: white; border-radius: 4px; }
        .config-section { margin: 20px 0; }
        .config-code { background: #f4f4f4; padding: 15px; border-radius: 4px; font-family: monospace; }
    </style>
</head>
<body>
    <div class="header">
        <h1>数据库优化报告</h1>
        <p>生成时间: ${TIMESTAMP}</p>
    </div>

    <div class="recommendations">
        <h2>优化建议</h2>
        ${report.recommendations.map(rec => `
            <div class="recommendation ${rec.priority}">
                <h3>${rec.category} - ${rec.title}</h3>
                <p>${rec.description}</p>
                <div class="config-section">
                    <h4>配置建议</h4>
                    <div class="config-code">
                        ${Object.entries(rec.config).map(([key, value]) => 
                            `${key}: ${value}`
                        ).join('<br>')}
                    </div>
                </div>
            </div>
        `).join('')}
    </div>

    <div class="best-practices">
        <h2>最佳实践</h2>
        ${report.bestPractices.map(practice => `
            <div class="practice-category">
                <h3>${practice.category}</h3>
                <ul class="practice-list">
                    ${practice.practices.map(p => `<li>${p}</li>`).join('')}
                </ul>
            </div>
        `).join('')}
    </div>

    <div class="config-section">
        <h2>当前配置</h2>
        <div class="config-code">
            <pre>${JSON.stringify(report.config, null, 2)}</pre>
        </div>
    </div>
</body>
</html>
    `;
  }
}

export function createDbOptimizer() {
  return new DatabaseOptimizer();
}

export function createQueryMonitor() {
  const queries = [];
  
  return {
    startQuery: (sql) => {
      return {
        sql,
        startTime: Date.now(),
        endTime: null
      };
    },
    
    endQuery: (query) => {
      query.endTime = Date.now();
      query.time = query.endTime - query.startTime;
      queries.push(query);
      
      if (query.time > 1000) {
        console.warn(`慢查询检测: ${sql} (${query.time}ms)`);
      }
      
      return query;
    },
    
    getQueries: () => queries,
    
    getSlowQueries: () => queries.filter(q => q.time > 1000),
    
    getAverageQueryTime: () => {
      if (queries.length === 0) return 0;
      const totalTime = queries.reduce((sum, q) => sum + q.time, 0);
      return totalTime / queries.length;
    }
  };
}

export function runDatabaseOptimization() {
  console.log('开始数据库优化分析...');
  
  const optimizer = createDbOptimizer();
  
  const config = optimizer.generateConfig();
  
  const sampleQueries = [
    { sql: 'SELECT * FROM posts WHERE status = "published"', time: 150 },
    { sql: 'SELECT * FROM posts WHERE category_id = 1', time: 2000 },
    { sql: 'SELECT * FROM posts ORDER BY created_at DESC', time: 300 },
    { sql: 'SELECT p.* FROM posts p JOIN categories c ON p.category_id = c.id', time: 1800 },
    { sql: 'SELECT * FROM posts WHERE title LIKE "%keyword%"', time: 2500 }
  ];
  
  const analysis = optimizer.analyzeQueryPerformance(sampleQueries);
  
  const report = optimizer.generateOptimizationReport();
  
  console.log('数据库优化分析完成!');
  console.log(`发现 ${analysis.slowQueries.length} 个慢查询`);
  console.log(`平均查询时间: ${analysis.avgQueryTime.toFixed(2)}ms`);
  
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDatabaseOptimization();
}