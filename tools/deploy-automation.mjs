#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_LOG_DIR = join(ROOT, 'deploy-logs');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');

if (!existsSync(DEPLOY_LOG_DIR)) {
  mkdirSync(DEPLOY_LOG_DIR, { recursive: true });
}

class DeploymentAutomation {
  constructor() {
    this.deploymentId = TIMESTAMP;
    this.logFile = join(DEPLOY_LOG_DIR, `deployment-${TIMESTAMP}.log`);
    this.steps = [];
    this.errors = [];
    this.success = false;
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}`;
    
    console.log(logEntry);
    writeFileSync(this.logFile, logEntry + '\n', { flag: 'a' });
  }

  executeCommand(command, cwd = ROOT, options = {}) {
    this.log(`执行命令: ${command}`);
    
    const result = spawnSync(command.split(' ')[0], command.split(' ').slice(1), {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options
    });

    if (result.status !== 0) {
      const error = `命令执行失败: ${command}\n错误: ${result.stderr.toString()}`;
      this.log(error, 'ERROR');
      this.errors.push(error);
      throw new Error(error);
    }

    const output = result.stdout.toString();
    this.log(`命令执行成功: ${command}\n输出: ${output}`);
    return output;
  }

  async executeStep(name, fn) {
    this.log(`开始执行步骤: ${name}`);
    this.steps.push({ name, startTime: Date.now() });
    
    try {
      await fn();
      const duration = Date.now() - this.steps[this.steps.length - 1].startTime;
      this.log(`步骤执行完成: ${name} (${duration}ms)`);
      return true;
    } catch (error) {
      const duration = Date.now() - this.steps[this.steps.length - 1].startTime;
      this.log(`步骤执行失败: ${name} (${duration}ms) - ${error.message}`, 'ERROR');
      this.errors.push(`${name}: ${error.message}`);
      return false;
    }
  }

  async preCheck() {
    return this.executeStep('预检查', async () => {
      const requiredFiles = [
        'package.json',
        'tsconfig.json',
        'oboext/rosezm.config.js',
        'vercel.json'
      ];

      for (const file of requiredFiles) {
        if (!existsSync(join(ROOT, file))) {
          throw new Error(`缺少必要文件: ${file}`);
        }
      }

      this.log('检查依赖...');
      const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      
      if (!packageJson.dependencies || Object.keys(packageJson.dependencies).length === 0) {
        throw new Error('缺少依赖项');
      }

      this.log('预检查通过');
    });
  }

  async installDependencies() {
    return this.executeStep('安装依赖', async () => {
      this.log('安装npm依赖...');
      this.executeCommand('npm install');
      
      this.log('安装开发依赖...');
      this.executeCommand('npm install --include-dev');
    });
  }

  async buildOptimize() {
    return this.executeStep('构建优化', async () => {
      this.log('开始构建...');
      this.executeCommand('npm run build');
      
      this.log('生成SVG雪碧图...');
      this.executeCommand('node tools/build-svg-sprite.mjs');
      
      this.log('数据库优化...');
      this.executeCommand('node tools/database-optimizer.mjs');
      
      this.log('性能监控...');
      this.executeCommand('node tools/performance-monitor.mjs');
    });
  }

  async deploymentCheck() {
    return this.executeStep('部署检查', async () => {
      this.log('检查构建产物...');
      const requiredDirs = ['dist', 'public'];
      
      for (const dir of requiredDirs) {
        if (!existsSync(join(ROOT, dir))) {
          throw new Error(`构建产物缺失: ${dir}`);
        }
      }

      this.log('检查静态资源...');
      const staticFiles = [
        'public/theme.css',
        'public/pjax.js',
        'public/icons-sprite.svg',
        'public/icons-sprite.css'
      ];

      for (const file of staticFiles) {
        if (!existsSync(join(ROOT, file))) {
          throw new Error(`静态资源缺失: ${file}`);
        }
      }

      this.log('部署检查通过');
    });
  }

  async deployToVercel() {
    return this.executeStep('部署到Vercel', async () => {
      this.log('开始部署到Vercel...');
      
      try {
        this.executeCommand('vercel --version');
      } catch (error) {
        this.log('Vercel CLI未安装，正在安装...', 'WARN');
        this.executeCommand('npm install -g vercel');
      }

      const deployCommand = 'vercel --prod';
      this.executeCommand(deployCommand);
      
      this.log('Vercel部署完成');
    });
  }

  async healthCheck() {
    return this.executeStep('健康检查', async () => {
      this.log('执行健康检查...');
      
      try {
        const result = spawnSync('curl', ['-I', 'https://your-domain.vercel.app'], {
          encoding: 'utf8'
        });
        
        if (result.status !== 200) {
          throw new Error(`首页健康检查失败: ${result.stderr}`);
        }
        
        this.log('首页健康检查通过');
      } catch (error) {
        throw new Error(`健康检查失败: ${error.message}`);
      }

      try {
        const result = spawnSync('curl', ['-I', 'https://your-domain.vercel.app/api/data'], {
          encoding: 'utf8'
        });
        
        if (result.status !== 200) {
          throw new Error(`API健康检查失败: ${result.stderr}`);
        }
        
        this.log('API健康检查通过');
      } catch (error) {
        throw new Error(`API健康检查失败: ${error.message}`);
      }
    });
  }

  generateDeploymentReport() {
    const report = {
      deploymentId: this.deploymentId,
      timestamp: TIMESTAMP,
      steps: this.steps.map(step => ({
        ...step,
        duration: Date.now() - step.startTime,
        success: true
      })),
      errors: this.errors,
      success: this.errors.length === 0,
      summary: {
        totalSteps: this.steps.length,
        successfulSteps: this.steps.length - this.errors.length,
        failedSteps: this.errors.length,
        totalDuration: this.steps.reduce((sum, step) => sum + (Date.now() - step.startTime), 0)
      }
    };

    const reportPath = join(DEPLOY_LOG_DIR, `deployment-report-${TIMESTAMP}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const htmlReport = this.generateHtmlReport(report);
    const htmlPath = join(DEPLOY_LOG_DIR, `deployment-report-${TIMESTAMP}.html`);
    writeFileSync(htmlPath, htmlReport);

