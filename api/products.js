// api/products.js
// Product Catalog API for Takealot Promo Engine
// Supports listing all 20+ offers, querying by slug/id, and updating prices/status.

'use strict';

const fs = require('fs');
const path = require('path');

const PRODUCTS_FILE = path.join(process.cwd(), 'data', 'products.json');

function loadProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[products-api] Error reading products.json:', err.message);
  }
  return [];
}

function saveProducts(products) {
  try {
    const dir = path.dirname(PRODUCTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[products-api] Error saving products.json:', err.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const products = loadProducts();

  // GET: List all products or retrieve single by slug / id
  if (req.method === 'GET') {
    const slug = (req.query.slug || req.query.p || req.query.id || '').trim().toLowerCase();

    if (slug) {
      const product = products.find(p => 
        (p.slug && p.slug.toLowerCase() === slug) || 
        (p.id && p.id.toLowerCase() === slug) ||
        (p.filename && p.filename.toLowerCase().includes(slug)) ||
        ((slug === 'laundry' || slug === 'toploader' || slug === 'laundry-14kg' || slug === 'washer' || slug.includes('loader') || slug.includes('hisense')) && p.id === 'hisense-14kg-top-loader-washing-machine')
      );

      if (!product) {
        return res.status(404).json({ success: false, error: 'Product not found', slug });
      }

      return res.status(200).json({ success: true, product });
    }

    // Return all products
    return res.status(200).json({
      success: true,
      count: products.length,
      products: products
    });
  }

  // POST / PUT: Update product price or status (admin)
  if (req.method === 'POST' || req.method === 'PUT') {
    const body = req.body || {};
    const { id, slug, price, original_price, active } = body;

    const targetIdx = products.findIndex(p => 
      (id && p.id === id) || 
      (slug && p.slug === slug)
    );

    if (targetIdx === -1) {
      return res.status(404).json({ success: false, error: 'Product not found for update' });
    }

    if (price !== undefined) products[targetIdx].price = Number(price);
    if (original_price !== undefined) products[targetIdx].original_price = Number(original_price);
    if (active !== undefined) products[targetIdx].active = Boolean(active);

    const saved = saveProducts(products);
    if (!saved) {
      return res.status(500).json({ success: false, error: 'Failed to write products catalog' });
    }

    return res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      product: products[targetIdx]
    });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