    this.log(`部署报告已生成: ${reportPath}`);
    this.log(`HTML报告已生成: ${htmlPath}`);

    return report;
  }

  generateHtmlReport(report) {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>部署报告 - ${TIMESTAMP}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 8px; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .metric { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .steps { margin: 20px 0; }
        .step { margin: 10px 0; padding: 15px; border-radius: 8px; }
        .success { background: #e8f5e8; border-left: 4px solid #27ae60; }
        .failed { background: #fee; border-left: 4px solid #f44; }
        .errors { margin: 20px 0; }
        .error { background: #fee; padding: 10px; border-radius: 4px; margin: 5px 0; }
        .progress-bar { width: 100%; height: 20px; background: #f0f0f0; border-radius: 10px; overflow: hidden; margin: 10px 0; }
        .progress-fill { height: 100%; background: #27ae60; transition: width 0.3s ease; }
    </style>
</head>
<body>
    <div class="header">
        <h1>部署报告</h1>
        <p>部署ID: ${report.deploymentId}</p>
        <p>时间: ${TIMESTAMP}</p>
        <p>状态: ${report.success ? '成功' : '失败'}</p>
    </div>

    <div class="summary">
        <div class="metric">
            <h3>总步骤</h3>
            <p>${report.summary.totalSteps}</p>
        </div>
        <div class="metric">
            <h3>成功步骤</h3>
            <p>${report.summary.successfulSteps}</p>
        </div>
        <div class="metric">
            <h3>失败步骤</h3>
            <p>${report.summary.failedSteps}</p>
        </div>
        <div class="metric">
            <h3>总耗时</h3>
            <p>${(report.summary.totalDuration / 1000).toFixed(2)}秒</p>
        </div>
    </div>

    <div class="progress-bar">
        <div class="progress-fill" style="width: ${(report.summary.successfulSteps / report.summary.totalSteps) * 100}%"></div>
    </div>

    <div class="steps">
        <h2>执行步骤</h2>
        ${report.steps.map(step => `
            <div class="step ${step.success ? 'success' : 'failed'}">
                <h3>${step.name}</h3>
                <p>耗时: ${(step.duration / 1000).toFixed(2)}秒</p>
                <p>状态: ${step.success ? '成功' : '失败'}</p>
            </div>
        `).join('')}
    </div>

    ${report.errors.length > 0 ? `
        <div class="errors">
            <h2>错误信息</h2>
            ${report.errors.map(error => `
                <div class="error">${error}</div>
            `).join('')}
        </div>
    ` : ''}
</body>
</html>
    `;
  }

  async deploy() {
    this.log('开始部署流程...');
    
    try {
      const steps = [
        () => this.preCheck(),
        () => this.installDependencies(),
        () => this.buildOptimize(),
        () => this.deploymentCheck(),
        () => this.deployToVercel(),
        () => this.healthCheck()
      ];

      for (const step of steps) {
        await step();
      }

      this.success = true;
      this.log('部署流程完成!');
      
      const report = this.generateDeploymentReport();
      
      if (report.success) {
        this.log('部署成功!');
      } else {
        this.log('部署失败，请检查错误信息', 'ERROR');
      }
      
      return report;
      
    } catch (error) {
      this.log(`部署失败: ${error.message}`, 'ERROR');
      this.errors.push(`部署失败: ${error.message}`);
      
      await this.rollback();
      
      throw error;
    }
  }

  async rollback() {
    this.log('开始回滚...', 'WARN');
    
    try {
      this.executeCommand('vercel rollback --yes');
      
      this.log('回滚完成');
    } catch (error) {
      this.log(`回滚失败: ${error.message}`, 'ERROR');
    }
  }
}

export async function runDeployment() {
  const deployment = new DeploymentAutomation();
  
  try {
    const report = await deployment.deploy();
    return report;
  } catch (error) {
    console.error('部署失败:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDeployment().then(report => {
    console.log('部署完成');
    process.exit(report.success ? 0 : 1);
  }).catch(error => {
    console.error('部署失败:', error);
    process.exit(1);
  });
}